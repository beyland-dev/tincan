//! Desktop notifications through `org.freedesktop.Notifications` on the
//! session bus: show one per conversation, and report which conversation the
//! user opened (the default action) or dismissed.
//!
//! The functions take the session-bus connection, so tests can drive a fake
//! server over a peer-to-peer connection.

use std::collections::{HashMap, VecDeque};

use futures_util::StreamExt;
use serde::Serialize;
use zbus::Variant;

use crate::error::{Error, ErrorCode, Result};

pub const NOTIFICATIONS_SERVICE: &str = "org.freedesktop.Notifications";
pub const NOTIFICATIONS_PATH: &str = "/org/freedesktop/Notifications";
pub const NOTIFICATIONS_INTERFACE: &str = "org.freedesktop.Notifications";
/// The action servers run when the notification itself is clicked.
pub const DEFAULT_ACTION: &str = "default";

#[zbus::proxy(
    interface = "org.freedesktop.Notifications",
    default_service = "org.freedesktop.Notifications",
    default_path = "/org/freedesktop/Notifications"
)]
trait Notifications {
    fn get_capabilities(&self) -> zbus::Result<Vec<String>>;

    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: &str,
        replaces_id: u32,
        app_icon: &str,
        summary: &str,
        body: &str,
        actions: &[&str],
        hints: HashMap<&str, Variant<'_>>,
        expire_timeout: i32,
    ) -> zbus::Result<u32>;

    fn close_notification(&self, id: u32) -> zbus::Result<()>;
}

/// Who is notifying: the app name servers show, and the `.desktop` file id
/// (without `.desktop`) they use for the icon and for grouping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sender {
    pub app_name: String,
    pub desktop_entry: Option<String>,
}

impl Default for Sender {
    fn default() -> Self {
        Self {
            app_name: "Tincan".to_owned(),
            desktop_entry: None,
        }
    }
}

/// One notification. `body` is plain text; it is escaped for servers that
/// read markup.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Notification {
    pub summary: String,
    pub body: String,
    /// An icon name or a `file://` URI.
    pub icon: Option<String>,
    /// The id of a notification to update in place; 0 for a new one.
    pub replaces: u32,
    /// Buttons offered after the default action, as `(id, label)`. Servers
    /// without actions show none.
    pub actions: Vec<(String, String)>,
}

/// Escapes the characters the notification markup subset gives meaning to.
pub fn escape_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// What the server can do (`actions`, `body-markup`, `persistence`, …).
/// `NOT_CONNECTED` when no notification server runs.
pub async fn capabilities(connection: &zbus::Connection) -> Result<Vec<String>> {
    Ok(NotificationsProxy::new(connection)
        .await?
        .get_capabilities()
        .await?)
}

/// Shows `notification` and returns its id. The default action (clicking
/// it) and the notification's buttons are offered when the server supports
/// actions, and the body is escaped when it reads markup.
pub async fn notify(
    connection: &zbus::Connection,
    sender: &Sender,
    notification: &Notification,
) -> Result<u32> {
    if notification.summary.is_empty() {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "a notification needs a title",
        ));
    }
    let proxy = NotificationsProxy::new(connection).await?;
    let capabilities = proxy.get_capabilities().await?;
    let has = |name: &str| capabilities.iter().any(|c| c == name);
    let body = if has("body-markup") {
        escape_markup(&notification.body)
    } else {
        notification.body.clone()
    };
    let mut actions: Vec<&str> = Vec::new();
    if has("actions") {
        actions.extend([DEFAULT_ACTION, "Open"]);
        for (id, label) in &notification.actions {
            actions.extend([id.as_str(), label.as_str()]);
        }
    }
    let mut hints = HashMap::new();
    hints.insert("category", Variant::from("im.received"));
    hints.insert("urgency", Variant::U8(1));
    if let Some(entry) = &sender.desktop_entry {
        hints.insert("desktop-entry", Variant::from(entry.as_str()));
    }
    Ok(proxy
        .notify(
            &sender.app_name,
            notification.replaces,
            notification.icon.as_deref().unwrap_or(""),
            &notification.summary,
            &body,
            &actions,
            hints,
            -1,
        )
        .await?)
}

/// Withdraws a notification. Servers ignore ids they no longer show.
pub async fn close(connection: &zbus::Connection, id: u32) -> Result<()> {
    Ok(NotificationsProxy::new(connection)
        .await?
        .close_notification(id)
        .await?)
}

/// Why a notification went away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    Expired,
    Dismissed,
    /// Withdrawn with `close()`.
    Closed,
    Undefined,
}

impl CloseReason {
    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::Expired,
            2 => Self::Dismissed,
            3 => Self::Closed,
            _ => Self::Undefined,
        }
    }
}

/// A signal from the notification server. It broadcasts them for every
/// app's notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationSignal {
    ActionInvoked {
        id: u32,
        action: String,
    },
    Closed {
        id: u32,
        reason: CloseReason,
    },
    /// An XDG activation token for the app to focus its window with; sent
    /// just before `ActionInvoked`.
    ActivationToken {
        id: u32,
        token: String,
    },
}

impl NotificationSignal {
    /// The notification it is about.
    pub fn id(&self) -> u32 {
        match self {
            Self::ActionInvoked { id, .. }
            | Self::Closed { id, .. }
            | Self::ActivationToken { id, .. } => *id,
        }
    }
}

/// Decodes a notification-server signal; `None` for anything else.
pub fn decode_notification_signal(message: &zbus::Message) -> Option<NotificationSignal> {
    let header = message.header();
    if header.interface().map(|i| i.as_str()) != Some(NOTIFICATIONS_INTERFACE) {
        return None;
    }
    let body = message.body();
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (id, action): (u32, String) = body.deserialize().ok()?;
            Some(NotificationSignal::ActionInvoked { id, action })
        }
        "NotificationClosed" => {
            let (id, reason): (u32, u32) = body.deserialize().ok()?;
            Some(NotificationSignal::Closed {
                id,
                reason: CloseReason::from_code(reason),
            })
        }
        "ActivationToken" => {
            let (id, token): (u32, String) = body.deserialize().ok()?;
            Some(NotificationSignal::ActivationToken { id, token })
        }
        _ => None,
    }
}

/// The notification server's signals, in the order they were sent.
pub struct NotificationSignals {
    stream: zbus::MessageStream,
}

impl NotificationSignals {
    /// Subscribes before returning, so nothing sent afterwards is missed.
    pub async fn subscribe(connection: &zbus::Connection) -> Result<Self> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(NOTIFICATIONS_INTERFACE)
            .path(NOTIFICATIONS_PATH)
            .build()?;
        let stream = zbus::MessageStream::for_match_rule(rule, connection, None).await?;
        Ok(Self { stream })
    }

    /// The next signal; `None` once the connection closes.
    pub async fn next(&mut self) -> Option<NotificationSignal> {
        while let Some(message) = self.stream.next().await {
            if let Some(signal) = message.ok().as_ref().and_then(decode_notification_signal) {
                return Some(signal);
            }
        }
        None
    }
}

/// Something the user did with one of Tincan's notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifierEvent {
    /// The user clicked the notification (`action` is `"default"`) or one of
    /// its buttons.
    Action {
        id: u32,
        key: String,
        action: String,
        activation_token: Option<String>,
    },
    Closed {
        id: u32,
        key: String,
        reason: CloseReason,
    },
}

/// Remembers which conversation (`key`) each of Tincan's notifications shows,
/// and turns server signals into events about them. Other apps'
/// notifications are ignored.
#[derive(Debug, Default)]
pub struct NotificationTracker {
    keys: HashMap<u32, String>,
    tokens: HashMap<u32, String>,
    /// Recent signals about ids not tracked (yet): the server can signal
    /// before `notify()` has returned the id.
    early: VecDeque<NotificationSignal>,
}

/// How many notifications the tracker remembers. Servers don't always
/// report a close (e.g. after a restart), so the oldest are forgotten.
pub const MAX_TRACKED: usize = 256;

/// How many signals about untracked ids are kept for [`NotificationTracker::track`].
const MAX_EARLY: usize = 32;

impl NotificationTracker {
    /// Records that notification `id` shows conversation `key`, and returns
    /// the events for any signals about it that arrived first.
    pub fn track(&mut self, id: u32, key: String) -> Vec<NotifierEvent> {
        self.keys.insert(id, key);
        if self.keys.len() > MAX_TRACKED
            && let Some(&oldest) = self.keys.keys().min()
        {
            self.keys.remove(&oldest);
            self.tokens.remove(&oldest);
        }
        let (early, rest) = std::mem::take(&mut self.early)
            .into_iter()
            .partition::<Vec<_>, _>(|signal| signal.id() == id);
        self.early = rest.into();
        early
            .into_iter()
            .filter_map(|signal| self.apply(signal))
            .collect()
    }

    /// The conversation a shown notification belongs to.
    pub fn key(&self, id: u32) -> Option<&str> {
        self.keys.get(&id).map(String::as_str)
    }

    /// How many notifications are shown.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The event `signal` means for a tracked notification; `None` for other
    /// apps' notifications and for activation tokens (they go with the next
    /// action).
    pub fn apply(&mut self, signal: NotificationSignal) -> Option<NotifierEvent> {
        if !self.keys.contains_key(&signal.id()) {
            if self.early.len() == MAX_EARLY {
                self.early.pop_front();
            }
            self.early.push_back(signal);
            return None;
        }
        match signal {
            NotificationSignal::ActivationToken { id, token } => {
                self.tokens.insert(id, token);
                None
            }
            NotificationSignal::ActionInvoked { id, action } => {
                let key = self.keys.get(&id)?.clone();
                Some(NotifierEvent::Action {
                    id,
                    key,
                    action,
                    activation_token: self.tokens.remove(&id),
                })
            }
            NotificationSignal::Closed { id, reason } => {
                self.tokens.remove(&id);
                let key = self.keys.remove(&id)?;
                Some(NotifierEvent::Closed { id, key, reason })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(
            escape_markup("a < b && c > d <b>"),
            "a &lt; b &amp;&amp; c &gt; d &lt;b&gt;"
        );
        assert_eq!(escape_markup("plain 🙂"), "plain 🙂");
    }

    #[test]
    fn close_reasons() {
        assert_eq!(CloseReason::from_code(1), CloseReason::Expired);
        assert_eq!(CloseReason::from_code(2), CloseReason::Dismissed);
        assert_eq!(CloseReason::from_code(3), CloseReason::Closed);
        assert_eq!(CloseReason::from_code(4), CloseReason::Undefined);
        assert_eq!(CloseReason::from_code(99), CloseReason::Undefined);
    }

    #[test]
    fn tracks_only_tincan_notifications() {
        let mut tracker = NotificationTracker::default();
        tracker.track(7, "tel:+15555550142".to_owned());
        assert_eq!(tracker.key(7), Some("tel:+15555550142"));

        // Another app's notification.
        let other = [
            NotificationSignal::ActivationToken {
                id: 8,
                token: "t8".to_owned(),
            },
            NotificationSignal::ActionInvoked {
                id: 8,
                action: DEFAULT_ACTION.to_owned(),
            },
            NotificationSignal::Closed {
                id: 8,
                reason: CloseReason::Dismissed,
            },
        ];
        for signal in other {
            assert_eq!(tracker.apply(signal), None);
        }

        assert_eq!(
            tracker.apply(NotificationSignal::ActivationToken {
                id: 7,
                token: "t7".to_owned()
            }),
            None
        );
        assert_eq!(
            tracker.apply(NotificationSignal::ActionInvoked {
                id: 7,
                action: DEFAULT_ACTION.to_owned()
            }),
            Some(NotifierEvent::Action {
                id: 7,
                key: "tel:+15555550142".to_owned(),
                action: DEFAULT_ACTION.to_owned(),
                activation_token: Some("t7".to_owned()),
            })
        );
        // The token is used once.
        assert_eq!(
            tracker.apply(NotificationSignal::ActionInvoked {
                id: 7,
                action: "Open".to_owned()
            }),
            Some(NotifierEvent::Action {
                id: 7,
                key: "tel:+15555550142".to_owned(),
                action: "Open".to_owned(),
                activation_token: None,
            })
        );
        assert_eq!(
            tracker.apply(NotificationSignal::Closed {
                id: 7,
                reason: CloseReason::Dismissed
            }),
            Some(NotifierEvent::Closed {
                id: 7,
                key: "tel:+15555550142".to_owned(),
                reason: CloseReason::Dismissed,
            })
        );
        assert!(tracker.is_empty());
        assert_eq!(
            tracker.apply(NotificationSignal::Closed {
                id: 7,
                reason: CloseReason::Closed
            }),
            None
        );
    }

    #[test]
    fn replacing_moves_the_notification_to_the_new_key() {
        let mut tracker = NotificationTracker::default();
        tracker.track(3, "tel:+15555550100".to_owned());
        tracker.track(3, "tel:+15555550101".to_owned());
        assert_eq!(tracker.len(), 1);
        assert_eq!(tracker.key(3), Some("tel:+15555550101"));
    }

    #[test]
    fn forgets_the_oldest_beyond_the_limit() {
        let mut tracker = NotificationTracker::default();
        for id in 1..=(MAX_TRACKED as u32 + 1) {
            tracker.track(id, format!("k{id}"));
        }
        assert_eq!(tracker.len(), MAX_TRACKED);
        assert_eq!(tracker.key(1), None);
        assert_eq!(tracker.key(2), Some("k2"));
    }

    #[test]
    fn signals_that_beat_track_are_replayed() {
        let mut tracker = NotificationTracker::default();
        let early = [
            NotificationSignal::ActivationToken {
                id: 5,
                token: "t5".to_owned(),
            },
            NotificationSignal::ActionInvoked {
                id: 5,
                action: DEFAULT_ACTION.to_owned(),
            },
            NotificationSignal::Closed {
                id: 6,
                reason: CloseReason::Expired,
            },
        ];
        for signal in early {
            assert_eq!(tracker.apply(signal), None);
        }
        assert_eq!(
            tracker.track(5, "k5".to_owned()),
            [NotifierEvent::Action {
                id: 5,
                key: "k5".to_owned(),
                action: DEFAULT_ACTION.to_owned(),
                activation_token: Some("t5".to_owned()),
            }]
        );
        // Replayed once only.
        assert_eq!(tracker.track(5, "k5".to_owned()), []);
        assert_eq!(
            tracker.track(6, "k6".to_owned()),
            [NotifierEvent::Closed {
                id: 6,
                key: "k6".to_owned(),
                reason: CloseReason::Expired,
            }]
        );
        assert_eq!(tracker.len(), 1);
    }

    #[test]
    fn keeps_only_the_latest_early_signals() {
        let mut tracker = NotificationTracker::default();
        for id in 0..(MAX_EARLY as u32 + 1) {
            tracker.apply(NotificationSignal::Closed {
                id,
                reason: CloseReason::Expired,
            });
        }
        assert_eq!(tracker.track(0, "k0".to_owned()), []);
        assert_eq!(tracker.track(1, "k1".to_owned()).len(), 1);
    }
}

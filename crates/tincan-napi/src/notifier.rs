//! The `Notifier` class: desktop notifications for new messages over the
//! session bus, and what the user does with them.

use std::sync::{Arc, Mutex, PoisonError};

use napi::bindgen_prelude::PromiseRaw;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use napi_derive::napi;
use tincan_bt::notify::{
    self, CloseReason, Notification, NotificationSignals, NotificationTracker,
    NotifierEvent as TrackedEvent, Sender,
};
use tincan_bt::obex;

use crate::{Failure, spawn_js};

#[napi(object)]
pub struct NotifierOptions {
    /// The app name servers show. Default `Tincan`.
    pub app_name: Option<String>,
    /// The `.desktop` file id (without `.desktop`), for the icon and for
    /// grouping.
    pub desktop_entry: Option<String>,
}

/// A notification to show for a conversation.
#[napi(object)]
pub struct DesktopNotification {
    /// Usually the sender's name. Must not be empty.
    pub title: String,
    /// Plain text (escaped for servers that read markup).
    pub body: String,
    /// Which conversation it shows; events carry it back.
    pub thread_key: String,
    /// An icon name or a `file://` URI.
    pub icon: Option<String>,
    /// The id of a shown notification to update in place.
    pub replaces: Option<u32>,
    /// Buttons after the default action; a click reports an `action` event
    /// with the button's `id`.
    pub actions: Option<Vec<NotificationAction>>,
}

/// A button on a notification.
#[napi(object)]
pub struct NotificationAction {
    /// Reported back as the event's `action`. Must not be `default`.
    pub id: String,
    pub label: String,
}

/// Something the user did with a notification shown by this `Notifier`.
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum NotifierEvent {
    /// It was clicked (`action` is `'default'`) or one of its buttons was.
    /// `activationToken` lets the app raise its window under Wayland.
    Action {
        id: u32,
        thread_key: String,
        action: String,
        activation_token: Option<String>,
    },
    /// It went away: `'closed'` means `dismiss()`.
    Closed {
        id: u32,
        thread_key: String,
        #[napi(ts_type = "'expired' | 'dismissed' | 'closed' | 'undefined'")]
        reason: String,
    },
}

fn reason_str(reason: CloseReason) -> &'static str {
    match reason {
        CloseReason::Expired => "expired",
        CloseReason::Dismissed => "dismissed",
        CloseReason::Closed => "closed",
        CloseReason::Undefined => "undefined",
    }
}

impl From<TrackedEvent> for NotifierEvent {
    fn from(event: TrackedEvent) -> Self {
        match event {
            TrackedEvent::Action {
                id,
                key,
                action,
                activation_token,
            } => Self::Action {
                id,
                thread_key: key,
                action,
                activation_token,
            },
            TrackedEvent::Closed { id, key, reason } => Self::Closed {
                id,
                thread_key: key,
                reason: reason_str(reason).to_owned(),
            },
        }
    }
}

type EventCallback = ThreadsafeFunction<NotifierEvent, (), NotifierEvent, Status, false>;

fn emit(on_event: &EventCallback, events: Vec<TrackedEvent>) {
    for event in events {
        on_event.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct Open {
    on_event: Arc<EventCallback>,
    task: tokio::task::AbortHandle,
}

#[napi]
pub struct Notifier {
    connection: zbus::Connection,
    sender: Sender,
    tracker: Arc<Mutex<NotificationTracker>>,
    open: Mutex<Option<Open>>,
}

impl Notifier {
    fn on_event(&self) -> Option<Arc<EventCallback>> {
        self.open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|open| open.on_event.clone())
    }
}

fn closed() -> Failure {
    Failure::new("NOT_CONNECTED", "The notifier is closed.")
}

#[napi]
impl Notifier {
    /// Connects to the session bus and reports what the user does with the
    /// notifications this notifier shows to `onEvent`. Rejects
    /// `NOT_CONNECTED` when there is no session bus. Keeps Node running
    /// until `close()`.
    #[napi(
        ts_args_type = "onEvent: (event: NotifierEvent) => void, options?: NotifierOptions",
        ts_return_type = "Promise<Notifier>"
    )]
    pub fn open(
        env: &Env,
        on_event: EventCallback,
        options: Option<NotifierOptions>,
    ) -> napi::Result<PromiseRaw<'_, Notifier>> {
        let defaults = Sender::default();
        let sender = match options {
            Some(o) => Sender {
                app_name: o.app_name.unwrap_or(defaults.app_name),
                desktop_entry: o.desktop_entry,
            },
            None => defaults,
        };
        let tracker = Arc::new(Mutex::new(NotificationTracker::default()));
        let on_event = Arc::new(on_event);
        spawn_js(
            env,
            {
                let tracker = tracker.clone();
                let on_event = on_event.clone();
                async move {
                    let connection = obex::session_bus().await?;
                    let mut signals = NotificationSignals::subscribe(&connection).await?;
                    let forward = on_event.clone();
                    let task = crate::spawn_logged("Notifier signals", async move {
                        while let Some(signal) = signals.next().await {
                            let event = tracker
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .apply(signal);
                            emit(&forward, event.into_iter().collect());
                        }
                    });
                    Ok::<_, tincan_bt::Error>((connection, task.abort_handle()))
                }
            },
            move |(connection, task)| Notifier {
                connection,
                sender,
                tracker,
                open: Mutex::new(Some(Open { on_event, task })),
            },
        )
    }

    /// What the notification server supports (`actions`, `body-markup`,
    /// `persistence`, …). `NOT_CONNECTED` when none runs.
    #[napi(ts_return_type = "Promise<Array<string>>")]
    pub fn capabilities<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<PromiseRaw<'env, Vec<String>>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { notify::capabilities(&connection).await },
            |caps| caps,
        )
    }

    /// Shows `notification` and resolves its id. Clicking it (where the
    /// server supports actions) reports an `action` event with its
    /// `threadKey`. `INVALID_INPUT` for an empty title, `NOT_CONNECTED` when
    /// no notification server runs or after `close()`.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn notify<'env>(
        &self,
        env: &'env Env,
        notification: DesktopNotification,
    ) -> napi::Result<PromiseRaw<'env, u32>> {
        let connection = self.connection.clone();
        let sender = self.sender.clone();
        let tracker = self.tracker.clone();
        let on_event = self.on_event();
        spawn_js(
            env,
            async move {
                let on_event = on_event.ok_or_else(closed)?;
                let n = Notification {
                    summary: notification.title,
                    body: notification.body,
                    icon: notification.icon,
                    replaces: notification.replaces.unwrap_or(0),
                    actions: notification
                        .actions
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|a| a.id != notify::DEFAULT_ACTION)
                        .map(|a| (a.id, a.label))
                        .collect(),
                };
                let id = notify::notify(&connection, &sender, &n).await?;
                let early = tracker
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .track(id, notification.thread_key);
                emit(&on_event, early);
                Ok::<_, Failure>(id)
            },
            |id| id,
        )
    }

    /// Withdraws a notification; a `closed` event with reason `'closed'`
    /// follows. Ids no longer shown are ignored.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn dismiss<'env>(&self, env: &'env Env, id: u32) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        let open = self.on_event().is_some();
        spawn_js(
            env,
            async move {
                if !open {
                    return Err(closed());
                }
                notify::close(&connection, id).await?;
                Ok(())
            },
            |()| (),
        )
    }

    /// Stops the events and releases the callback. Shown notifications stay.
    /// Safe to call twice.
    #[napi]
    pub fn close(&self) {
        let open = self
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(open) = open {
            open.task.abort();
        }
    }
}

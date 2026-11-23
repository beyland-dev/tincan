//! `AncsSession`: the iPhone's notification feed (Apple Notification Center
//! Service) over the LE link BlueZ holds.

use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::PromiseRaw;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use napi_derive::napi;
use tincan_bt::ancs::{self, Action, AncsConfig, AncsEvent, AncsState};
use tincan_bt::{Error, ErrorCode, bluez, map};

use crate::{guard, spawn_js};

/// `recent()` without a limit returns this many.
const DEFAULT_RECENT: u32 = 50;

#[napi(object)]
#[derive(Default)]
pub struct AncsOptions {
    /// Fetch title, subtitle and body (default true). Off, notifications
    /// carry only the app, category, flags and time.
    pub content: Option<bool>,
    /// How often to retry subscribing and probe a silent phone (default
    /// 5000).
    pub retry_ms: Option<u32>,
    /// How often to check a working subscription is alive (default 30000).
    pub verify_ms: Option<u32>,
}

fn config_from(address: &str, options: Option<AncsOptions>) -> tincan_bt::Result<AncsConfig> {
    map::validate_address(address)?;
    let options = options.unwrap_or_default();
    let ms = |value: Option<u32>, name: &str| -> tincan_bt::Result<Option<Duration>> {
        match value {
            Some(0) => Err(Error::new(
                ErrorCode::InvalidInput,
                format!("{name} must be positive."),
            )),
            other => Ok(other.map(|v| Duration::from_millis(u64::from(v)))),
        }
    };
    let mut config = AncsConfig::new(address);
    if let Some(content) = options.content {
        config.content = content;
    }
    if let Some(v) = ms(options.retry_ms, "retryMs")? {
        config.retry = v;
    }
    if let Some(v) = ms(options.verify_ms, "verifyMs")? {
        config.verify = v;
    }
    Ok(config)
}

#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum AncsSessionState {
    /// Not subscribed: the phone isn't connected over LE, BlueZ hasn't
    /// resolved its services, or subscribing failed. Retried every `retryMs`.
    Unavailable {
        code: String,
        reason: String,
    },
    /// Subscribed, but the phone hasn't answered yet. It stays here while
    /// the phone's notification sharing is off; `hint` says how to turn it on.
    Waiting {
        hint: String,
    },
    /// The phone answers requests.
    Ready,
    Closed,
}

impl From<AncsState> for AncsSessionState {
    fn from(state: AncsState) -> Self {
        match state {
            AncsState::Unavailable { code, reason } => Self::Unavailable {
                code: code.as_str().to_string(),
                reason,
            },
            AncsState::Waiting { hint } => Self::Waiting { hint },
            AncsState::Ready => Self::Ready,
            AncsState::Closed => Self::Closed,
        }
    }
}

/// A notification on the phone.
#[napi(object)]
pub struct AncsNotification {
    /// The phone's id for it, unique while it stays on the phone.
    pub uid: u32,
    /// The app's bundle id (`com.apple.MobileSMS`).
    pub app_id: String,
    /// The app's display name; derived from the bundle id when the phone
    /// gives none.
    pub app_name: String,
    /// Empty without `content`.
    pub title: String,
    pub subtitle: String,
    pub body: String,
    #[napi(
        ts_type = "'other' | 'incomingCall' | 'missedCall' | 'voicemail' | 'social' | 'schedule' | 'email' | 'news' | 'healthAndFitness' | 'businessAndFinance' | 'location' | 'entertainment'"
    )]
    pub category: String,
    /// Unix seconds: the phone's time for it, read as local time.
    pub received: i64,
    pub silent: bool,
    pub important: bool,
    pub has_positive_action: bool,
    pub has_negative_action: bool,
    /// Already on the phone when the subscription came up.
    pub pre_existing: bool,
}

impl From<ancs::Notification> for AncsNotification {
    fn from(n: ancs::Notification) -> Self {
        Self {
            uid: n.uid,
            app_id: n.app_id,
            app_name: n.app_name,
            title: n.title,
            subtitle: n.subtitle,
            body: n.body,
            category: n.category.as_str().to_string(),
            received: n.received,
            silent: n.silent,
            important: n.important,
            has_positive_action: n.has_positive_action,
            has_negative_action: n.has_negative_action,
            pre_existing: n.pre_existing,
        }
    }
}

#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum AncsSessionEvent {
    State {
        state: AncsSessionState,
    },
    /// Added, or changed on the phone (same `uid`).
    Notification {
        notification: AncsNotification,
    },
    /// Dismissed on the phone.
    Removed {
        uid: u32,
    },
}

impl From<AncsEvent> for AncsSessionEvent {
    fn from(event: AncsEvent) -> Self {
        match event {
            AncsEvent::State(state) => Self::State {
                state: state.into(),
            },
            AncsEvent::Notification(n) => Self::Notification {
                notification: n.into(),
            },
            AncsEvent::Removed { uid } => Self::Removed { uid },
        }
    }
}

fn action_from(name: &str) -> tincan_bt::Result<Action> {
    match name {
        "positive" => Ok(Action::Positive),
        "negative" => Ok(Action::Negative),
        _ => Err(Error::new(
            ErrorCode::InvalidInput,
            "action must be 'positive' or 'negative'.",
        )),
    }
}

/// The phone's notification feed. Subscribes over BlueZ once the phone is
/// connected over LE, resubscribes when the link comes back, and reports
/// every state change and notification to the callback. It never pairs,
/// advertises or connects. Keeps Node running until `close()`.
#[napi]
pub struct AncsSession {
    inner: Arc<ancs::AncsSession>,
}

#[napi]
impl AncsSession {
    /// Starts the client for `address` on the system bus. Rejects
    /// `INVALID_INPUT` for a bad address or option and `NOT_CONNECTED` when
    /// the bus is unavailable. The phone being away is not an error: the
    /// state is `unavailable` until it connects.
    #[napi(ts_return_type = "Promise<AncsSession>")]
    pub fn start<'env>(
        env: &'env Env,
        address: String,
        options: Option<AncsOptions>,
        on_event: ThreadsafeFunction<AncsSessionEvent, (), AncsSessionEvent, Status, false>,
    ) -> napi::Result<PromiseRaw<'env, AncsSession>> {
        let config = config_from(&address, options);
        spawn_js(
            env,
            async move {
                let config = config?;
                let system_bus = bluez::system_bus().await?;
                let (session, mut events) = ancs::AncsSession::start(system_bus, config)?;
                crate::spawn_logged("AncsSession events", async move {
                    while let Some(event) = events.recv().await {
                        on_event.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                });
                Ok::<_, tincan_bt::Error>(session)
            },
            |session| AncsSession {
                inner: Arc::new(session),
            },
        )
    }

    /// The current state (`closed` after `close()`).
    #[napi]
    pub fn state(&self) -> napi::Result<AncsSessionState, String> {
        guard(|| Ok(self.inner.state().into()))
    }

    /// Up to `limit` (default 50) notifications from this subscription,
    /// newest first.
    #[napi(ts_return_type = "Promise<Array<AncsNotification>>")]
    pub fn recent<'env>(
        &self,
        env: &'env Env,
        limit: Option<u32>,
    ) -> napi::Result<PromiseRaw<'env, Vec<AncsNotification>>> {
        let session = Arc::clone(&self.inner);
        spawn_js(
            env,
            async move {
                let limit = limit.unwrap_or(DEFAULT_RECENT) as usize;
                session.recent(limit).await
            },
            |list| list.into_iter().map(AncsNotification::from).collect(),
        )
    }

    /// Runs a notification's positive (answer, …) or negative (decline,
    /// dismiss, …) action on the phone. Rejects `NOT_CONNECTED` until the
    /// phone answers, `NOT_FOUND` for a uid this subscription didn't deliver
    /// and `INVALID_INPUT` when the notification doesn't offer the action.
    #[napi(
        ts_args_type = "uid: number, action: 'positive' | 'negative'",
        ts_return_type = "Promise<void>"
    )]
    pub fn perform_action<'env>(
        &self,
        env: &'env Env,
        uid: u32,
        action: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let session = Arc::clone(&self.inner);
        let action = action_from(&action);
        spawn_js(
            env,
            async move { session.perform_action(uid, action?).await },
            |()| (),
        )
    }

    /// Unsubscribes and stops. The callback gets a final `closed` state and
    /// is then released. Safe to call twice.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let session = Arc::clone(&self.inner);
        spawn_js(
            env,
            async move {
                session.close().await;
                Ok::<_, tincan_bt::Error>(())
            },
            |()| (),
        )
    }
}

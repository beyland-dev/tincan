//! `MapLink`: a supervised MAP connection to one phone.
//!
//! Wraps `tincan_bt::supervisor::MapSupervisor` (reconnect with backoff, pause
//! on sleep or a missing adapter) and `tincan_bt::system::watch_system` (the
//! system-bus triggers). Operations run on whichever session is open and
//! reject `NOT_CONNECTED` between sessions; one that fails because the
//! session vanished reports it to the supervisor, which reconnects.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::PromiseRaw;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use napi_derive::napi;
use tincan_bt::map::{self, ListFilter, MapSession, PushOutcome};
use tincan_bt::supervisor::{
    LinkState, MapSupervisor, PauseReason, SupervisorConfig, SupervisorEvent, Trigger,
};
use tincan_bt::{Error, ErrorCode, bluez, bmessage, obex, system};

use crate::{ParsedBMessage, guard, spawn_js, spawn_logged};

/// Where messages are pushed, relative to `/telecom/msg` (where sessions
/// open).
const OUTBOX: &str = "outbox";

#[napi(object)]
#[derive(Default)]
pub struct MapLinkOptions {
    /// First reconnect delay (default 1000).
    pub backoff_min_ms: Option<u32>,
    /// Longest reconnect delay (default 300000).
    pub backoff_max_ms: Option<u32>,
    /// Limit on opening one session (default 45000).
    pub open_timeout_ms: Option<u32>,
    /// Limit on one download or push (default 60000).
    pub transfer_timeout_ms: Option<u32>,
}

fn config_from(
    address: &str,
    options: Option<MapLinkOptions>,
) -> tincan_bt::Result<SupervisorConfig> {
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
    let mut config = SupervisorConfig::new(address);
    if let Some(v) = ms(options.backoff_min_ms, "backoffMinMs")? {
        config.backoff_min = v;
    }
    if let Some(v) = ms(options.backoff_max_ms, "backoffMaxMs")? {
        config.backoff_max = v;
    }
    if let Some(v) = ms(options.open_timeout_ms, "openTimeoutMs")? {
        config.open_timeout = v;
    }
    config.transfer_timeout = ms(options.transfer_timeout_ms, "transferTimeoutMs")?;
    if config.backoff_min > config.backoff_max {
        return Err(Error::new(
            ErrorCode::InvalidInput,
            "backoffMinMs must not exceed backoffMaxMs.",
        ));
    }
    Ok(config)
}

#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum MapLinkState {
    /// Opening attempt `attempt` (1-based since the last success).
    Connecting {
        attempt: u32,
    },
    /// A session is open at this obexd path, with its events subscribed.
    Connected {
        session: String,
    },
    /// Waiting `delayMs` before attempt `attempt + 1`.
    Waiting {
        attempt: u32,
        delay_ms: f64,
    },
    /// Not trying: the system is asleep or no adapter is powered.
    Paused {
        #[napi(ts_type = "'sleep' | 'adapterDown'")]
        reason: String,
    },
    Stopped,
}

impl From<LinkState> for MapLinkState {
    fn from(state: LinkState) -> Self {
        match state {
            LinkState::Connecting { attempt } => Self::Connecting { attempt },
            LinkState::Connected { session } => Self::Connected { session },
            LinkState::Waiting { attempt, delay } => Self::Waiting {
                attempt,
                delay_ms: delay.as_millis() as f64,
            },
            LinkState::Paused(reason) => Self::Paused {
                reason: match reason {
                    PauseReason::Sleep => "sleep",
                    PauseReason::AdapterDown => "adapterDown",
                }
                .to_string(),
            },
            LinkState::Stopped => Self::Stopped,
        }
    }
}

/// Something obexd reported about the open session's messages. `path` is
/// only valid while that session stays open.
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum MapEvent {
    /// A message object appeared: from a listing, or an MNS new-message
    /// report (then only `folder` and `type` are known).
    MessageAdded {
        handle: String,
        path: String,
        folder: String,
        #[napi(js_name = "type")]
        msg_type: String,
    },
    /// `notification` (new message), `delivery-success`, `sending-success`,
    /// `delivery-failure`, `sending-failure`, or a listing's status.
    StatusChanged {
        handle: String,
        path: String,
        status: String,
    },
    FolderChanged {
        handle: String,
        path: String,
        folder: String,
    },
    ReadChanged {
        handle: String,
        path: String,
        read: bool,
    },
    MessageRemoved {
        handle: String,
        path: String,
    },
    SessionClosed,
}

impl From<map::MapEvent> for MapEvent {
    fn from(event: map::MapEvent) -> Self {
        use map::MapEvent as E;
        match event {
            E::MessageAdded {
                handle,
                path,
                folder,
                msg_type,
            } => Self::MessageAdded {
                handle,
                path,
                folder,
                msg_type,
            },
            E::StatusChanged {
                handle,
                path,
                status,
            } => Self::StatusChanged {
                handle,
                path,
                status,
            },
            E::FolderChanged {
                handle,
                path,
                folder,
            } => Self::FolderChanged {
                handle,
                path,
                folder,
            },
            E::ReadChanged { handle, path, read } => Self::ReadChanged { handle, path, read },
            E::MessageRemoved { handle, path } => Self::MessageRemoved { handle, path },
            E::SessionClosed => Self::SessionClosed,
        }
    }
}

#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum MapLinkEvent {
    State {
        state: MapLinkState,
    },
    /// Opening failed; a `waiting` state follows.
    OpenFailed {
        attempt: u32,
        code: String,
        message: String,
    },
    Map {
        event: MapEvent,
    },
    /// The system-bus watcher stopped, so sleep, resume and adapter changes
    /// are no longer seen. The link keeps retrying on its own schedule.
    SystemWatchFailed {
        code: String,
        message: String,
    },
}

impl From<SupervisorEvent> for MapLinkEvent {
    fn from(event: SupervisorEvent) -> Self {
        match event {
            SupervisorEvent::State(state) => Self::State {
                state: state.into(),
            },
            SupervisorEvent::OpenFailed { attempt, error } => Self::OpenFailed {
                attempt,
                code: error.code().as_str().to_string(),
                message: error.message().to_string(),
            },
            SupervisorEvent::Map(event) => Self::Map {
                event: event.into(),
            },
        }
    }
}

fn trigger_from(name: &str) -> tincan_bt::Result<Trigger> {
    Ok(match name {
        "sleep" => Trigger::Sleep,
        "resume" => Trigger::Resume,
        "adapterDown" => Trigger::AdapterDown,
        "adapterUp" => Trigger::AdapterUp,
        "deviceConnected" => Trigger::DeviceConnected,
        "deviceDisconnected" => Trigger::DeviceDisconnected,
        "reconnect" => Trigger::Reconnect,
        _ => {
            return Err(Error::new(ErrorCode::InvalidInput, "Unknown MAP trigger."));
        }
    })
}

/// `ListMessages` filter. Unset fields are left out of the request.
#[napi(object)]
#[derive(Default)]
pub struct MapListFilter {
    pub offset: Option<u32>,
    pub max_count: Option<u32>,
    pub subject_length: Option<u32>,
    /// `YYYYMMDDTHHMMSS` in the phone's local time.
    pub period_begin: Option<String>,
    pub period_end: Option<String>,
    pub read: Option<bool>,
    /// e.g. `sms`, `email`, `mms`.
    pub types: Option<Vec<String>>,
    /// Extra listing fields to request (`sender-address`, ...).
    pub fields: Option<Vec<String>>,
}

impl TryFrom<MapListFilter> for ListFilter {
    type Error = Error;

    fn try_from(f: MapListFilter) -> tincan_bt::Result<Self> {
        fn narrow<T: TryFrom<u32>>(value: Option<u32>, name: &str) -> tincan_bt::Result<Option<T>> {
            value
                .map(|v| {
                    T::try_from(v).map_err(|_| {
                        Error::new(ErrorCode::InvalidInput, format!("{name} is out of range."))
                    })
                })
                .transpose()
        }
        Ok(ListFilter {
            offset: narrow(f.offset, "offset")?,
            max_count: narrow(f.max_count, "maxCount")?,
            subject_length: narrow(f.subject_length, "subjectLength")?,
            period_begin: f.period_begin,
            period_end: f.period_end,
            read: f.read,
            types: f.types.unwrap_or_default(),
            fields: f.fields.unwrap_or_default(),
        })
    }
}

/// One entry of a MAP listing. Times are Unix seconds.
#[napi(object)]
pub struct MapListing {
    /// The stable message handle.
    pub handle: String,
    /// The obexd object path, for `getMessage`/`setRead` in this session.
    pub path: String,
    pub folder: String,
    pub subject: String,
    pub timestamp: i64,
    pub sender: String,
    pub sender_address: String,
    pub reply_to: String,
    pub recipient: String,
    pub recipient_address: String,
    /// `SMS_GSM` from an iPhone, for SMS and iMessage alike.
    #[napi(js_name = "type")]
    pub msg_type: String,
    pub size: Option<f64>,
    pub attachment_size: Option<f64>,
    pub status: String,
    pub priority: bool,
    pub read: bool,
    pub sent: bool,
    pub protected: bool,
}

impl From<map::MapListing> for MapListing {
    fn from(l: map::MapListing) -> Self {
        Self {
            handle: l.handle,
            path: l.path,
            folder: l.folder,
            subject: l.subject,
            timestamp: l.timestamp,
            sender: l.sender,
            sender_address: l.sender_address,
            reply_to: l.reply_to,
            recipient: l.recipient,
            recipient_address: l.recipient_address,
            msg_type: l.msg_type,
            size: l.size.map(|n| n as f64),
            attachment_size: l.attachment_size.map(|n| n as f64),
            status: l.status,
            priority: l.priority,
            read: l.read,
            sent: l.sent,
            protected: l.protected,
        }
    }
}

fn outcome_name(outcome: PushOutcome) -> String {
    match outcome {
        PushOutcome::Accepted => "accepted",
        PushOutcome::Unconfirmed => "unconfirmed",
        PushOutcome::Pending => "pending",
    }
    .to_string()
}

struct Inner {
    supervisor: Mutex<Option<MapSupervisor>>,
    /// obexd runs one transfer per session at a time; queueing here keeps a
    /// waiting operation's timeout from running while another one transfers.
    ops: tokio::sync::Mutex<()>,
}

impl Inner {
    fn supervisor(&self) -> std::sync::MutexGuard<'_, Option<MapSupervisor>> {
        self.supervisor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn session(&self) -> tincan_bt::Result<Arc<MapSession>> {
        self.supervisor()
            .as_ref()
            .and_then(MapSupervisor::session)
            .ok_or_else(|| Error::new(ErrorCode::NotConnected, "The MAP session is not open."))
    }

    fn trigger(&self, trigger: Trigger) {
        if let Some(supervisor) = self.supervisor().as_ref() {
            supervisor.trigger(trigger);
        }
    }

    /// Runs `op` on the open session, one at a time, and reports a lost
    /// session to the supervisor.
    async fn with_session<T, F, Fut>(&self, op: F) -> tincan_bt::Result<T>
    where
        F: FnOnce(Arc<MapSession>) -> Fut,
        Fut: Future<Output = tincan_bt::Result<T>>,
    {
        let _turn = self.ops.lock().await;
        let session = self.session()?;
        let path = session.session_path().to_string();
        let result = op(session).await;
        if let Err(err) = &result
            && map::is_session_lost(err)
        {
            self.trigger(Trigger::SessionLost(path));
        }
        result
    }
}

/// A supervised MAP connection to one phone. Opens a session, keeps it open
/// across link loss, sleep and adapter changes, and reports every state
/// change and message event to the callback. Keeps Node running until
/// `shutdown()`.
#[napi]
pub struct MapLink {
    inner: Arc<Inner>,
}

#[napi]
impl MapLink {
    /// Starts supervising a MAP connection to `address` over the session bus
    /// (obexd), watching the system bus (BlueZ, logind) for triggers.
    /// **Talks to the phone** as soon as it starts. Rejects `INVALID_INPUT`
    /// for a bad address or option and `NOT_CONNECTED` when a bus is
    /// unavailable. The first event is `{ kind: "state", state: { kind:
    /// "connecting", attempt: 1 } }`.
    #[napi(ts_return_type = "Promise<MapLink>")]
    pub fn start<'env>(
        env: &'env Env,
        address: String,
        options: Option<MapLinkOptions>,
        on_event: ThreadsafeFunction<MapLinkEvent, (), MapLinkEvent, Status, false>,
    ) -> napi::Result<PromiseRaw<'env, MapLink>> {
        let config = config_from(&address, options);
        let on_event = Arc::new(on_event);
        spawn_js(
            env,
            async move {
                let mut config = config?;
                let session_bus = obex::session_bus().await?;
                let system_bus = bluez::system_bus().await?;
                config.bond_check = Some(system_bus.clone());
                let (supervisor, mut events) = MapSupervisor::start(session_bus, config)?;
                let triggers = supervisor.trigger_sender();

                let forward = Arc::clone(&on_event);
                spawn_logged("MapLink events", async move {
                    while let Some(event) = events.recv().await {
                        forward.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                });
                spawn_logged("MapLink system watch", async move {
                    if let Err(err) = system::watch_system(system_bus, &address, triggers).await {
                        on_event.call(
                            MapLinkEvent::SystemWatchFailed {
                                code: err.code().as_str().to_string(),
                                message: err.message().to_string(),
                            },
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                });
                Ok::<_, tincan_bt::Error>(supervisor)
            },
            |supervisor| MapLink {
                inner: Arc::new(Inner {
                    supervisor: Mutex::new(Some(supervisor)),
                    ops: tokio::sync::Mutex::new(()),
                }),
            },
        )
    }

    /// The current state (`stopped` after `shutdown()`).
    #[napi]
    pub fn state(&self) -> napi::Result<MapLinkState, String> {
        guard(|| {
            Ok(self
                .inner
                .supervisor()
                .as_ref()
                .map_or(LinkState::Stopped, MapSupervisor::state)
                .into())
        })
    }

    /// Sends a trigger. The system watcher sends the same ones on its own;
    /// this is for callers with their own signals (`reconnect` when the user
    /// asks). Throws `INVALID_INPUT` for an unknown name; ignored after
    /// `shutdown()`.
    #[napi(
        ts_args_type = "trigger: 'sleep' | 'resume' | 'adapterDown' | 'adapterUp' | 'deviceConnected' | 'deviceDisconnected' | 'reconnect'"
    )]
    pub fn trigger(&self, trigger: String) -> napi::Result<(), String> {
        guard(|| {
            self.inner.trigger(trigger_from(&trigger)?);
            Ok(())
        })
    }

    /// Lists `inbox`, `sent`, `outbox`, ... (newest first). The iPhone only
    /// exposes its 10 newest inbox messages.
    #[napi(ts_return_type = "Promise<Array<MapListing>>")]
    pub fn list_messages<'env>(
        &self,
        env: &'env Env,
        folder: String,
        filter: Option<MapListFilter>,
    ) -> napi::Result<PromiseRaw<'env, Vec<MapListing>>> {
        let inner = Arc::clone(&self.inner);
        let filter = ListFilter::try_from(filter.unwrap_or_default());
        spawn_js(
            env,
            async move {
                let filter = filter?;
                inner
                    .with_session(|s| async move { s.list_messages(&folder, &filter).await })
                    .await
            },
            |listings| listings.into_iter().map(MapListing::from).collect(),
        )
    }

    /// Downloads and parses one message by the `path` of a listing or event
    /// from the open session. Rejects `INVALID_INPUT` for a path from an
    /// earlier session.
    #[napi(ts_return_type = "Promise<ParsedBMessage>")]
    pub fn get_message<'env>(
        &self,
        env: &'env Env,
        path: String,
    ) -> napi::Result<PromiseRaw<'env, ParsedBMessage>> {
        let inner = Arc::clone(&self.inner);
        spawn_js(
            env,
            async move {
                inner
                    .with_session(|s| async move { s.get_message(&path).await })
                    .await
            },
            ParsedBMessage::from,
        )
    }

    /// Marks a message (by `path`) read or unread on the phone.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn set_read<'env>(
        &self,
        env: &'env Env,
        path: String,
        read: bool,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let inner = Arc::clone(&self.inner);
        spawn_js(
            env,
            async move {
                inner
                    .with_session(|s| async move { s.set_read(&path, read).await })
                    .await
            },
            |()| (),
        )
    }

    /// Sends `body` to `recipients` (phone numbers, or Apple ID emails
    /// containing `@`) through the phone. **Sends a real message.** The
    /// phone never reports sending or delivery over MAP: `accepted` means
    /// the transfer completed, `unconfirmed` that it vanished without a
    /// status, `pending` that it was still running at the timeout (the phone
    /// may still send it).
    #[napi(ts_return_type = "Promise<'accepted' | 'unconfirmed' | 'pending'>")]
    pub fn push_message<'env>(
        &self,
        env: &'env Env,
        recipients: Vec<String>,
        body: String,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let inner = Arc::clone(&self.inner);
        let message = recipients
            .iter()
            .map(|r| bmessage::recipient_from_input(r))
            .collect::<tincan_bt::Result<Vec<_>>>()
            .and_then(|recipients| bmessage::build_bmessage(&recipients, &body));
        spawn_js(
            env,
            async move {
                let message = message?;
                inner
                    .with_session(|s| async move { s.push_message(OUTBOX, &message).await })
                    .await
            },
            outcome_name,
        )
    }

    /// Closes the session and stops reconnecting. The callback gets a final
    /// `stopped` state and is then released. Safe to call twice.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn shutdown<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let supervisor = self.inner.supervisor().take();
        spawn_js(
            env,
            async move {
                if let Some(supervisor) = supervisor {
                    supervisor.shutdown().await;
                }
                Ok::<_, tincan_bt::Error>(())
            },
            |()| (),
        )
    }
}

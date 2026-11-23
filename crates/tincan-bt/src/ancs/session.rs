//! The ANCS client: one task that owns the GATT subscription, the request
//! sequencer and the notification registry.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot, watch};
use zbus::{OwnedVariant as OwnedValue, Variant as Value};

use super::parser::Response;
use super::protocol::{self, APP_ID_MESSAGES, Action, RequestKind, SourceEvent, attribute, flag};
use super::registry::{Decision, Notification, NotificationRegistry};
use super::sequencer::{MAX_QUEUED_REQUESTS, Outcome, Sequencer};
use crate::bluez::{self, BLUEZ_SERVICE, DEVICE_INTERFACE, ManagedObjects};
use crate::error::{Error, ErrorCode, Result};
use crate::map::validate_address;
use crate::props;
use crate::redact;
use crate::system::Signals;

const CHARACTERISTIC_INTERFACE: &str = "org.bluez.GattCharacteristic1";
const PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
const OBJECT_MANAGER_INTERFACE: &str = "org.freedesktop.DBus.ObjectManager";

/// Shown while the phone doesn't answer: it only shares notifications with
/// computers it is told to.
pub const PERMISSION_HINT: &str =
    "On the iPhone, turn on Settings > Bluetooth > (i) > Share System Notifications.";

#[derive(Debug, Clone)]
pub struct AncsConfig {
    pub address: String,
    /// Fetch title, subtitle and body. Off, notifications carry only the app,
    /// category, flags and time.
    pub content: bool,
    /// How often to retry subscribing, probe a silent phone and check an
    /// unconfirmed subscription.
    pub retry: Duration,
    /// How often to check a working subscription is still alive.
    pub verify: Duration,
}

impl AncsConfig {
    pub fn new(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            content: true,
            retry: Duration::from_secs(5),
            verify: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AncsState {
    /// Not subscribed: the phone isn't connected over LE, BlueZ hasn't
    /// resolved its services, or subscribing failed. Retried every
    /// [`AncsConfig::retry`].
    Unavailable {
        code: ErrorCode,
        reason: String,
    },
    /// Subscribed, but the phone hasn't answered a request yet. It stays
    /// here while notification sharing is off ([`PERMISSION_HINT`]).
    Waiting {
        hint: String,
    },
    /// The phone answers requests.
    Ready,
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AncsEvent {
    State(AncsState),
    /// Added, or changed on the phone (same uid). Backlog replayed after
    /// subscribing has `pre_existing` set.
    Notification(Notification),
    Removed {
        uid: u32,
    },
}

enum Command {
    Recent {
        limit: usize,
        reply: oneshot::Sender<Vec<Notification>>,
    },
    Act {
        uid: u32,
        action: Action,
        reply: oneshot::Sender<Result<()>>,
    },
    Close,
}

/// A running ANCS client. Dropping it stops the task without unsubscribing;
/// prefer [`AncsSession::close`].
pub struct AncsSession {
    commands: mpsc::UnboundedSender<Command>,
    state: watch::Receiver<AncsState>,
    task: tokio::task::JoinHandle<()>,
}

impl AncsSession {
    /// Starts the client over `connection` (the system bus). Must be called
    /// inside a Tokio runtime. It never connects the LE link itself; until
    /// the phone is connected, it reports `Unavailable` and retries.
    pub fn start(
        connection: zbus::Connection,
        config: AncsConfig,
    ) -> Result<(Self, mpsc::UnboundedReceiver<AncsEvent>)> {
        validate_address(&config.address)?;
        if config.retry.is_zero() || config.verify.is_zero() {
            return Err(Error::new(
                ErrorCode::InvalidInput,
                "ANCS intervals must be positive",
            ));
        }
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events, events_rx) = mpsc::unbounded_channel();
        let initial = AncsState::Unavailable {
            code: ErrorCode::NotConnected,
            reason: "not subscribed yet".into(),
        };
        let (state_tx, state) = watch::channel(initial.clone());
        let worker = Worker {
            connection,
            config,
            events,
            state: state_tx,
            current: initial,
            link: None,
            device_path: None,
            sequencer: Sequencer::default(),
            registry: NotificationRegistry::default(),
            pending: HashMap::new(),
            app_names: HashMap::new(),
            requested_apps: HashSet::new(),
            held: HashMap::new(),
            actions: Vec::new(),
            probing: false,
            next_attempt: Instant::now(),
            next_probe: Instant::now(),
            next_verify: Instant::now(),
        };
        let task = tokio::spawn(worker.run(commands));
        Ok((
            Self {
                commands: commands_tx,
                state,
                task,
            },
            events_rx,
        ))
    }

    pub fn state(&self) -> AncsState {
        self.state.borrow().clone()
    }

    /// Up to `limit` notifications from this session, newest first.
    pub async fn recent(&self, limit: usize) -> Result<Vec<Notification>> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Recent { limit, reply })?;
        rx.await.map_err(|_| closed())
    }

    /// Runs a notification's positive or negative action on the phone.
    /// `NOT_CONNECTED` until the phone answers; `NOT_FOUND` for a uid this
    /// subscription didn't deliver; `INVALID_INPUT` when the notification
    /// doesn't offer the action.
    pub async fn perform_action(&self, uid: u32, action: Action) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.send(Command::Act { uid, action, reply })?;
        rx.await.map_err(|_| closed())?
    }

    /// Unsubscribes and stops; the state becomes `Closed`. Later calls
    /// return at once, and other operations fail.
    pub async fn close(&self) {
        let _ = self.commands.send(Command::Close);
        let mut state = self.state.clone();
        let _ = state.wait_for(|s| *s == AncsState::Closed).await;
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands.send(command).map_err(|_| closed())
    }
}

impl Drop for AncsSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn closed() -> Error {
    Error::new(ErrorCode::NotConnected, "the ANCS session is closed")
}

/// The ANCS characteristics of the subscribed device.
#[derive(Debug, Clone)]
struct Link {
    notification_source: String,
    control_point: String,
    data_source: String,
    /// GAP Device Name, read to check the link is up.
    device_name: Option<String>,
}

struct Worker {
    connection: zbus::Connection,
    config: AncsConfig,
    events: mpsc::UnboundedSender<AncsEvent>,
    state: watch::Sender<AncsState>,
    current: AncsState,
    link: Option<Link>,
    device_path: Option<String>,
    sequencer: Sequencer,
    registry: NotificationRegistry,
    /// Source events whose attributes are being fetched.
    pending: HashMap<u32, SourceEvent>,
    app_names: HashMap<String, String>,
    requested_apps: HashSet<String>,
    /// Notifications waiting for their app's display name.
    held: HashMap<String, Vec<Notification>>,
    actions: Vec<(u32, Action, oneshot::Sender<Result<()>>)>,
    probing: bool,
    next_attempt: Instant,
    next_probe: Instant,
    next_verify: Instant,
}

#[cfg(test)]
thread_local! {
    /// Makes the next `recent` command panic inside the task (tests only).
    static PANIC_ON_COMMAND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Worker {
    /// The task body. A panic inside it ends the session as it would a
    /// close (`Unavailable` with `INTERNAL`, then `Closed`), plus an error
    /// log line, so callers see the feed stop instead of going quiet.
    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        if crate::task::catch_panic("ANCS session", self.serve(&mut commands))
            .await
            .is_none()
        {
            self.set_state(AncsState::Unavailable {
                code: ErrorCode::Internal,
                reason: "the ANCS session stopped after an internal error".into(),
            });
        }
        drop(commands);
        let _ = crate::task::catch_panic("ANCS unsubscribe", self.unsubscribe()).await;
        self.fail_actions(ErrorCode::NotConnected, "the ANCS session is closed");
        self.set_state(AncsState::Closed);
    }

    async fn serve(&mut self, commands: &mut mpsc::UnboundedReceiver<Command>) {
        let subscribed = match rules() {
            Ok(rules) => Signals::subscribe(&self.connection, rules).await,
            Err(err) => Err(err),
        };
        let mut signals = match subscribed {
            Ok(signals) => signals,
            Err(err) => {
                self.set_state(AncsState::Unavailable {
                    code: err.code(),
                    reason: err.message().to_owned(),
                });
                return;
            }
        };
        let mut ticker = tokio::time::interval(self.config.retry.min(Duration::from_secs(1)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => match command {
                    Some(Command::Recent { limit, reply }) => {
                        #[cfg(test)]
                        if PANIC_ON_COMMAND.with(std::cell::Cell::take) {
                            panic!("test panic in the ANCS session");
                        }
                        let _ = reply.send(self.registry.recent(limit));
                    }
                    Some(Command::Act { uid, action, reply }) => self.act(uid, action, reply),
                    Some(Command::Close) | None => break,
                },
                message = signals.next() => match message {
                    Some(message) => self.on_signal(&message),
                    None => {
                        self.lose_link(ErrorCode::NotConnected, "system bus connection closed");
                        break;
                    }
                },
                _ = ticker.tick() => self.on_tick().await,
            }
            self.pump().await;
        }
    }

    fn set_state(&mut self, state: AncsState) {
        if self.current == state {
            return;
        }
        self.current = state.clone();
        self.state.send_replace(state.clone());
        let _ = self.events.send(AncsEvent::State(state));
    }

    fn ready(&self) -> bool {
        self.current == AncsState::Ready
    }

    async fn on_tick(&mut self) {
        let now = Instant::now();
        if let Some(outcome) = self.sequencer.tick(now) {
            self.handle(outcome);
        }
        if self.link.is_none() {
            if now >= self.next_attempt {
                self.subscribe().await;
            }
            return;
        }
        if !self.ready() && !self.probing && now >= self.next_probe {
            self.probe();
        }
        if now >= self.next_verify {
            self.verify().await;
        }
    }

    async fn subscribe(&mut self) {
        match self.try_subscribe().await {
            Ok(link) => {
                tracing::info!(device = %redact::address(&self.config.address), "ANCS subscribed");
                self.link = Some(link);
                self.registry.begin_session();
                let now = Instant::now();
                self.next_probe = now;
                self.next_verify = now + self.config.retry;
                self.set_state(AncsState::Waiting {
                    hint: PERMISSION_HINT.into(),
                });
                self.probe();
            }
            Err(err) => {
                tracing::debug!(code = %err.code(), "ANCS subscribe failed");
                self.next_attempt = Instant::now() + self.config.retry;
                self.set_state(AncsState::Unavailable {
                    code: err.code(),
                    reason: err.message().to_owned(),
                });
            }
        }
    }

    async fn try_subscribe(&mut self) -> Result<Link> {
        let objects = bluez::managed_objects_on(&self.connection).await?;
        bluez::check_bonded(&objects, &self.config.address)?;
        let snapshot = bluez::snapshot_from_objects(&objects);
        let device = crate::device::find_device(&snapshot, &self.config.address)?;
        self.device_path = Some(device.path.clone());
        let link = discover(&objects, &device.path).ok_or_else(|| {
            Error::new(
                ErrorCode::NotFound,
                "the phone offers no ANCS service; is it connected over Bluetooth LE?",
            )
        })?;
        if let Some(name) = &link.device_name {
            read_value(&self.connection, name).await?;
        }
        for path in [&link.data_source, &link.notification_source] {
            match call(&self.connection, path, "StartNotify", &()).await {
                // BlueZ refuses a second StartNotify from the same client.
                Err(err) if err.code() == ErrorCode::Busy => {}
                other => other?,
            }
        }
        Ok(link)
    }

    async fn unsubscribe(&mut self) {
        let Some(link) = self.link.take() else {
            return;
        };
        for path in [&link.notification_source, &link.data_source] {
            if let Err(err) = call(&self.connection, path, "StopNotify", &()).await {
                tracing::debug!(code = %err.code(), "ANCS StopNotify failed");
            }
        }
    }

    /// Asks for the Messages app's name: any answer shows the phone shares
    /// notifications.
    fn probe(&mut self) {
        if self
            .sequencer
            .submit(protocol::app_request(APP_ID_MESSAGES))
        {
            self.probing = true;
        }
        self.next_probe = Instant::now() + self.config.retry;
    }

    async fn verify(&mut self) {
        let Some(link) = self.link.clone() else {
            return;
        };
        let interval = if self.ready() {
            self.config.verify
        } else {
            self.config.retry
        };
        self.next_verify = Instant::now() + interval;
        let result = async {
            for path in [&link.notification_source, &link.data_source] {
                if !notifying(&self.connection, path).await? {
                    return Err(Error::new(
                        ErrorCode::NotConnected,
                        "the ANCS subscription ended",
                    ));
                }
            }
            if let Some(name) = &link.device_name {
                read_value(&self.connection, name).await?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = result {
            self.lose_link(err.code(), err.message());
        }
    }

    /// Forgets the subscription; the next tick resubscribes after the retry
    /// interval.
    fn lose_link(&mut self, code: ErrorCode, reason: &str) {
        if self.link.take().is_some() {
            tracing::info!(device = %redact::address(&self.config.address), code = %code, "ANCS link lost");
        }
        self.sequencer.reset();
        self.pending.clear();
        self.held.clear();
        self.probing = false;
        self.fail_actions(code, reason);
        self.next_attempt = Instant::now() + self.config.retry;
        self.set_state(AncsState::Unavailable {
            code,
            reason: reason.to_owned(),
        });
    }

    fn fail_actions(&mut self, code: ErrorCode, reason: &str) {
        for (_, _, reply) in self.actions.drain(..) {
            let _ = reply.send(Err(Error::new(code, reason)));
        }
    }

    fn on_signal(&mut self, message: &zbus::Message) {
        let header = message.header();
        let (Some(path), Some(interface), Some(member)) =
            (header.path(), header.interface(), header.member())
        else {
            return;
        };
        let path = path.as_str();
        match (interface.as_str(), member.as_str()) {
            (PROPERTIES_INTERFACE, "PropertiesChanged") => {
                let Ok((iface, changed, _)) =
                    message
                        .body()
                        .deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                else {
                    return;
                };
                if iface == CHARACTERISTIC_INTERFACE {
                    self.on_characteristic(path, &changed);
                } else if iface == DEVICE_INTERFACE && self.device_path.as_deref() == Some(path) {
                    let flag = |key: &str| changed.get(key).and_then(|v| bool::try_from(v).ok());
                    if flag("Connected") == Some(false) {
                        self.lose_link(ErrorCode::NotConnected, "the phone disconnected");
                    } else if self.link.is_none()
                        && (flag("Connected") == Some(true)
                            || flag("ServicesResolved") == Some(true))
                    {
                        self.next_attempt = Instant::now();
                    }
                }
            }
            (OBJECT_MANAGER_INTERFACE, "InterfacesAdded") if self.link.is_none() => {
                // A GATT object appearing: the services may be resolved now.
                self.next_attempt = Instant::now();
            }
            (OBJECT_MANAGER_INTERFACE, "InterfacesRemoved") => {
                let Ok((object, _)) = message
                    .body()
                    .deserialize::<(zbus::OwnedObjectPath, Vec<String>)>()
                else {
                    return;
                };
                let gone = self.link.as_ref().is_some_and(|link| {
                    [
                        &link.notification_source,
                        &link.data_source,
                        &link.control_point,
                    ]
                    .iter()
                    .any(|p| p.as_str() == object.as_str())
                });
                if gone {
                    self.lose_link(ErrorCode::NotConnected, "the ANCS service went away");
                }
            }
            _ => {}
        }
    }

    fn on_characteristic(&mut self, path: &str, changed: &HashMap<String, OwnedValue>) {
        let Some(link) = &self.link else {
            return;
        };
        let source = path == link.notification_source;
        let data = path == link.data_source;
        if !source && !data {
            return;
        }
        if changed
            .get("Notifying")
            .and_then(|v| bool::try_from(v).ok())
            == Some(false)
        {
            self.lose_link(ErrorCode::NotConnected, "the ANCS subscription ended");
            return;
        }
        let Some(value) = changed.get("Value").and_then(bytes) else {
            return;
        };
        if source {
            self.on_source(&value);
        } else if let Some(outcome) = self.sequencer.data(&value) {
            self.handle(outcome);
        }
    }

    fn on_source(&mut self, packet: &[u8]) {
        let Some(event) = SourceEvent::parse(packet) else {
            tracing::debug!(bytes = packet.len(), "invalid ANCS source packet");
            return;
        };
        match self.registry.classify(&event) {
            Decision::Ignore => self.registry.remember(event.uid),
            Decision::Withdraw => {
                self.registry.forget(event.uid);
                self.pending.remove(&event.uid);
                for held in self.held.values_mut() {
                    held.retain(|n| n.uid != event.uid);
                }
                let _ = self.events.send(AncsEvent::Removed { uid: event.uid });
            }
            Decision::Fetch => {
                if event.has(flag::PRE_EXISTING)
                    && self.sequencer.queued() >= MAX_QUEUED_REQUESTS / 2
                {
                    return;
                }
                let mut ids = vec![attribute::APP_IDENTIFIER, attribute::DATE];
                if self.config.content {
                    ids.extend([attribute::TITLE, attribute::SUBTITLE, attribute::MESSAGE]);
                }
                if self
                    .sequencer
                    .submit(protocol::notification_request(event.uid, &ids))
                {
                    self.registry.remember(event.uid);
                    self.pending.insert(event.uid, event);
                }
            }
        }
    }

    fn act(&mut self, uid: u32, action: Action, reply: oneshot::Sender<Result<()>>) {
        let result = (|| {
            if !self.ready() {
                return Err(Error::new(
                    ErrorCode::NotConnected,
                    "ANCS isn't ready; the phone isn't sharing notifications",
                ));
            }
            let notification = self
                .registry
                .find(uid)
                .filter(|n| n.session == self.registry.session())
                .ok_or_else(|| {
                    Error::new(ErrorCode::NotFound, "no current notification has this uid")
                })?;
            let offered = match action {
                Action::Positive => notification.has_positive_action,
                Action::Negative => notification.has_negative_action,
            };
            if !offered {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    "the notification doesn't offer this action",
                ));
            }
            if !self.sequencer.submit(protocol::action_request(uid, action)) {
                return Err(Error::new(ErrorCode::Busy, "too many ANCS requests queued"));
            }
            Ok(())
        })();
        match result {
            Ok(()) => self.actions.push((uid, action, reply)),
            Err(err) => {
                let _ = reply.send(Err(err));
            }
        }
    }

    /// Writes queued requests one at a time.
    async fn pump(&mut self) {
        loop {
            let Some(control_point) = self.link.as_ref().map(|l| l.control_point.clone()) else {
                return;
            };
            let Some(request) = self.sequencer.next(Instant::now()) else {
                return;
            };
            let options: HashMap<&str, Value<'_>> = HashMap::new();
            let result = call(
                &self.connection,
                &control_point,
                "WriteValue",
                &(request.payload.as_slice(), options),
            )
            .await;
            let lost = match &result {
                Err(err) if matches!(err.code(), ErrorCode::NotConnected | ErrorCode::NotFound) => {
                    Some(err.clone())
                }
                _ => None,
            };
            if let Some(outcome) = self
                .sequencer
                .written(result.map_err(|e| e.message().to_owned()))
            {
                self.handle(outcome);
            }
            if let Some(err) = lost {
                self.lose_link(err.code(), err.message());
                return;
            }
        }
    }

    fn handle(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Completed(request, response) => {
                self.set_state(AncsState::Ready);
                match request.kind {
                    RequestKind::Notification { uid } => self.on_notification(uid, &response),
                    RequestKind::App { app_id } => {
                        if app_id == APP_ID_MESSAGES {
                            self.probing = false;
                        }
                        let name = response.attribute(attribute::APP_DISPLAY_NAME);
                        self.resolve_app(&app_id, (!name.is_empty()).then_some(name));
                    }
                    RequestKind::Action { uid, action } => self.reply_action(uid, action, Ok(())),
                }
            }
            Outcome::Failed(request, reason) => {
                tracing::debug!(command = request.command(), reason = %reason, "ANCS request failed");
                match request.kind {
                    RequestKind::Notification { uid } => {
                        self.pending.remove(&uid);
                    }
                    RequestKind::App { app_id } => {
                        if app_id == APP_ID_MESSAGES {
                            self.probing = false;
                        }
                        self.resolve_app(&app_id, None);
                    }
                    RequestKind::Action { uid, action } => {
                        self.reply_action(
                            uid,
                            action,
                            Err(Error::new(ErrorCode::Internal, reason)),
                        );
                    }
                }
            }
        }
    }

    fn on_notification(&mut self, uid: u32, response: &Response) {
        let Some(event) = self.pending.remove(&uid) else {
            return;
        };
        if response.uid != uid {
            tracing::debug!("ANCS response for another notification");
            return;
        }
        let app_id = response.attribute(attribute::APP_IDENTIFIER);
        let received =
            match crate::bmessage::parse_map_timestamp(&response.attribute(attribute::DATE)) {
                0 => now_unix(),
                t => t,
            };
        let mut notification = Notification {
            uid,
            app_id: app_id.clone(),
            app_name: String::new(),
            title: response.attribute(attribute::TITLE),
            subtitle: response.attribute(attribute::SUBTITLE),
            body: response.attribute(attribute::MESSAGE),
            category: event.category,
            received,
            silent: event.has(flag::SILENT),
            important: event.has(flag::IMPORTANT),
            has_positive_action: event.has(flag::POSITIVE_ACTION),
            has_negative_action: event.has(flag::NEGATIVE_ACTION),
            pre_existing: event.has(flag::PRE_EXISTING),
            session: self.registry.session(),
        };
        if app_id.is_empty() {
            self.emit(notification);
        } else if let Some(name) = self.app_names.get(&app_id) {
            notification.app_name = name.clone();
            self.emit(notification);
        } else {
            if self.requested_apps.insert(app_id.clone())
                && !self.sequencer.submit(protocol::app_request(&app_id))
            {
                self.requested_apps.remove(&app_id);
                notification.app_name = protocol::derive_app_name(&app_id);
                self.emit(notification);
                return;
            }
            self.held.entry(app_id).or_default().push(notification);
        }
    }

    /// Records an app's name (derived from its id when the phone gave none)
    /// and releases its held notifications.
    fn resolve_app(&mut self, app_id: &str, name: Option<String>) {
        let name = match name {
            Some(name) => {
                self.app_names.insert(app_id.to_owned(), name.clone());
                self.registry.rename_app(app_id, &name);
                name
            }
            None => {
                // Asked again the next time one of its notifications arrives.
                self.requested_apps.remove(app_id);
                protocol::derive_app_name(app_id)
            }
        };
        for mut notification in self.held.remove(app_id).unwrap_or_default() {
            notification.app_name = name.clone();
            self.emit(notification);
        }
    }

    fn emit(&mut self, notification: Notification) {
        self.registry.store(notification.clone());
        let _ = self.events.send(AncsEvent::Notification(notification));
    }

    fn reply_action(&mut self, uid: u32, action: Action, result: Result<()>) {
        if let Some(i) = self
            .actions
            .iter()
            .position(|(u, a, _)| *u == uid && *a == action)
        {
            let (_, _, reply) = self.actions.remove(i);
            let _ = reply.send(result);
        }
    }
}

fn rules() -> Result<Vec<zbus::MatchRule<'static>>> {
    let signal = || zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal);
    let changed = |interface: &'static str| {
        signal()
            .interface(PROPERTIES_INTERFACE)
            .member("PropertiesChanged")
            .path_namespace("/org/bluez")
            .arg(0, interface)
            .build()
    };
    Ok(vec![
        signal()
            .path("/")
            .interface(OBJECT_MANAGER_INTERFACE)
            .build()?,
        changed(CHARACTERISTIC_INTERFACE)?,
        changed(DEVICE_INTERFACE)?,
    ])
}

/// Finds the ANCS characteristics under `device_path`.
fn discover(objects: &ManagedObjects, device_path: &str) -> Option<Link> {
    let prefix = format!("{device_path}/");
    let mut found: HashMap<&str, String> = HashMap::new();
    for (path, interfaces) in objects {
        if !path.starts_with(&prefix) {
            continue;
        }
        let Some(characteristic) = interfaces.get(CHARACTERISTIC_INTERFACE) else {
            continue;
        };
        let Some(uuid) = props::get_str(characteristic, "UUID") else {
            continue;
        };
        for wanted in [
            protocol::NOTIFICATION_SOURCE_UUID,
            protocol::CONTROL_POINT_UUID,
            protocol::DATA_SOURCE_UUID,
            protocol::DEVICE_NAME_UUID,
        ] {
            if uuid.eq_ignore_ascii_case(wanted) {
                found.entry(wanted).or_insert_with(|| path.clone());
            }
        }
    }
    Some(Link {
        notification_source: found.remove(protocol::NOTIFICATION_SOURCE_UUID)?,
        control_point: found.remove(protocol::CONTROL_POINT_UUID)?,
        data_source: found.remove(protocol::DATA_SOURCE_UUID)?,
        device_name: found.remove(protocol::DEVICE_NAME_UUID),
    })
}

async fn call<B>(connection: &zbus::Connection, path: &str, method: &str, body: &B) -> Result<()>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    connection
        .call_method(
            Some(BLUEZ_SERVICE),
            path,
            Some(CHARACTERISTIC_INTERFACE),
            method,
            body,
        )
        .await?;
    Ok(())
}

async fn read_value(connection: &zbus::Connection, path: &str) -> Result<Vec<u8>> {
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let reply = connection
        .call_method(
            Some(BLUEZ_SERVICE),
            path,
            Some(CHARACTERISTIC_INTERFACE),
            "ReadValue",
            &(options,),
        )
        .await?;
    Ok(reply.body().deserialize::<Vec<u8>>()?)
}

async fn notifying(connection: &zbus::Connection, path: &str) -> Result<bool> {
    let reply = connection
        .call_method(
            Some(BLUEZ_SERVICE),
            path,
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(CHARACTERISTIC_INTERFACE, "Notifying"),
        )
        .await?;
    let value = reply.body().deserialize::<OwnedValue>()?;
    Ok(bool::try_from(&value).unwrap_or(false))
}

fn bytes(value: &OwnedValue) -> Option<Vec<u8>> {
    match &**value {
        Value::Array(array) => array
            .iter()
            .map(|v| match v {
                Value::U8(b) => Some(*b),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn characteristic(uuid: &str) -> bluez::Interfaces {
        let mut props = props::Props::new();
        props.insert("UUID".into(), props::PropValue::Str(uuid.into()));
        bluez::Interfaces::from([(CHARACTERISTIC_INTERFACE.to_owned(), props)])
    }

    #[test]
    fn discovers_the_characteristics_under_the_device() {
        let device = "/org/bluez/hci0/dev_AA";
        let mut objects = ManagedObjects::new();
        objects.insert(
            format!("{device}/service0023/char0024"),
            characteristic(&protocol::CONTROL_POINT_UUID.to_uppercase()),
        );
        objects.insert(
            format!("{device}/service0023/char0027"),
            characteristic(protocol::NOTIFICATION_SOURCE_UUID),
        );
        objects.insert(
            format!("{device}/service0023/char002a"),
            characteristic(protocol::DATA_SOURCE_UUID),
        );
        // Another device's characteristics don't count.
        objects.insert(
            "/org/bluez/hci0/dev_AB/service0001/char0002".into(),
            characteristic(protocol::DEVICE_NAME_UUID),
        );
        let link = discover(&objects, device).expect("link");
        assert!(link.control_point.ends_with("char0024"));
        assert!(link.notification_source.ends_with("char0027"));
        assert!(link.data_source.ends_with("char002a"));
        assert_eq!(link.device_name, None);

        objects.remove(&format!("{device}/service0023/char002a"));
        assert!(discover(&objects, device).is_none());
    }

    #[test]
    fn decodes_byte_array_values() {
        let value = OwnedValue::try_from(Value::from(vec![1u8, 2, 3])).expect("value");
        assert_eq!(bytes(&value), Some(vec![1, 2, 3]));
        let value = OwnedValue::try_from(Value::from("text")).expect("value");
        assert_eq!(bytes(&value), None);
    }

    #[tokio::test]
    async fn a_panic_in_the_task_closes_the_session() {
        let (_server, client) = crate::task::p2p_pair().await;
        let (session, mut events) =
            AncsSession::start(client, AncsConfig::new("AA:BB:CC:DD:EE:FF")).expect("start");
        PANIC_ON_COMMAND.with(|p| p.set(true));
        assert_eq!(
            session.recent(1).await.expect_err("panicked").code(),
            ErrorCode::NotConnected
        );
        let states = tokio::time::timeout(Duration::from_secs(5), async {
            let mut states = Vec::new();
            while let Some(event) = events.recv().await {
                if let AncsEvent::State(state) = event {
                    states.push(state);
                }
            }
            states
        })
        .await
        .expect("the task ends");
        assert_eq!(states.last(), Some(&AncsState::Closed));
        assert!(states.iter().any(|s| matches!(
            s,
            AncsState::Unavailable {
                code: ErrorCode::Internal,
                ..
            }
        )));
        assert_eq!(session.state(), AncsState::Closed);
        session.close().await;
    }
}

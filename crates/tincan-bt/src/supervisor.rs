//! Keeps one MAP session to the phone open across link loss, sleep and
//! adapter changes.
//!
//! [`MapSupervisor`] owns the session. It opens it, subscribes to its events
//! **before** reporting [`LinkState::Connected`], forwards the events, and
//! reopens with exponential backoff when the session goes away. Consumers
//! re-list after every `Connected` so nothing reported while the link was down
//! (or between opening and subscribing) is missed.
//!
//! What happens around it arrives as [`Trigger`]s: from
//! [`crate::system::watch_system`] (logind sleep/resume, BlueZ adapter and
//! device changes) and from callers that saw an operation fail with
//! [`crate::map::is_session_lost`].

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, watch};

use crate::error::{Error, ErrorCode, Result};
use crate::map::{MapEvent, MapEvents, MapSession, validate_address};
use crate::redact;

/// Exponential backoff: `min`, doubling up to `max`.
#[derive(Debug, Clone)]
pub struct Backoff {
    min: Duration,
    max: Duration,
    current: Option<Duration>,
}

impl Backoff {
    pub fn new(min: Duration, max: Duration) -> Self {
        Self {
            min,
            max: max.max(min),
            current: None,
        }
    }

    /// The next delay.
    pub fn next_delay(&mut self) -> Duration {
        let next = match self.current {
            None => self.min,
            Some(current) => current.saturating_mul(2).min(self.max),
        };
        self.current = Some(next);
        next
    }

    pub fn reset(&mut self) {
        self.current = None;
    }
}

/// Something that changes whether or when the session should be open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// logind `PrepareForSleep(true)`: close the session and stop retrying.
    Sleep,
    /// logind `PrepareForSleep(false)`: reconnect now.
    Resume,
    /// No powered adapter is left: close the session and stop retrying.
    AdapterDown,
    /// A powered adapter is back: reconnect now.
    AdapterUp,
    /// The phone's ACL link came up: reconnect now if waiting.
    DeviceConnected,
    /// The phone's ACL link went down. obexd removes the session on its own,
    /// which the supervisor sees, so this is informational.
    DeviceDisconnected,
    /// An operation on this session (by path) failed with
    /// [`crate::map::is_session_lost`]. Ignored when it names an older
    /// session.
    SessionLost(String),
    /// Reconnect now: a user asked, or the caller has another reason. Clears
    /// a missed resume, not a missing adapter.
    Reconnect,
}

/// Why the supervisor isn't trying to connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    Sleep,
    AdapterDown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// Opening attempt `attempt` (1-based since the last success).
    Connecting {
        attempt: u32,
    },
    /// The session at this obexd path is open and its events subscribed.
    Connected {
        session: String,
    },
    /// Waiting `delay` before attempt `attempt + 1`.
    Waiting {
        attempt: u32,
        delay: Duration,
    },
    Paused(PauseReason),
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorEvent {
    State(LinkState),
    /// Opening failed; a `Waiting` state follows.
    OpenFailed {
        attempt: u32,
        error: Error,
    },
    /// A message event from the open session.
    Map(MapEvent),
}

#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub address: String,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// Limit on one `CreateSession` + `SetFolder`.
    pub open_timeout: Duration,
    /// Overrides [`MapSession`]'s transfer timeout.
    pub transfer_timeout: Option<Duration>,
    /// The system bus: when set, every open first checks that BlueZ has the
    /// phone paired and bonded ([`crate::bluez::require_bonded`]), and an
    /// open fails with `PERMISSION_DENIED` otherwise. `None` skips the check
    /// (tests against a fake obexd).
    pub bond_check: Option<zbus::Connection>,
}

impl SupervisorConfig {
    pub fn new(address: impl Into<String>) -> Self {
        Self {
            address: address.into(),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(300),
            open_timeout: Duration::from_secs(45),
            transfer_timeout: None,
            bond_check: None,
        }
    }
}

enum Command {
    Trigger(Trigger),
    Shutdown,
}

/// Sends [`Trigger`]s to a running supervisor.
#[derive(Clone)]
pub struct TriggerSender(mpsc::UnboundedSender<Command>);

impl TriggerSender {
    /// `false` once the supervisor has stopped.
    pub fn send(&self, trigger: Trigger) -> bool {
        self.0.send(Command::Trigger(trigger)).is_ok()
    }

    pub fn is_closed(&self) -> bool {
        self.0.is_closed()
    }

    /// Resolves once the supervisor has stopped.
    pub async fn closed(&self) {
        self.0.closed().await;
    }
}

/// A running supervisor. Dropping it without [`MapSupervisor::shutdown`]
/// stops the task too, but without waiting for the session to close.
pub struct MapSupervisor {
    commands: mpsc::UnboundedSender<Command>,
    session: watch::Receiver<Option<Arc<MapSession>>>,
    state: watch::Receiver<LinkState>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl MapSupervisor {
    /// Starts supervising a MAP session to `config.address` over `connection`
    /// (the session bus, where obexd runs). Must be called inside a Tokio
    /// runtime. Events arrive on the returned receiver, starting with
    /// `State(Connecting { attempt: 1 })`.
    pub fn start(
        connection: zbus::Connection,
        config: SupervisorConfig,
    ) -> Result<(Self, mpsc::UnboundedReceiver<SupervisorEvent>)> {
        validate_address(&config.address)?;
        let (commands_tx, commands) = mpsc::unbounded_channel();
        let (events, events_rx) = mpsc::unbounded_channel();
        let (session_tx, session) = watch::channel(None);
        let (state_tx, state) = watch::channel(LinkState::Stopped);
        let runner = Runner {
            backoff: Backoff::new(config.backoff_min, config.backoff_max),
            connection,
            config,
            commands,
            events,
            session: session_tx,
            state: state_tx,
            attempt: 0,
            asleep: false,
            adapter_down: false,
        };
        let task = tokio::spawn(runner.run());
        Ok((
            Self {
                commands: commands_tx,
                session,
                state,
                task: Some(task),
            },
            events_rx,
        ))
    }

    /// The open session, if any. It may close at any moment; report a
    /// lost-session error with [`Trigger::SessionLost`].
    pub fn session(&self) -> Option<Arc<MapSession>> {
        self.session.borrow().clone()
    }

    pub fn state(&self) -> LinkState {
        self.state.borrow().clone()
    }

    pub fn trigger(&self, trigger: Trigger) -> bool {
        self.commands.send(Command::Trigger(trigger)).is_ok()
    }

    pub fn trigger_sender(&self) -> TriggerSender {
        TriggerSender(self.commands.clone())
    }

    /// Closes the session and stops.
    pub async fn shutdown(mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for MapSupervisor {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

enum SessionEnd {
    Lost,
    Paused,
    Shutdown,
}

struct Runner {
    connection: zbus::Connection,
    config: SupervisorConfig,
    commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<SupervisorEvent>,
    session: watch::Sender<Option<Arc<MapSession>>>,
    state: watch::Sender<LinkState>,
    backoff: Backoff,
    attempt: u32,
    asleep: bool,
    adapter_down: bool,
}

#[cfg(test)]
thread_local! {
    /// Makes the next trigger panic inside the task (tests only).
    static PANIC_ON_TRIGGER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Runner {
    /// The task body. A panic inside it ends the task as `Stopped` (closing
    /// any open session), as a shutdown would, plus an error log line.
    async fn run(mut self) {
        if crate::task::catch_panic("MAP supervisor", self.supervise())
            .await
            .is_none()
        {
            let session = self.session.send_replace(None);
            if let Some(session) = session {
                let _ = crate::task::catch_panic("MAP session close", session.close()).await;
            }
        }
        self.set_state(LinkState::Stopped);
    }

    async fn supervise(&mut self) {
        loop {
            if let Some(reason) = self.pause_reason() {
                self.set_state(LinkState::Paused(reason));
                match self.commands.recv().await {
                    None | Some(Command::Shutdown) => break,
                    Some(Command::Trigger(trigger)) => {
                        self.note(&trigger);
                    }
                }
                continue;
            }
            self.attempt += 1;
            self.set_state(LinkState::Connecting {
                attempt: self.attempt,
            });
            match self.open().await {
                Ok((session, events)) => {
                    tracing::info!(attempt = self.attempt, device = %redact::address(&self.config.address), "MAP session open");
                    self.attempt = 0;
                    self.backoff.reset();
                    let session = Arc::new(session);
                    self.session.send_replace(Some(session.clone()));
                    self.set_state(LinkState::Connected {
                        session: session.session_path().to_owned(),
                    });
                    let end = self.connected(&session, events).await;
                    self.session.send_replace(None);
                    if let Err(err) = session.close().await {
                        tracing::debug!(code = %err.code(), "closing the MAP session failed");
                    }
                    match end {
                        SessionEnd::Shutdown => break,
                        SessionEnd::Paused => {}
                        SessionEnd::Lost => {
                            tracing::info!(device = %redact::address(&self.config.address), "MAP session lost");
                            if !self.wait_retry().await {
                                break;
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::info!(attempt = self.attempt, code = %error.code(), device = %redact::address(&self.config.address), "opening the MAP session failed");
                    self.emit(SupervisorEvent::OpenFailed {
                        attempt: self.attempt,
                        error,
                    });
                    if !self.wait_retry().await {
                        break;
                    }
                }
            }
        }
    }

    fn pause_reason(&self) -> Option<PauseReason> {
        if self.adapter_down {
            Some(PauseReason::AdapterDown)
        } else if self.asleep {
            Some(PauseReason::Sleep)
        } else {
            None
        }
    }

    /// Updates the flags for `trigger`. Returns whether it asks to connect now.
    fn note(&mut self, trigger: &Trigger) -> bool {
        #[cfg(test)]
        if PANIC_ON_TRIGGER.with(std::cell::Cell::take) {
            panic!("test panic in the supervisor");
        }
        match trigger {
            Trigger::Sleep => self.asleep = true,
            Trigger::AdapterDown => self.adapter_down = true,
            Trigger::Resume | Trigger::Reconnect => self.asleep = false,
            Trigger::AdapterUp => self.adapter_down = false,
            Trigger::DeviceConnected => {}
            Trigger::DeviceDisconnected | Trigger::SessionLost(_) => return false,
        }
        let now = matches!(
            trigger,
            Trigger::Resume | Trigger::Reconnect | Trigger::AdapterUp | Trigger::DeviceConnected
        );
        if now {
            self.attempt = 0;
            self.backoff.reset();
        }
        now
    }

    async fn open(&self) -> Result<(MapSession, MapEvents)> {
        let open = async {
            if let Some(system) = &self.config.bond_check {
                crate::bluez::require_bonded(system, &self.config.address).await?;
            }
            let mut session =
                MapSession::open_on(self.connection.clone(), &self.config.address).await?;
            if let Some(timeout) = self.config.transfer_timeout {
                session.set_transfer_timeout(timeout);
            }
            match session.events().await {
                Ok(events) => Ok((session, events)),
                Err(err) => {
                    let _ = session.close().await;
                    Err(err)
                }
            }
        };
        tokio::time::timeout(self.config.open_timeout, open)
            .await
            .unwrap_or_else(|_| {
                Err(Error::new(
                    ErrorCode::Timeout,
                    "Opening the MAP session timed out.",
                ))
            })
    }

    async fn connected(&mut self, session: &MapSession, mut events: MapEvents) -> SessionEnd {
        loop {
            tokio::select! {
                biased;
                command = self.commands.recv() => match command {
                    None | Some(Command::Shutdown) => return SessionEnd::Shutdown,
                    Some(Command::Trigger(Trigger::SessionLost(path))) => {
                        if path == session.session_path() {
                            return SessionEnd::Lost;
                        }
                    }
                    Some(Command::Trigger(trigger)) => {
                        self.note(&trigger);
                        if self.pause_reason().is_some() {
                            return SessionEnd::Paused;
                        }
                    }
                },
                event = events.next() => match event {
                    None | Some(MapEvent::SessionClosed) => return SessionEnd::Lost,
                    Some(event) => self.emit(SupervisorEvent::Map(event)),
                },
            }
        }
    }

    /// Waits out the next backoff delay, or less if a trigger asks to connect
    /// now or pauses. `false` on shutdown.
    async fn wait_retry(&mut self) -> bool {
        let delay = self.backoff.next_delay();
        self.set_state(LinkState::Waiting {
            attempt: self.attempt,
            delay,
        });
        let deadline = tokio::time::Instant::now() + delay;
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return true,
                command = self.commands.recv() => match command {
                    None | Some(Command::Shutdown) => return false,
                    Some(Command::Trigger(trigger)) => {
                        if self.note(&trigger) || self.pause_reason().is_some() {
                            return true;
                        }
                    }
                },
            }
        }
    }

    fn set_state(&self, state: LinkState) {
        if *self.state.borrow() == state {
            return;
        }
        self.state.send_replace(state.clone());
        self.emit(SupervisorEvent::State(state));
    }

    fn emit(&self, event: SupervisorEvent) {
        let _ = self.events.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_cap_and_resets() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(5));
        let delays: Vec<u64> = (0..5).map(|_| backoff.next_delay().as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 5, 5]);
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_secs(1));
    }

    #[test]
    fn backoff_cap_is_at_least_the_minimum() {
        let mut backoff = Backoff::new(Duration::from_secs(3), Duration::from_secs(1));
        assert_eq!(backoff.next_delay(), Duration::from_secs(3));
        assert_eq!(backoff.next_delay(), Duration::from_secs(3));
    }

    #[tokio::test]
    async fn a_panic_in_the_task_ends_as_stopped() {
        let (_server, client) = crate::task::p2p_pair().await;
        let config = SupervisorConfig {
            backoff_min: Duration::from_secs(60),
            backoff_max: Duration::from_secs(60),
            // Nothing answers on the peer, so the open times out.
            open_timeout: Duration::from_millis(50),
            ..SupervisorConfig::new("AA:BB:CC:DD:EE:FF")
        };
        let (supervisor, mut events) = MapSupervisor::start(client, config).expect("start");
        // Wait until it is backing off after the failed open (no obexd).
        loop {
            match events.recv().await.expect("event") {
                SupervisorEvent::State(LinkState::Waiting { .. }) => break,
                _ => continue,
            }
        }
        PANIC_ON_TRIGGER.with(|p| p.set(true));
        assert!(supervisor.trigger(Trigger::DeviceConnected));
        let last = tokio::time::timeout(Duration::from_secs(5), async {
            let mut last = None;
            while let Some(event) = events.recv().await {
                last = Some(event);
            }
            last
        })
        .await
        .expect("the task ends");
        assert!(matches!(
            last,
            Some(SupervisorEvent::State(LinkState::Stopped))
        ));
        assert_eq!(supervisor.state(), LinkState::Stopped);
        assert!(supervisor.trigger_sender().is_closed());
    }
}

//! `MapSupervisor` and `watch_system` against a fake obexd and a fake system
//! bus, both peer-to-peer. Nothing here touches a real bus, obexd or a phone.

mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use support::{ADDRESS, FakeMessage, FakeObexd, SESSION_PATH, State};
use tincan_bt::ErrorCode;
use tincan_bt::map::MapEvent;
use tincan_bt::supervisor::{
    LinkState, MapSupervisor, PauseReason, SupervisorConfig, SupervisorEvent, Trigger,
};
use tincan_bt::system::watch_system;
use tokio::sync::mpsc::UnboundedReceiver;
use zbus::{Connection, OwnedObjectPath, OwnedVariant, Variant};

type Events = UnboundedReceiver<SupervisorEvent>;

fn config() -> SupervisorConfig {
    SupervisorConfig {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        open_timeout: Duration::from_secs(5),
        ..SupervisorConfig::new(ADDRESS)
    }
}

async fn start(state: State, config: SupervisorConfig) -> (FakeObexd, MapSupervisor, Events) {
    let (fake, connection) = FakeObexd::start(state).await;
    let (supervisor, events) = MapSupervisor::start(connection, config).expect("start");
    (fake, supervisor, events)
}

async fn next(events: &mut Events) -> SupervisorEvent {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("event in time")
        .expect("supervisor running")
}

/// Events up to and including the first that matches `stop`.
async fn until(
    events: &mut Events,
    stop: impl Fn(&SupervisorEvent) -> bool,
) -> Vec<SupervisorEvent> {
    let mut seen = Vec::new();
    loop {
        let event = next(events).await;
        let done = stop(&event);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

fn is_connected(event: &SupervisorEvent) -> bool {
    matches!(event, SupervisorEvent::State(LinkState::Connected { .. }))
}

fn is_state(state: LinkState) -> impl Fn(&SupervisorEvent) -> bool {
    move |event| *event == SupervisorEvent::State(state.clone())
}

/// Nothing arrives for a while.
async fn quiet(events: &mut Events) {
    let got = tokio::time::timeout(Duration::from_millis(150), events.recv()).await;
    assert!(got.is_err(), "unexpected event: {got:?}");
}

#[tokio::test]
async fn connects_forwards_events_and_reopens_after_link_loss() {
    let (fake, supervisor, mut events) = start(State::default(), config()).await;
    assert_eq!(
        until(&mut events, is_connected).await,
        [
            SupervisorEvent::State(LinkState::Connecting { attempt: 1 }),
            SupervisorEvent::State(LinkState::Connected {
                session: SESSION_PATH.to_owned()
            }),
        ]
    );
    let session = supervisor.session().expect("session");
    assert_eq!(session.session_path(), SESSION_PATH);

    let message = FakeMessage::inbox("2000", "20261031T120000", "synthetic");
    fake.deliver(message.clone()).await;
    let other = next(&mut events).await;
    let SupervisorEvent::Map(MapEvent::MessageAdded { handle, .. }) = other.clone() else {
        panic!("expected MessageAdded, got {other:?}");
    };
    assert_eq!(handle, message.handle);
    assert!(matches!(
        next(&mut events).await,
        SupervisorEvent::Map(MapEvent::StatusChanged { .. })
    ));

    fake.drop_link().await;
    let seen = until(&mut events, is_connected).await;
    assert!(
        seen.contains(&SupervisorEvent::State(LinkState::Waiting {
            attempt: 0,
            delay: Duration::from_millis(20),
        })),
        "{seen:?}"
    );
    assert_eq!(fake.with(|s| s.creates), 2);
    // The old handle is closed; the new one is a different object.
    assert!(session.is_closed());
    assert!(!supervisor.session().expect("session").is_closed());
    supervisor.shutdown().await;
}

#[tokio::test]
async fn retries_transient_open_failures_with_backoff() {
    let state = State {
        fail_creates: 2,
        ..State::default()
    };
    let (fake, supervisor, mut events) = start(state, config()).await;
    let seen = until(&mut events, is_connected).await;
    let failed = |attempt| SupervisorEvent::OpenFailed {
        attempt,
        error: tincan_bt::Error::new(ErrorCode::Internal, String::new()),
    };
    let codes: Vec<_> = seen
        .iter()
        .map(|event| match event {
            SupervisorEvent::OpenFailed { attempt, error } => {
                assert_eq!(error.code(), ErrorCode::Internal);
                failed(*attempt)
            }
            other => other.clone(),
        })
        .collect();
    let wait = |attempt, ms| {
        SupervisorEvent::State(LinkState::Waiting {
            attempt,
            delay: Duration::from_millis(ms),
        })
    };
    let connecting = |attempt| SupervisorEvent::State(LinkState::Connecting { attempt });
    assert_eq!(
        codes,
        [
            connecting(1),
            failed(1),
            wait(1, 20),
            connecting(2),
            failed(2),
            wait(2, 40),
            connecting(3),
            SupervisorEvent::State(LinkState::Connected {
                session: SESSION_PATH.to_owned()
            }),
        ]
    );
    assert_eq!(fake.with(|s| s.creates), 3);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn sleep_closes_the_session_until_resume() {
    let (fake, supervisor, mut events) = start(State::default(), config()).await;
    until(&mut events, is_connected).await;

    assert!(supervisor.trigger(Trigger::Sleep));
    assert_eq!(
        next(&mut events).await,
        SupervisorEvent::State(LinkState::Paused(PauseReason::Sleep))
    );
    assert!(supervisor.session().is_none());
    assert!(!fake.with(|s| s.session_open));
    // A phone that reconnects while the laptop sleeps doesn't wake it.
    supervisor.trigger(Trigger::DeviceConnected);
    quiet(&mut events).await;
    assert_eq!(fake.with(|s| s.creates), 1);

    supervisor.trigger(Trigger::Resume);
    until(&mut events, is_connected).await;
    assert_eq!(fake.with(|s| s.creates), 2);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_missing_adapter_outranks_resume() {
    let (_fake, supervisor, mut events) = start(State::default(), config()).await;
    until(&mut events, is_connected).await;

    supervisor.trigger(Trigger::Sleep);
    supervisor.trigger(Trigger::AdapterDown);
    until(&mut events, is_state(LinkState::Paused(PauseReason::Sleep))).await;
    assert_eq!(
        next(&mut events).await,
        SupervisorEvent::State(LinkState::Paused(PauseReason::AdapterDown))
    );
    supervisor.trigger(Trigger::Resume);
    supervisor.trigger(Trigger::Reconnect);
    quiet(&mut events).await;
    assert_eq!(
        supervisor.state(),
        LinkState::Paused(PauseReason::AdapterDown)
    );

    supervisor.trigger(Trigger::AdapterUp);
    until(&mut events, is_connected).await;
    supervisor.shutdown().await;
}

#[tokio::test]
async fn the_phone_coming_back_cuts_the_backoff_short() {
    let state = State {
        fail_creates: 1,
        ..State::default()
    };
    let config = SupervisorConfig {
        backoff_min: Duration::from_secs(60),
        backoff_max: Duration::from_secs(60),
        ..config()
    };
    let (_fake, supervisor, mut events) = start(state, config).await;
    until(&mut events, |e| {
        matches!(e, SupervisorEvent::State(LinkState::Waiting { .. }))
    })
    .await;
    // Not this phone's link: informational only.
    supervisor.trigger(Trigger::DeviceDisconnected);
    quiet(&mut events).await;

    supervisor.trigger(Trigger::DeviceConnected);
    assert_eq!(
        until(&mut events, is_connected).await[0],
        SupervisorEvent::State(LinkState::Connecting { attempt: 1 })
    );
    supervisor.shutdown().await;
}

#[tokio::test]
async fn session_lost_reports_only_reopen_the_current_session() {
    let (fake, supervisor, mut events) = start(State::default(), config()).await;
    until(&mut events, is_connected).await;

    supervisor.trigger(Trigger::SessionLost(
        "/org/bluez/obex/client/session0".to_owned(),
    ));
    supervisor.trigger(Trigger::Reconnect);
    quiet(&mut events).await;
    assert_eq!(fake.with(|s| s.creates), 1);

    supervisor.trigger(Trigger::SessionLost(SESSION_PATH.to_owned()));
    until(&mut events, is_connected).await;
    assert_eq!(fake.with(|s| s.creates), 2);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn shutdown_closes_the_session() {
    let (fake, supervisor, mut events) = start(State::default(), config()).await;
    until(&mut events, is_connected).await;
    supervisor.shutdown().await;
    assert!(!fake.with(|s| s.session_open));
    assert_eq!(
        next(&mut events).await,
        SupervisorEvent::State(LinkState::Stopped)
    );
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn rejects_a_bad_address() {
    let (_fake, connection) = FakeObexd::start(State::default()).await;
    let err = MapSupervisor::start(connection, SupervisorConfig::new("not-an-address"))
        .err()
        .expect("error");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

// --- watch_system against a fake system bus -------------------------------

const HCI0: &str = "/org/bluez/hci0";

type Objects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedVariant>>>;

fn adapter_props(powered: bool) -> HashMap<String, HashMap<String, OwnedVariant>> {
    HashMap::from([(
        "org.bluez.Adapter1".to_owned(),
        HashMap::from([(
            "Powered".to_owned(),
            OwnedVariant::try_from(Variant::from(powered)).expect("variant"),
        )]),
    )])
}

struct FakeObjectManager(Arc<Mutex<Objects>>);

#[zbus::interface(interface = "org.freedesktop.DBus.ObjectManager")]
impl FakeObjectManager {
    fn get_managed_objects(&self) -> Objects {
        self.0
            .lock()
            .expect("objects")
            .iter()
            .map(|(path, ifaces)| {
                let ifaces = ifaces
                    .iter()
                    .map(|(name, props)| {
                        let props = props
                            .iter()
                            .map(|(k, v)| (k.clone(), v.try_clone().expect("clone")))
                            .collect();
                        (name.clone(), props)
                    })
                    .collect();
                (path.clone(), ifaces)
            })
            .collect()
    }
}

/// BlueZ and logind on one fake system bus.
async fn fake_system(adapter_powered: bool) -> (Connection, Connection) {
    let objects = Objects::from([(
        OwnedObjectPath::try_from(HCI0).expect("path"),
        adapter_props(adapter_powered),
    )]);
    let (server_socket, client_socket) = std::os::unix::net::UnixStream::pair().expect("pair");
    let server = zbus::connection::Builder::unix_stream(server_socket)
        .server(zbus::Guid::generate())
        .p2p()
        .serve_at("/", FakeObjectManager(Arc::new(Mutex::new(objects))))
        .build();
    let client = zbus::connection::Builder::unix_stream(client_socket)
        .p2p()
        .build();
    let (server, client) = tokio::join!(server, client);
    (server.expect("server"), client.expect("client"))
}

async fn emit_changed(system: &Connection, path: &str, interface: &str, key: &str, value: bool) {
    let changed = HashMap::from([(key, Variant::from(value))]);
    system
        .emit_signal(
            None::<()>,
            path,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &(interface, changed, Vec::<String>::new()),
        )
        .await
        .expect("emit");
}

async fn emit_sleep(system: &Connection, sleeping: bool) {
    system
        .emit_signal(
            None::<()>,
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            "PrepareForSleep",
            &(sleeping,),
        )
        .await
        .expect("emit");
}

#[tokio::test]
async fn system_signals_drive_the_supervisor() {
    let (system, system_client) = fake_system(false).await;
    // Long enough that only a trigger can end a wait.
    let config = SupervisorConfig {
        backoff_min: Duration::from_secs(60),
        backoff_max: Duration::from_secs(60),
        ..config()
    };
    let (fake, supervisor, mut events) = start(State::default(), config).await;
    let watcher = tokio::spawn(watch_system(
        system_client,
        ADDRESS,
        supervisor.trigger_sender(),
    ));

    // The only adapter is off.
    until(
        &mut events,
        is_state(LinkState::Paused(PauseReason::AdapterDown)),
    )
    .await;
    assert!(supervisor.session().is_none());

    emit_changed(&system, HCI0, "org.bluez.Adapter1", "Powered", true).await;
    until(&mut events, is_connected).await;

    emit_sleep(&system, true).await;
    assert_eq!(
        next(&mut events).await,
        SupervisorEvent::State(LinkState::Paused(PauseReason::Sleep))
    );
    assert!(!fake.with(|s| s.session_open));
    emit_sleep(&system, false).await;
    until(&mut events, is_connected).await;

    // A dropped link: the phone's return ends the wait at once.
    fake.drop_link().await;
    until(&mut events, |e| {
        matches!(e, SupervisorEvent::State(LinkState::Waiting { .. }))
    })
    .await;
    let device = format!("{HCI0}/dev_{}", ADDRESS.replace(':', "_"));
    emit_changed(&system, &device, "org.bluez.Device1", "Connected", true).await;
    until(&mut events, is_connected).await;

    supervisor.shutdown().await;
    tokio::time::timeout(Duration::from_secs(5), watcher)
        .await
        .expect("watcher stops with the supervisor")
        .expect("join")
        .expect("watch_system");
}

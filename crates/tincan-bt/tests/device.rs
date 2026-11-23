//! Pairing, connect, forget, discovery and device events against a fake
//! BlueZ over a peer-to-peer connection.

#[path = "support/bluez.rs"]
mod fake_bluez;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use fake_bluez::{DISCOVERED, FakeBluez, KNOWN, PASSKEY, Prop, device_path};
use futures_util::FutureExt;
use tincan_bt::ErrorCode;
use tincan_bt::device::{
    self, DeviceEvent, DeviceEvents, PairingRequest, PairingResponder, cancel_pairing,
};

async fn start() -> (FakeBluez, zbus::Connection, zbus::Connection) {
    let fake = FakeBluez::default();
    let (server_socket, client_socket) = std::os::unix::net::UnixStream::pair().expect("pair");
    let server = zbus::connection::Builder::unix_stream(server_socket)
        .server(zbus::Guid::generate())
        .p2p()
        .build();
    let client = zbus::connection::Builder::unix_stream(client_socket)
        .p2p()
        .build();
    let (server, client) = tokio::join!(server, client);
    let server = server.expect("server");
    fake.serve(&server).await.expect("serve");
    (fake, server, client.expect("client"))
}

fn answer(accept: bool) -> (PairingResponder, Arc<Mutex<Vec<PairingRequest>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let responder: PairingResponder = Arc::new(move |request| {
        seen.lock().expect("asked").push(request);
        async move { accept }.boxed()
    });
    (responder, asked)
}

async fn watch(client: &zbus::Connection) -> DeviceEvents {
    DeviceEvents::subscribe(client).await.expect("subscribe")
}

async fn until(events: &mut DeviceEvents, pred: impl Fn(&DeviceEvent) -> bool) -> DeviceEvent {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.next().await.expect("event");
            if pred(&event) {
                return event;
            }
        }
    })
    .await
    .expect("timed out waiting for an event")
}

async fn until_called(fake: &FakeBluez, call: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fake.with(|s| s.calls.iter().any(|c| c == call)) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("timed out waiting for a call");
}

#[tokio::test]
async fn pairs_after_the_user_confirms_and_trusts_the_device() {
    let (fake, _server, client) = start().await;
    let mut events = watch(&client).await;

    let (responder, asked) = answer(true);
    device::pair(&client, &KNOWN.to_lowercase(), responder)
        .await
        .expect("pair");

    assert_eq!(
        *asked.lock().expect("asked"),
        vec![PairingRequest::Confirm { passkey: PASSKEY }]
    );
    assert_eq!(fake.device_prop(KNOWN, "Paired"), Some(Prop::Bool(true)));
    assert_eq!(fake.device_prop(KNOWN, "Trusted"), Some(Prop::Bool(true)));
    assert_eq!(
        fake.with(|s| s.calls.clone()),
        [
            "RegisterAgent DisplayYesNo",
            "Pair",
            "UnregisterAgent",
            "Trusted=true"
        ]
    );
    assert_eq!(fake.with(|s| s.agent.clone()), None);
    until(
        &mut events,
        |e| matches!(e, DeviceEvent::DeviceChanged(d) if d.paired && d.trusted),
    )
    .await;

    // Paired already: nothing to confirm.
    let (responder, asked) = answer(false);
    device::pair(&client, KNOWN, responder)
        .await
        .expect("pair again");
    assert!(asked.lock().expect("asked").is_empty());
    assert_eq!(fake.with(|s| s.calls.len()), 4);
}

#[tokio::test]
async fn a_declined_pairing_is_permission_denied_and_can_be_retried() {
    let (fake, _server, client) = start().await;
    let (responder, _) = answer(false);
    let err = device::pair(&client, KNOWN, responder)
        .await
        .expect_err("declined");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(fake.device_prop(KNOWN, "Paired"), Some(Prop::Bool(false)));
    assert_eq!(fake.device_prop(KNOWN, "Trusted"), Some(Prop::Bool(false)));
    assert_eq!(fake.with(|s| s.agent.clone()), None);

    let (responder, _) = answer(true);
    device::pair(&client, KNOWN, responder)
        .await
        .expect("retry");
    assert_eq!(fake.device_prop(KNOWN, "Paired"), Some(Prop::Bool(true)));
}

#[tokio::test]
async fn a_pairing_can_be_cancelled_and_only_one_runs_at_a_time() {
    let (fake, _server, client) = start().await;
    // Never answers; it must still be released once the pairing ends.
    let held = Arc::new(());
    let responder: PairingResponder = {
        let held = Arc::clone(&held);
        Arc::new(move |_| {
            let held = Arc::clone(&held);
            async move {
                let _held = held;
                futures_util::future::pending().await
            }
            .boxed()
        })
    };
    let pairing = tokio::spawn({
        let client = client.clone();
        async move { device::pair(&client, KNOWN, responder).await }
    });
    until_called(&fake, "Pair").await;

    let (other, _) = answer(true);
    let busy = device::pair(&client, KNOWN, other).await.expect_err("busy");
    assert_eq!(busy.code(), ErrorCode::Busy);

    cancel_pairing(&client, KNOWN).await.expect("cancel");
    let err = tokio::time::timeout(Duration::from_secs(5), pairing)
        .await
        .expect("pair ends")
        .expect("join")
        .expect_err("cancelled");
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    assert_eq!(fake.with(|s| s.agent.clone()), None);
    assert_eq!(fake.device_prop(KNOWN, "Paired"), Some(Prop::Bool(false)));
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&held) > 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("responder released");
}

#[tokio::test]
async fn connects_disconnects_and_forgets() {
    let (fake, _server, client) = start().await;
    let mut events = watch(&client).await;

    let err = device::connect(&client, KNOWN).await.expect_err("unpaired");
    assert_eq!(err.code(), ErrorCode::NotConnected);

    let (responder, _) = answer(true);
    device::pair(&client, KNOWN, responder).await.expect("pair");
    device::connect(&client, KNOWN).await.expect("connect");
    until(
        &mut events,
        |e| matches!(e, DeviceEvent::DeviceChanged(d) if d.connected),
    )
    .await;
    device::disconnect(&client, KNOWN)
        .await
        .expect("disconnect");
    until(
        &mut events,
        |e| matches!(e, DeviceEvent::DeviceChanged(d) if !d.connected),
    )
    .await;

    device::forget(&client, KNOWN).await.expect("forget");
    assert_eq!(
        until(&mut events, |e| matches!(
            e,
            DeviceEvent::DeviceRemoved { .. }
        ))
        .await,
        DeviceEvent::DeviceRemoved {
            path: device_path(KNOWN),
            address: KNOWN.to_owned()
        }
    );
    let err = device::connect(&client, KNOWN).await.expect_err("gone");
    assert_eq!(err.code(), ErrorCode::NotFound);
    assert!(fake.with(|s| s.devices.is_empty()));
}

#[tokio::test]
async fn discovery_finds_new_devices() {
    let (fake, _server, client) = start().await;
    let mut events = watch(&client).await;

    let err = device::connect(&client, DISCOVERED)
        .await
        .expect_err("unknown");
    assert_eq!(err.code(), ErrorCode::NotFound);
    assert!(fake.with(|s| s.calls.is_empty()));

    device::start_discovery(&client).await.expect("start");
    until(
        &mut events,
        |e| matches!(e, DeviceEvent::AdapterChanged(a) if a.discovering),
    )
    .await;
    let DeviceEvent::DeviceAdded(found) =
        until(&mut events, |e| matches!(e, DeviceEvent::DeviceAdded(_))).await
    else {
        unreachable!()
    };
    assert_eq!(found.address, DISCOVERED);
    assert!(!found.paired);

    device::stop_discovery(&client).await.expect("stop");
    until(
        &mut events,
        |e| matches!(e, DeviceEvent::AdapterChanged(a) if !a.discovering),
    )
    .await;
    let adapter = device::adapter(&client).await.expect("adapter");
    assert!(adapter.is_some_and(|a| a.powered && !a.discovering));
}

#[tokio::test]
async fn events_end_when_the_connection_closes() {
    let (_fake, server, client) = start().await;
    let mut events = watch(&client).await;
    server.graceful_shutdown().await;
    let next = tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .expect("ends");
    assert_eq!(next, None);
}

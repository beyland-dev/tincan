//! The ANCS session against a fake iPhone over a peer-to-peer connection.

#[path = "support/ancs.rs"]
mod fake_ancs;

use std::time::Duration;

use fake_ancs::{ADDRESS, FakePhone, IMPORTANT, NEGATIVE_ACTION, Posted};
use tincan_bt::ErrorCode;
use tincan_bt::ancs::{
    Action, AncsConfig, AncsEvent, AncsSession, AncsState, Category, Notification,
};
use tokio::sync::mpsc::UnboundedReceiver;

struct Rig {
    phone: FakePhone,
    server: zbus::Connection,
    client: zbus::Connection,
}

async fn rig(phone: FakePhone) -> Rig {
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
    phone.serve(&server).await.expect("serve");
    Rig {
        phone,
        server,
        client: client.expect("client"),
    }
}

fn config(content: bool) -> AncsConfig {
    AncsConfig {
        content,
        retry: Duration::from_millis(50),
        verify: Duration::from_millis(100),
        ..AncsConfig::new(ADDRESS)
    }
}

async fn start(rig: &Rig, content: bool) -> (AncsSession, UnboundedReceiver<AncsEvent>) {
    AncsSession::start(rig.client.clone(), config(content)).expect("start")
}

async fn until<T>(
    events: &mut UnboundedReceiver<AncsEvent>,
    mut pick: impl FnMut(AncsEvent) -> Option<T>,
) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.expect("event");
            if let Some(found) = pick(event) {
                return found;
            }
        }
    })
    .await
    .expect("timed out waiting for an event")
}

async fn until_state(
    events: &mut UnboundedReceiver<AncsEvent>,
    want: impl Fn(&AncsState) -> bool,
) -> AncsState {
    until(events, |e| match e {
        AncsEvent::State(state) if want(&state) => Some(state),
        _ => None,
    })
    .await
}

async fn ready(events: &mut UnboundedReceiver<AncsEvent>) {
    until_state(events, |s| *s == AncsState::Ready).await;
}

async fn notification(events: &mut UnboundedReceiver<AncsEvent>) -> Notification {
    until(events, |e| match e {
        AncsEvent::Notification(n) => Some(n),
        _ => None,
    })
    .await
}

#[tokio::test]
async fn delivers_a_notification_with_its_content() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    let waiting = until_state(&mut events, |s| matches!(s, AncsState::Waiting { .. })).await;
    assert!(
        matches!(waiting, AncsState::Waiting { hint } if hint.contains("Share System Notifications"))
    );
    ready(&mut events).await;

    // Longer than a fragment, so the response arrives in pieces.
    let body = "A body long enough to span several Data Source fragments.";
    rig.phone
        .post(&rig.server, Posted::message(7, "Ada", body))
        .await
        .expect("post");
    let n = notification(&mut events).await;
    assert_eq!(n.uid, 7);
    assert_eq!(n.app_id, "com.apple.MobileSMS");
    assert_eq!(n.app_name, "Messages");
    assert_eq!(n.title, "Ada");
    assert_eq!(n.body, body);
    assert_eq!(n.category, Category::Social);
    assert!(n.has_positive_action && n.has_negative_action);
    assert!(!n.pre_existing && !n.silent && !n.important);
    assert!(n.received > 0);

    let recent = session.recent(10).await.expect("recent");
    assert_eq!(recent, vec![n]);
    assert_eq!(session.state(), AncsState::Ready);
    session.close().await;
}

#[tokio::test]
async fn caps_title_and_body_lengths() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    rig.phone
        .post(
            &rig.server,
            Posted::message(1, &"t".repeat(300), &"b".repeat(600)),
        )
        .await
        .expect("post");
    let n = notification(&mut events).await;
    assert_eq!(n.title.len(), 128);
    assert_eq!(n.body.len(), 256);
    session.close().await;
}

#[tokio::test]
async fn without_content_asks_only_for_the_app_and_date() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, false).await;
    ready(&mut events).await;
    rig.phone
        .post(&rig.server, Posted::message(3, "Ada", "secret"))
        .await
        .expect("post");
    let n = notification(&mut events).await;
    assert_eq!((n.title.as_str(), n.body.as_str()), ("", ""));
    assert_eq!(n.app_name, "Messages");
    let request = rig
        .phone
        .with(|s| s.writes.iter().find(|w| w[0] == 0).cloned())
        .expect("request");
    assert_eq!(request, vec![0, 3, 0, 0, 0, 0, 5]);
    session.close().await;
}

#[tokio::test]
async fn replays_the_backlog_as_pre_existing_newest_first() {
    let phone = FakePhone::default();
    phone.with(|s| {
        let mut older = Posted::message(1, "Old", "first");
        older.date = "20261030T080000".into();
        let newer = Posted::message(2, "New", "second");
        s.backlog = vec![newer, older];
    });
    let rig = rig(phone).await;
    let (session, mut events) = start(&rig, true).await;
    let first = notification(&mut events).await;
    let second = notification(&mut events).await;
    assert!(first.pre_existing && second.pre_existing);
    let recent = session.recent(10).await.expect("recent");
    assert_eq!(recent.iter().map(|n| n.uid).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(session.recent(1).await.expect("recent").len(), 1);
    session.close().await;
}

#[tokio::test]
async fn reports_removals_and_refetches_modifications() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    rig.phone
        .post(&rig.server, Posted::message(4, "Ada", "one"))
        .await
        .expect("post");
    notification(&mut events).await;

    let mut changed = Posted::message(4, "Ada", "one, edited");
    changed.flags |= IMPORTANT;
    rig.phone
        .modify(&rig.server, changed)
        .await
        .expect("modify");
    let n = notification(&mut events).await;
    assert_eq!(
        (n.uid, n.body.as_str(), n.important),
        (4, "one, edited", true)
    );
    assert_eq!(session.recent(10).await.expect("recent").len(), 1);

    rig.phone.remove(&rig.server, 4).await.expect("remove");
    let removed = until(&mut events, |e| match e {
        AncsEvent::Removed { uid } => Some(uid),
        _ => None,
    })
    .await;
    assert_eq!(removed, 4);
    assert!(session.recent(10).await.expect("recent").is_empty());
    session.close().await;
}

#[tokio::test]
async fn holds_notifications_until_their_app_is_named() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    let mut chat = Posted::message(10, "Ada", "hi");
    chat.app_id = "com.example.chat".into();
    let mut unnamed = Posted::message(11, "Bob", "yo");
    unnamed.app_id = "com.example.nameless".into();
    rig.phone.post(&rig.server, chat).await.expect("post");
    rig.phone.post(&rig.server, unnamed).await.expect("post");

    let first = notification(&mut events).await;
    let second = notification(&mut events).await;
    assert_eq!((first.uid, first.app_name.as_str()), (10, "Example Chat"));
    // The phone gave no name, so one is derived from the bundle id.
    assert_eq!((second.uid, second.app_name.as_str()), (11, "Nameless"));
    let app_requests = rig
        .phone
        .with(|s| s.writes.iter().filter(|w| w[0] == 1).count());
    // The probe, then one for each new app.
    assert_eq!(app_requests, 3);
    session.close().await;
}

#[tokio::test]
async fn performs_actions_the_notification_offers() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    let mut only_negative = Posted::message(20, "Ada", "call me");
    only_negative.flags = NEGATIVE_ACTION;
    rig.phone
        .post(&rig.server, only_negative)
        .await
        .expect("post");
    notification(&mut events).await;

    session
        .perform_action(20, Action::Negative)
        .await
        .expect("negative");
    assert_eq!(rig.phone.with(|s| s.actions.clone()), vec![(20, 1)]);

    let err = session
        .perform_action(20, Action::Positive)
        .await
        .expect_err("not offered");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    let err = session
        .perform_action(99, Action::Positive)
        .await
        .expect_err("unknown");
    assert_eq!(err.code(), ErrorCode::NotFound);
    session.close().await;
}

#[tokio::test]
async fn waits_while_the_phone_does_not_share_notifications() {
    let phone = FakePhone::default();
    phone.with(|s| s.sharing = false);
    let rig = rig(phone).await;
    let (session, mut events) = start(&rig, true).await;
    until_state(&mut events, |s| matches!(s, AncsState::Waiting { .. })).await;

    let err = session
        .perform_action(1, Action::Positive)
        .await
        .expect_err("not ready");
    assert_eq!(err.code(), ErrorCode::NotConnected);

    // The probe repeats until the user allows sharing.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(rig.phone.with(|s| s.writes.len()) >= 2);
    assert!(matches!(session.state(), AncsState::Waiting { .. }));
    rig.phone.with(|s| s.sharing = true);
    ready(&mut events).await;
    session.close().await;
}

#[tokio::test]
async fn resubscribes_after_the_link_drops() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    rig.phone
        .post(&rig.server, Posted::message(5, "Ada", "before"))
        .await
        .expect("post");
    notification(&mut events).await;

    rig.phone.disconnect(&rig.server).await.expect("disconnect");
    let lost = until_state(&mut events, |s| matches!(s, AncsState::Unavailable { .. })).await;
    assert!(matches!(
        lost,
        AncsState::Unavailable {
            code: ErrorCode::NotConnected,
            ..
        }
    ));
    // Notifications from the old subscription can't be acted on.
    let err = session
        .perform_action(5, Action::Positive)
        .await
        .expect_err("stale");
    assert_eq!(err.code(), ErrorCode::NotConnected);

    // While disconnected, retries fail without the GATT objects.
    tokio::time::sleep(Duration::from_millis(150)).await;
    rig.phone.reconnect(&rig.server).await.expect("reconnect");
    ready(&mut events).await;
    let starts = rig
        .phone
        .calls()
        .iter()
        .filter(|c| c.starts_with("StartNotify"))
        .count();
    assert_eq!(starts, 4);

    rig.phone
        .post(&rig.server, Posted::message(5, "Ada", "before"))
        .await
        .expect("post");
    notification(&mut events).await;
    session
        .perform_action(5, Action::Positive)
        .await
        .expect("action in the new session");
    session.close().await;
}

#[tokio::test]
async fn notices_a_silently_dead_link_when_verifying() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    // The link goes without a Connected signal (BR/EDR keeps the device
    // connected): the periodic check finds it.
    rig.phone.with(|s| s.connected = false);
    until_state(&mut events, |s| matches!(s, AncsState::Unavailable { .. })).await;
    session.close().await;
}

#[tokio::test]
async fn close_unsubscribes() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = start(&rig, true).await;
    ready(&mut events).await;
    session.close().await;
    until_state(&mut events, |s| *s == AncsState::Closed).await;
    let calls = rig.phone.calls();
    assert!(calls.contains(&"StopNotify char0027".to_owned()));
    assert!(calls.contains(&"StopNotify char002a".to_owned()));
    assert!(rig.phone.with(|s| s.notifying.values().all(|on| !on)));
}

#[tokio::test]
async fn reports_an_unknown_device() {
    let rig = rig(FakePhone::default()).await;
    let (session, mut events) = AncsSession::start(
        rig.client.clone(),
        AncsConfig {
            retry: Duration::from_millis(50),
            ..AncsConfig::new("66:77:88:99:AA:BB")
        },
    )
    .expect("start");
    let state = until_state(&mut events, |s| {
        matches!(
            s,
            AncsState::Unavailable {
                code: ErrorCode::NotFound,
                ..
            }
        )
    })
    .await;
    assert!(matches!(state, AncsState::Unavailable { .. }));
    session.close().await;
}

#[tokio::test]
async fn refuses_a_phone_that_is_not_bonded() {
    let phone = FakePhone::default();
    phone.with(|s| s.bonded = false);
    let rig = rig(phone.clone()).await;
    let (session, mut events) = AncsSession::start(
        rig.client.clone(),
        AncsConfig {
            retry: Duration::from_millis(50),
            ..AncsConfig::new(ADDRESS)
        },
    )
    .expect("start");
    until_state(&mut events, |s| {
        matches!(
            s,
            AncsState::Unavailable {
                code: ErrorCode::PermissionDenied,
                ..
            }
        )
    })
    .await;
    // Never subscribed to the impostor's characteristics.
    assert!(!phone.calls().iter().any(|c| c.starts_with("StartNotify")));
    session.close().await;
}

#[tokio::test]
async fn rejects_bad_config() {
    let rig = rig(FakePhone::default()).await;
    let err = AncsSession::start(rig.client.clone(), AncsConfig::new("nope"))
        .err()
        .expect("bad address");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    let err = AncsSession::start(
        rig.client.clone(),
        AncsConfig {
            retry: Duration::ZERO,
            ..AncsConfig::new(ADDRESS)
        },
    )
    .err()
    .expect("bad interval");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
}

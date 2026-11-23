//! Notifications against a fake notification server over a peer-to-peer
//! connection.

#[path = "support/notifications.rs"]
mod fake_notifications;

use std::time::Duration;

use fake_notifications::FakeNotifications;
use tincan_bt::ErrorCode;
use tincan_bt::notify::{
    self, CloseReason, Notification, NotificationSignal, NotificationSignals, NotificationTracker,
    NotifierEvent, Sender,
};
use zbus::OwnedVariant;

async fn start() -> (FakeNotifications, zbus::Connection, zbus::Connection) {
    let fake = FakeNotifications::default();
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

fn message(summary: &str, body: &str) -> Notification {
    Notification {
        summary: summary.to_owned(),
        body: body.to_owned(),
        ..Notification::default()
    }
}

fn hint_str(hints: &std::collections::HashMap<String, OwnedVariant>, key: &str) -> Option<String> {
    hints
        .get(key)
        .and_then(|v| String::try_from(v.clone()).ok())
}

async fn next(signals: &mut NotificationSignals) -> NotificationSignal {
    tokio::time::timeout(Duration::from_secs(5), signals.next())
        .await
        .expect("timed out waiting for a signal")
        .expect("signal")
}

#[tokio::test]
async fn shows_a_message_with_a_default_action_and_hints() {
    let (fake, _server, client) = start().await;
    let sender = Sender {
        app_name: "Tincan".to_owned(),
        desktop_entry: Some("dev.beyland.Tincan".to_owned()),
    };
    let id = notify::notify(
        &client,
        &sender,
        &message("Ada", "see you <b>soon</b> & bye"),
    )
    .await
    .expect("notify");
    assert_eq!(id, 1);

    let shown = fake.with(|s| s.shown[0].clone());
    assert_eq!(shown.app_name, "Tincan");
    assert_eq!(shown.summary, "Ada");
    assert_eq!(shown.body, "see you &lt;b&gt;soon&lt;/b&gt; &amp; bye");
    assert_eq!(shown.actions, ["default", "Open"]);
    assert_eq!(shown.icon, "");
    assert_eq!(shown.replaces, 0);
    assert_eq!(shown.expire_timeout, -1);
    assert_eq!(
        hint_str(&shown.hints, "category").as_deref(),
        Some("im.received")
    );
    assert_eq!(
        hint_str(&shown.hints, "desktop-entry").as_deref(),
        Some("dev.beyland.Tincan")
    );
    assert_eq!(
        shown
            .hints
            .get("urgency")
            .and_then(|v| u8::try_from(v.clone()).ok()),
        Some(1)
    );
}

#[tokio::test]
async fn adapts_to_what_the_server_supports() {
    let (fake, _server, client) = start().await;
    fake.with(|s| s.capabilities = vec!["body".to_owned()]);
    let n = Notification {
        icon: Some("mail-message-new".to_owned()),
        actions: vec![("copy-code".to_owned(), "Copy code".to_owned())],
        ..message("Ada", "a < b")
    };
    notify::notify(&client, &Sender::default(), &n)
        .await
        .expect("notify");
    let shown = fake.with(|s| s.shown[0].clone());
    assert_eq!(shown.body, "a < b");
    assert!(shown.actions.is_empty());
    assert_eq!(shown.icon, "mail-message-new");
    assert!(!shown.hints.contains_key("desktop-entry"));
    assert_eq!(
        notify::capabilities(&client).await.expect("capabilities"),
        ["body"]
    );
}

#[tokio::test]
async fn offers_buttons_after_the_default_action() {
    let (fake, _server, client) = start().await;
    let n = Notification {
        actions: vec![("copy-code".to_owned(), "Copy code".to_owned())],
        ..message("Bank", "Your code is 123456")
    };
    notify::notify(&client, &Sender::default(), &n)
        .await
        .expect("notify");
    let shown = fake.with(|s| s.shown[0].clone());
    assert_eq!(shown.actions, ["default", "Open", "copy-code", "Copy code"]);
}

#[tokio::test]
async fn replaces_in_place_and_refuses_an_empty_title() {
    let (fake, _server, client) = start().await;
    let sender = Sender::default();
    let first = notify::notify(&client, &sender, &message("Ada", "one"))
        .await
        .expect("first");
    let n = Notification {
        replaces: first,
        ..message("Ada", "two")
    };
    let second = notify::notify(&client, &sender, &n).await.expect("second");
    assert_eq!(second, first);
    assert_eq!(fake.with(|s| s.shown.len()), 2);

    let err = notify::notify(&client, &sender, &message("", "body"))
        .await
        .expect_err("empty title");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert_eq!(fake.with(|s| s.shown.len()), 2);
}

#[tokio::test]
async fn signals_arrive_in_order_and_are_tracked() {
    let (fake, server, client) = start().await;
    let mut signals = NotificationSignals::subscribe(&client)
        .await
        .expect("subscribe");
    let mut tracker = NotificationTracker::default();
    let sender = Sender::default();
    let ada = notify::notify(&client, &sender, &message("Ada", "hi"))
        .await
        .expect("ada");
    tracker.track(ada, "thread-ada".to_owned());
    let bob = notify::notify(&client, &sender, &message("Bob", "yo"))
        .await
        .expect("bob");
    tracker.track(bob, "thread-bob".to_owned());

    // Another app's notification, then a click with an activation token.
    fake.invoke(&server, 99, "default", None)
        .await
        .expect("other");
    fake.invoke(&server, ada, "default", Some("tok-1"))
        .await
        .expect("invoke");
    fake.close(&server, bob, 2).await.expect("dismiss");

    let mut events = Vec::new();
    for _ in 0..4 {
        if let Some(event) = tracker.apply(next(&mut signals).await) {
            events.push(event);
        }
    }
    assert_eq!(
        events,
        [
            NotifierEvent::Action {
                id: ada,
                key: "thread-ada".to_owned(),
                action: "default".to_owned(),
                activation_token: Some("tok-1".to_owned()),
            },
            NotifierEvent::Closed {
                id: bob,
                key: "thread-bob".to_owned(),
                reason: CloseReason::Dismissed,
            },
        ]
    );

    notify::close(&client, ada).await.expect("close");
    assert_eq!(fake.with(|s| s.closed_by_app.clone()), [ada]);
    assert_eq!(
        tracker.apply(next(&mut signals).await),
        Some(NotifierEvent::Closed {
            id: ada,
            key: "thread-ada".to_owned(),
            reason: CloseReason::Closed,
        })
    );
    assert!(tracker.is_empty());
}

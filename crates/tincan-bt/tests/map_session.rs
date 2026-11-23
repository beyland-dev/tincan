//! `MapSession` against a fake obexd over a peer-to-peer connection. Nothing
//! here touches the session bus, obexd or a phone.

mod support;

use std::time::Duration;

use support::{ADDRESS, FakeMessage, FakeObexd, SESSION_PATH, State, TransferMode};
use tincan_bt::map::{ListFilter, MapEvent, MapEvents, MapSession, PushOutcome};
use tincan_bt::{ErrorCode, Recipient, build_bmessage};

fn inbox(count: usize) -> Vec<FakeMessage> {
    (0..count)
        .map(|i| {
            FakeMessage::inbox(
                &format!("{:019}", 1000 + i),
                &format!("20261031T12{:02}00", i),
                &format!("synthetic message {i}"),
            )
        })
        .collect()
}

async fn open(state: State) -> (FakeObexd, MapSession) {
    let (fake, connection) = FakeObexd::start(state).await;
    let session = MapSession::open_on(connection, ADDRESS)
        .await
        .expect("open");
    (fake, session)
}

async fn next_event(events: &mut MapEvents) -> Option<MapEvent> {
    tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .expect("event in time")
}

#[tokio::test]
async fn opens_lists_downloads_and_closes() {
    let (fake, session) = open(State {
        messages: inbox(12),
        ..State::default()
    })
    .await;
    assert_eq!(session.session_path(), SESSION_PATH);
    assert_eq!(fake.with(|s| s.folder.clone()), "/telecom/msg");
    assert_eq!(session.supported_types().await.expect("types"), ["SMS_GSM"]);
    assert_eq!(
        session.list_folders().await.expect("folders"),
        ["inbox", "sent", "outbox", "deleted"]
    );

    let filter = ListFilter {
        max_count: Some(30),
        ..ListFilter::default()
    };
    let listed = session.list_messages("inbox", &filter).await.expect("list");
    assert_eq!(fake.with(|s| s.last_filter.clone()), ["MaxCount"]);
    // Ten newest, newest first: the cap iOS applies regardless of MaxCount.
    assert_eq!(listed.len(), 10);
    assert_eq!(listed[0].handle, format!("{:019}", 1011));
    assert_eq!(listed[9].handle, format!("{:019}", 1002));
    assert!(listed.windows(2).all(|w| w[0].timestamp > w[1].timestamp));
    assert_eq!(listed[0].sender_address, "5550100");
    assert_eq!(listed[0].msg_type, "sms-gsm");
    assert!(listed[0].read);

    let message = session.get_message(&listed[0].path).await.expect("get");
    assert!(message.valid);
    assert_eq!(message.body, "synthetic message 11");
    assert_eq!(message.msg_type, "SMS_GSM");
    assert_eq!(message.originator.tel, "5550100");

    session.close().await.expect("close");
    assert!(!fake.with(|s| s.session_open));
}

#[tokio::test]
async fn unread_filter_is_passed_through() {
    let mut messages = inbox(3);
    messages[1].read = false;
    let (_fake, session) = open(State {
        messages,
        ..State::default()
    })
    .await;
    let filter = ListFilter {
        read: Some(false),
        ..ListFilter::default()
    };
    let listed = session.list_messages("inbox", &filter).await.expect("list");
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].read);
    session.close().await.expect("close");
}

#[tokio::test]
async fn transient_open_failure_is_reported_then_recovers() {
    let (fake, connection) = FakeObexd::start(State {
        fail_creates: 1,
        ..State::default()
    })
    .await;
    let Err(err) = MapSession::open_on(connection.clone(), ADDRESS).await else {
        panic!("first open should fail");
    };
    assert_eq!(err.code(), ErrorCode::Internal);
    assert!(err.message().contains("Internal Server Error"));
    let session = MapSession::open_on(connection, ADDRESS)
        .await
        .expect("retry");
    assert_eq!(fake.with(|s| s.creates), 2);
    session.close().await.expect("close");
}

#[tokio::test]
async fn rejects_bad_input_before_calling_obexd() {
    let (fake, connection) = FakeObexd::start(State::default()).await;
    let Err(err) = MapSession::open_on(connection.clone(), "not-an-address").await else {
        panic!("bad address should fail");
    };
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert_eq!(fake.with(|s| s.creates), 0);

    let session = MapSession::open_on(connection, ADDRESS)
        .await
        .expect("open");
    let filter = ListFilter::default();
    for folder in ["", "..", "a/b"] {
        let err = session.list_messages(folder, &filter).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::InvalidInput, "{folder:?}");
    }
    let foreign = "/org/bluez/obex/client/session9/message1";
    assert_eq!(
        session.get_message(foreign).await.unwrap_err().code(),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        session.set_read(foreign, true).await.unwrap_err().code(),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        session.push_message("outbox", "").await.unwrap_err().code(),
        ErrorCode::InvalidInput
    );
    session.close().await.expect("close");
}

fn bmessage() -> String {
    build_bmessage(&[Recipient::tel("5550199")], "synthetic outgoing").expect("bmessage")
}

async fn push_with(mode: TransferMode) -> (FakeObexd, tincan_bt::Result<PushOutcome>) {
    let (fake, mut session) = open(State {
        transfer_mode: mode,
        ..State::default()
    })
    .await;
    session.set_transfer_timeout(Duration::from_millis(400));
    let outcome = session.push_message("outbox", &bmessage()).await;
    session.close().await.expect("close");
    (fake, outcome)
}

#[tokio::test]
async fn push_outcomes_follow_the_transfer() {
    let (fake, outcome) = push_with(TransferMode::Immediate).await;
    assert_eq!(outcome.expect("push"), PushOutcome::Accepted);
    let pushed = fake.with(|s| s.pushed.clone());
    assert_eq!(pushed.len(), 1);
    assert_eq!(pushed[0].0, "outbox");
    assert!(pushed[0].1.contains("synthetic outgoing"));
    assert!(pushed[0].1.contains("TEL:5550199"));

    let (_, outcome) = push_with(TransferMode::Signalled).await;
    assert_eq!(outcome.expect("push"), PushOutcome::Accepted);
    let (_, outcome) = push_with(TransferMode::Vanish).await;
    assert_eq!(outcome.expect("push"), PushOutcome::Unconfirmed);
    let (_, outcome) = push_with(TransferMode::Stall).await;
    assert_eq!(outcome.expect("push"), PushOutcome::Pending);
    let (_, outcome) = push_with(TransferMode::Fail).await;
    assert_eq!(outcome.unwrap_err().code(), ErrorCode::Internal);
}

#[tokio::test]
async fn downloads_follow_the_transfer() {
    for (mode, failure) in [
        (TransferMode::Signalled, None),
        (TransferMode::Fail, Some(ErrorCode::Internal)),
        (TransferMode::Stall, Some(ErrorCode::Timeout)),
    ] {
        let (_fake, mut session) = open(State {
            messages: inbox(1),
            transfer_mode: mode,
            ..State::default()
        })
        .await;
        session.set_transfer_timeout(Duration::from_millis(400));
        let path = session
            .list_messages("inbox", &ListFilter::default())
            .await
            .expect("list")[0]
            .path
            .clone();
        let result = session.get_message(&path).await;
        match failure {
            None => assert_eq!(result.expect("get").body, "synthetic message 0"),
            Some(code) => assert_eq!(result.unwrap_err().code(), code, "{mode:?}"),
        }
        session.close().await.expect("close");
    }
}

#[tokio::test]
async fn events_report_new_messages_read_changes_and_close() {
    let (fake, session) = open(State {
        messages: inbox(1),
        ..State::default()
    })
    .await;
    let mut events = session.events().await.expect("events");

    // Listing announces its own objects; they are not new messages.
    let listed = session
        .list_messages("inbox", &ListFilter::default())
        .await
        .expect("list");
    let handle = listed[0].handle.clone();
    assert!(matches!(
        next_event(&mut events).await,
        Some(MapEvent::MessageAdded { handle: h, .. }) if h == handle
    ));
    assert!(matches!(
        next_event(&mut events).await,
        Some(MapEvent::StatusChanged { status, .. }) if status == "complete"
    ));

    let mut incoming = FakeMessage::inbox("2000", "20261031T130000", "synthetic incoming");
    incoming.read = false;
    fake.deliver(incoming.clone()).await;
    match next_event(&mut events).await {
        Some(MapEvent::MessageAdded {
            handle,
            path,
            folder,
            msg_type,
        }) => {
            assert_eq!(handle, "2000");
            assert_eq!(path, incoming.path());
            assert_eq!(folder, "/telecom/msg/inbox");
            assert_eq!(msg_type, "sms-gsm");
        }
        other => panic!("expected MessageAdded, got {other:?}"),
    }
    assert!(matches!(
        next_event(&mut events).await,
        Some(MapEvent::StatusChanged { handle, status, .. })
            if handle == "2000" && status == "notification"
    ));
    let message = session.get_message(&incoming.path()).await.expect("get");
    assert_eq!(message.body, "synthetic incoming");
    assert!(!message.read);

    session
        .set_read(&incoming.path(), true)
        .await
        .expect("set read");
    assert!(matches!(
        next_event(&mut events).await,
        Some(MapEvent::ReadChanged { handle, read: true, .. }) if handle == "2000"
    ));
    assert!(fake.with(|s| {
        s.messages
            .iter()
            .find(|m| m.handle == "2000")
            .is_some_and(|m| m.read)
    }));

    fake.drop_link().await;
    let mut removed = Vec::new();
    loop {
        match next_event(&mut events).await {
            Some(MapEvent::MessageRemoved { handle, .. }) => removed.push(handle),
            Some(MapEvent::SessionClosed) => break,
            other => panic!("unexpected {other:?}"),
        }
    }
    removed.sort();
    assert_eq!(removed, [handle, "2000".to_owned()]);
    assert_eq!(next_event(&mut events).await, None);
    // obexd already removed the session and rejects removing it again.
    assert_eq!(
        session.close().await.unwrap_err().code(),
        ErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn events_keep_the_order_obexd_sent_them_in() {
    let (fake, session) = open(State::default()).await;
    let mut events = session.events().await.expect("events");
    let handles: Vec<String> = (0..20).map(|i| format!("{}", 3000 + i)).collect();
    // Delivered back to back, so both of the event streams' queues fill
    // before anything is read.
    for handle in &handles {
        fake.deliver(FakeMessage::inbox(handle, "20261031T140000", "synthetic"))
            .await;
    }
    for expected in &handles {
        match next_event(&mut events).await {
            Some(MapEvent::MessageAdded { handle, .. }) => assert_eq!(&handle, expected),
            other => panic!("expected MessageAdded {expected}, got {other:?}"),
        }
        match next_event(&mut events).await {
            Some(MapEvent::StatusChanged { handle, status, .. }) => {
                assert_eq!(&handle, expected);
                assert_eq!(status, "notification");
            }
            other => panic!("expected StatusChanged {expected}, got {other:?}"),
        }
    }
    session.close().await.expect("close");
}

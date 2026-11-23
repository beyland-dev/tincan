//! `PbapSession` against a fake obexd over a peer-to-peer connection. Nothing
//! here touches the session bus, obexd or a phone.

mod support;

use std::time::Duration;

use support::{ADDRESS, FakeContact, FakeObexd, PBAP_SESSION_PATH, State, TransferMode};
use tincan_bt::ErrorCode;
use tincan_bt::pbap::{PbapSession, Phonebook, PhonebookVersion, PullOptions, VCardFormat};

fn contacts() -> Vec<FakeContact> {
    let mut owner = FakeContact::new("Owner", "Example", "+15550100");
    owner.email = "owner@example.com".to_owned();
    let mut ada = FakeContact::new("Ada", "Example", "+15550101");
    ada.photo = "/9j/4AAQSkZJRg==".to_owned();
    let mut grace = FakeContact::new("Grace", "Exämple", "5550102");
    grace.email = "grace@example.com".to_owned();
    vec![owner, ada, grace]
}

async fn open(state: State) -> (FakeObexd, PbapSession) {
    let (fake, connection) = FakeObexd::start(state).await;
    let session = PbapSession::open_on(connection, ADDRESS)
        .await
        .expect("open");
    (fake, session)
}

#[tokio::test]
async fn opens_pulls_and_closes() {
    let (fake, session) = open(State {
        contacts: contacts(),
        ..State::default()
    })
    .await;
    assert_eq!(session.session_path(), PBAP_SESSION_PATH);
    assert_eq!(fake.with(|s| s.selected.clone()).as_deref(), Some("pb"));
    assert_eq!(session.size(Phonebook::Contacts).await.expect("size"), 3);

    let cards = session
        .pull_contacts(&PullOptions::default())
        .await
        .expect("pull");
    let (format, offset, _, fields) = fake.with(|s| s.last_pull.clone()).expect("pulled");
    assert_eq!(format, "vcard30");
    assert_eq!(offset, 0);
    assert!(!fields.iter().any(|f| f == "PHOTO"));
    let names: Vec<&str> = cards.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Owner Example", "Ada Example", "Grace Exämple"]);
    assert!(
        cards
            .iter()
            .all(|c| c.version == "3.0" && c.photo.is_none())
    );
    assert_eq!(cards[0].tels[0].value, "+15550100");
    assert_eq!(cards[2].emails[0].value, "grace@example.com");

    session.close().await.expect("close");
    assert!(session.is_closed());
    assert!(!fake.with(|s| s.pbap_open));
    session.close().await.expect("second close is a no-op");
}

#[tokio::test]
async fn passes_pull_options_through() {
    let (fake, session) = open(State {
        contacts: contacts(),
        ..State::default()
    })
    .await;
    let options = PullOptions {
        format: VCardFormat::V21,
        offset: 1,
        max_count: Some(1),
        photos: true,
    };
    let cards = session.pull_contacts(&options).await.expect("pull");
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].name, "Ada Example");
    assert_eq!(cards[0].version, "2.1");
    let photo = cards[0].photo.as_ref().expect("photo");
    assert_eq!(photo.data, "/9j/4AAQSkZJRg==");
    assert_eq!(
        fake.with(|s| s.last_pull.clone()).map(|p| (p.0, p.1, p.2)),
        Some(("vcard21".to_owned(), 1, 1))
    );
    session.close().await.expect("close");
}

#[tokio::test]
async fn selects_each_phonebook_it_reads() {
    let mut missed = FakeContact::new("Ada", "Example", "+15550101");
    missed.call = "MISSED".to_owned();
    let (fake, session) = open(State {
        contacts: contacts(),
        calls: vec![missed],
        ..State::default()
    })
    .await;
    let calls = session
        .pull(Phonebook::Combined, &PullOptions::default())
        .await
        .expect("calls");
    assert_eq!(fake.with(|s| s.selected.clone()).as_deref(), Some("cch"));
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].call_type, "MISSED");
    assert_eq!(session.size(Phonebook::Contacts).await.expect("size"), 3);
    assert_eq!(fake.with(|s| s.selected.clone()).as_deref(), Some("pb"));
    let favorites = session
        .pull(Phonebook::Favorites, &PullOptions::default())
        .await
        .expect("an empty phonebook");
    assert!(favorites.is_empty());

    let version = session.version(Phonebook::Contacts).await.expect("version");
    assert_eq!(
        version,
        PhonebookVersion {
            folder: Some("/telecom/pb".to_owned()),
            database_identifier: Some("0123456789abcdef0123456789abcdef".to_owned()),
            primary_counter: Some(format!("{:032x}", 3)),
            secondary_counter: Some(format!("{:032x}", 0)),
        }
    );
    session.close().await.expect("close");
}

#[tokio::test]
async fn marks_favorites() {
    let (_fake, session) = open(State {
        contacts: contacts(),
        favorites: contacts().split_off(1),
        ..State::default()
    })
    .await;
    let favorites = session
        .pull(Phonebook::Favorites, &PullOptions::default())
        .await
        .expect("favorites");
    assert_eq!(favorites.len(), 2);
    assert!(favorites.iter().all(|c| c.favorite));
    let contacts = session
        .pull_contacts(&PullOptions::default())
        .await
        .expect("contacts");
    assert!(contacts.iter().all(|c| !c.favorite));
    session.close().await.expect("close");
}

#[tokio::test]
async fn concurrent_pulls_keep_their_selection() {
    let mut missed = FakeContact::new("Ada", "Example", "+15550101");
    missed.call = "MISSED".to_owned();
    let (_fake, session) = open(State {
        contacts: contacts(),
        calls: vec![missed],
        transfer_mode: TransferMode::Signalled,
        ..State::default()
    })
    .await;
    let options = PullOptions::default();
    let (people, calls) = tokio::join!(
        session.pull(Phonebook::Contacts, &options),
        session.pull(Phonebook::Combined, &options),
    );
    assert_eq!(people.expect("contacts").len(), 3);
    assert_eq!(calls.expect("calls").len(), 1);
    session.close().await.expect("close");
}

#[tokio::test]
async fn transfers_that_fail_or_stall_are_errors() {
    for (mode, code) in [
        (TransferMode::Fail, ErrorCode::Internal),
        (TransferMode::Stall, ErrorCode::Timeout),
    ] {
        let (_fake, mut session) = open(State {
            contacts: contacts(),
            transfer_mode: mode,
            ..State::default()
        })
        .await;
        session.set_transfer_timeout(Duration::from_millis(300));
        let err = session
            .pull_contacts(&PullOptions::default())
            .await
            .expect_err("pull fails");
        assert_eq!(err.code(), code, "{mode:?}");
        assert!(err.message().contains("PBAP"), "{}", err.message());
        session.close().await.expect("close");
    }
}

#[tokio::test]
async fn rejects_bad_addresses_and_reports_a_lost_link() {
    let (fake, connection) = FakeObexd::start(State::default()).await;
    let err = PbapSession::open_on(connection.clone(), "not-an-address")
        .await
        .err()
        .expect("invalid address");
    assert_eq!(err.code(), ErrorCode::InvalidInput);
    assert!(!fake.with(|s| s.pbap_open));

    let session = PbapSession::open_on(connection, ADDRESS)
        .await
        .expect("open");
    fake.drop_link().await;
    let err = session
        .size(Phonebook::Contacts)
        .await
        .expect_err("session gone");
    assert!(tincan_bt::map::is_session_lost(&err), "{err:?}");
    session.close().await.ok();
}

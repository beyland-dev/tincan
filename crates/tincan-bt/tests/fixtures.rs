//! The shared synthetic fixtures in `fixtures/` (also used by the Node tests).

use tincan_bt::bmessage::{Party, Recipient, build_bmessage, parse_bmessage, thread_key_for};
use tincan_bt::vcard::parse_vcards;

const INCOMING_SMS: &str = include_str!("../../../fixtures/bmessage/incoming-sms.bmsg");
const INCOMING_EMAIL: &str =
    include_str!("../../../fixtures/bmessage/incoming-email-multiline.bmsg");
const SENT_GROUP: &str = include_str!("../../../fixtures/bmessage/sent-group.bmsg");
const PHONEBOOK: &str = include_str!("../../../fixtures/vcard/phonebook.vcf");
const CALL_HISTORY: &str = include_str!("../../../fixtures/vcard/call-history.vcf");

#[test]
fn incoming_sms() {
    assert!(INCOMING_SMS.contains("\r\n"), "fixture must keep CRLF");
    let m = parse_bmessage(INCOMING_SMS);
    assert!(m.valid);
    assert!(!m.read);
    assert_eq!(m.msg_type, "SMS_GSM");
    assert_eq!(m.folder, "telecom/msg/inbox");
    assert_eq!(m.originator.name, "Jamie Example");
    assert_eq!(thread_key_for(&m.originator), "tel:+15555550142");
    assert_eq!(m.recipients.len(), 1);
    assert_eq!(m.recipients[0].tel, "+15555550100");
    assert_eq!(m.body, "Are we still on for lunch? 🌮");
    assert_eq!(m.charset, "UTF-8");
    assert_eq!(m.length, Some(53));
}

#[test]
fn incoming_email_with_stuffed_line() {
    let m = parse_bmessage(INCOMING_EMAIL);
    assert!(m.valid && m.read);
    assert_eq!(m.originator.name, "Riley Sample");
    assert_eq!(
        thread_key_for(&m.originator),
        "email:riley.sample@example.com"
    );
    assert!(m.recipients.is_empty());
    assert_eq!(m.body, "First line\nEND:MSG\nLast line");
    assert_eq!(m.parts.len(), 1);
}

#[test]
fn sent_group() {
    let m = parse_bmessage(SENT_GROUP);
    assert_eq!(m.folder, "telecom/msg/sent");
    assert!(m.originator.is_empty());
    let keys: Vec<String> = m.recipients.iter().map(thread_key_for).collect();
    assert_eq!(keys, ["tel:+15555550111", "tel:5555550122"]);
    assert_eq!(m.recipients[1].name, "Casey Placeholder");
    assert_eq!(m.body, "See you both at 7");
}

#[test]
fn built_message_round_trips() {
    let text = build_bmessage(
        &[
            Recipient::tel("+15555550142"),
            Recipient::email("riley@example.com"),
        ],
        "hello\nEND:MSG",
    )
    .expect("valid recipients");
    let m = parse_bmessage(&text);
    assert!(m.valid);
    assert_eq!(m.body, "hello\nEND:MSG");
    let keys: Vec<String> = m.recipients.iter().map(thread_key_for).collect();
    assert_eq!(keys, ["tel:+15555550142", "email:riley@example.com"]);
    assert_eq!(
        thread_key_for(&Party {
            tel: "(555) 555-0199".into(),
            ..Party::default()
        }),
        "tel:5555550199"
    );
}

#[test]
fn phonebook() {
    let cards = parse_vcards(PHONEBOOK);
    assert_eq!(cards.len(), 3, "the empty card is dropped");

    let jorg = &cards[0];
    assert_eq!(jorg.version, "2.1");
    assert_eq!(jorg.name, "Jörg Müller");
    assert_eq!(jorg.family, "Müller");
    assert_eq!(jorg.tels.len(), 2);
    assert_eq!(jorg.tels[0].value, "+1 555-555-0101");
    assert!(jorg.tels[0].types.contains(&"cell".to_string()));

    let morgan = &cards[1];
    assert_eq!(morgan.name, "Morgan Testcase");
    assert_eq!(morgan.emails[0].value, "morgan.testcase@example.com");
    assert!(morgan.tels[0].types.contains(&"pref".to_string()));
    let photo = morgan.photo.as_ref().expect("photo");
    assert!(photo.bytes().is_some_and(|b| b.starts_with(&[0xff, 0xd8])));

    assert_eq!(cards[2].name, "Pat O, Example");
}

#[test]
fn call_history() {
    let cards = parse_vcards(CALL_HISTORY);
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0].call_type, "MISSED");
    assert_eq!(cards[0].call_time, "20260115T091500");
    assert_eq!(cards[0].tels[0].value, "+15555550105");
    assert_eq!(cards[1].call_type, "DIALED");
    assert_eq!(cards[1].name, "Jamie Example");
}

//! Whatever Tincan builds, it parses back: the body (line breaks normalised
//! to `\n`, trailing ones dropped) and every recipient's conversation.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::bmessage::{
    Recipient, build_bmessage, parse_bmessage, split_lines, thread_key_for,
};

fuzz_target!(|input: (Vec<(bool, String)>, String)| {
    let (addresses, body) = input;
    let recipients: Vec<Recipient> = addresses
        .into_iter()
        .map(|(email, address)| {
            if email {
                Recipient::email(address)
            } else {
                Recipient::tel(address)
            }
        })
        .collect();
    let Ok(built) = build_bmessage(&recipients, &body) else {
        return;
    };
    let parsed = parse_bmessage(&built);
    assert!(parsed.valid);
    assert_eq!(parsed.folder, "telecom/msg/outbox");
    let expected = split_lines(&body).join("\n");
    assert_eq!(parsed.body, expected.trim_end_matches(['\n', '\r']));
    let keys: Vec<String> = parsed.recipients.iter().map(thread_key_for).collect();
    let wanted: Vec<String> = recipients.iter().map(Recipient::thread_key).collect();
    assert_eq!(keys, wanted);
});

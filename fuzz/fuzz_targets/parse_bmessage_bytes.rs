//! Any bytes a phone (or a stranger's message) could put in a bMessage:
//! parsing never panics, and every part's text is in the body.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::bmessage::parse_bmessage_bytes;

fuzz_target!(|data: &[u8]| {
    let message = parse_bmessage_bytes(data);
    if message.parts.len() == 1 && message.encoding.is_empty() && message.charset.is_empty() {
        assert_eq!(message.parts[0], message.body);
    }
});

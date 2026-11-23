//! vCard line unfolding: never panics, and the text and byte forms agree.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::vcard::{unfold, unfold_bytes};

fuzz_target!(|data: &[u8]| {
    let raw = unfold_bytes(data);
    if let Ok(text) = std::str::from_utf8(data) {
        let lines = unfold(text);
        assert_eq!(lines.len(), raw.len());
        for (line, bytes) in lines.iter().zip(&raw) {
            assert_eq!(line.as_bytes(), bytes.as_slice());
        }
    }
});

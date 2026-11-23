//! PBAP downloads as raw bytes and as text, plus every photo's base64.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::vcard::{parse_vcards, parse_vcards_bytes};

fuzz_target!(|data: &[u8]| {
    for card in parse_vcards_bytes(data) {
        if let Some(photo) = &card.photo {
            let _ = photo.bytes();
        }
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let cards = parse_vcards(text);
        for card in &cards {
            if let Some(photo) = &card.photo {
                let _ = photo.bytes();
            }
        }
        // Valid UTF-8 without declared charsets parses the same either way.
        if !text.to_ascii_uppercase().contains("CHARSET") {
            assert_eq!(parse_vcards_bytes(data), cards);
        }
    }
});

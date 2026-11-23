//! MAP timestamps (`YYYYMMDDTHHMMSS[Z]`), including the local-time path.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::bmessage::parse_map_timestamp;

fuzz_target!(|text: &str| {
    let utc = parse_map_timestamp(text);
    if text.len() < 15 {
        assert_eq!(utc, 0);
    }
});

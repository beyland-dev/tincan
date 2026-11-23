//! ANCS Notification Source packets: only eight-byte packets parse.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tincan_bt::ancs::SourceEvent;

fuzz_target!(|data: &[u8]| {
    if SourceEvent::parse(data).is_some() {
        assert_eq!(data.len(), 8);
    }
});

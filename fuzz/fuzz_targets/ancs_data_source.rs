//! ANCS Data Source reassembly: any expected header and attribute ids, then
//! any sequence of fragments, resets and new expectations.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use tincan_bt::ancs::parser::{Assembled, DataSourceAssembler};

#[derive(Debug, Arbitrary)]
enum Step {
    Expect { header: Vec<u8>, ids: Vec<u8> },
    Append(Vec<u8>),
    Reset,
}

fuzz_target!(|steps: Vec<Step>| {
    let mut assembler = DataSourceAssembler::default();
    for step in steps {
        match step {
            Step::Expect { header, ids } => assembler.expect(header, ids),
            Step::Append(fragment) => match assembler.append(&fragment) {
                Assembled::Complete(_) | Assembled::Error(_) => assert!(!assembler.expecting()),
                Assembled::NeedMore | Assembled::Stale => {}
            },
            Step::Reset => assembler.reset(),
        }
    }
});

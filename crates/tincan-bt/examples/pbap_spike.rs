//! Phase 0 PBAP spike.
//!
//! # WARNING: live phone, real personal data
//!
//! - This **talks to a real, paired iPhone** over Bluetooth and downloads its
//!   whole phonebook and call history (read-only; the phone may ask to allow
//!   contact sharing the first time). Run it only when you mean to. It is
//!   never run by tests or CI.
//! - The downloads pass through private temp files under
//!   `$XDG_RUNTIME_DIR/tincan`, removed afterwards. The console output is
//!   redacted to counts and timings, but review it before sharing it, and
//!   **never commit or share** any contact data it touches.
//!
//! Opens a PBAP session, reads each phonebook's size and version properties,
//! pulls the contacts (vCard 3.0, then 2.1, then with photos), paging, the
//! favourites and the call history, and closes. Output is redacted: counts,
//! timings, formats and field presence only, never names, numbers or the
//! version counters' values.
//!
//! ```sh
//! cargo run -p tincan-bt --example pbap_spike -- [--address AA:BB:CC:DD:EE:FF] [--no-photos]
//! ```

use std::collections::BTreeMap;
use std::time::Instant;

use tincan_bt::bluez;
use tincan_bt::pbap::{PbapSession, Phonebook, PullOptions, VCardFormat};
use tincan_bt::vcard::VCard;

const PHONEBOOKS: [Phonebook; 6] = [
    Phonebook::Contacts,
    Phonebook::Favorites,
    Phonebook::Incoming,
    Phonebook::Outgoing,
    Phonebook::Missed,
    Phonebook::Combined,
];

fn summarize(cards: &[VCard]) -> String {
    let count = |f: fn(&VCard) -> bool| cards.iter().filter(|c| f(c)).count();
    let mut versions = BTreeMap::new();
    for card in cards {
        *versions.entry(card.version.as_str()).or_insert(0) += 1;
    }
    format!(
        "{} cards (versions {versions:?}); named {}, with tel {}, email {}, photo {}, favourite {}",
        cards.len(),
        count(|c| !c.name.is_empty()),
        count(|c| !c.tels.is_empty()),
        count(|c| !c.emails.is_empty()),
        count(|c| c.photo.is_some()),
        count(|c| c.favorite),
    )
}

fn shape(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_ascii_digit() { 'd' } else { c })
        .collect()
}

async fn run(address: &str, photos: bool) -> Result<(), tincan_bt::Error> {
    let started = Instant::now();
    let session = PbapSession::open(address).await?;
    println!("open: ok in {:?}", started.elapsed());

    for book in PHONEBOOKS {
        let name = book.as_str();
        match session.size(book).await {
            Ok(n) => println!("size {name}: {n}"),
            Err(e) => println!("size {name}: {} {}", e.code(), e.message()),
        }
        match session.version(book).await {
            Ok(v) => println!(
                "version {name}: folder {:?}, databaseIdentifier {}, primary {}, secondary {}",
                v.folder,
                v.database_identifier
                    .as_ref()
                    .map_or("absent".into(), |s| format!("{} chars", s.len())),
                v.primary_counter
                    .as_ref()
                    .map_or("absent".into(), |s| format!("{} chars", s.len())),
                v.secondary_counter
                    .as_ref()
                    .map_or("absent".into(), |s| format!("{} chars", s.len())),
            ),
            Err(e) => println!("version {name}: {} {}", e.code(), e.message()),
        }
    }

    for format in [VCardFormat::V30, VCardFormat::V21] {
        let started = Instant::now();
        let options = PullOptions {
            format,
            ..PullOptions::default()
        };
        match session.pull_contacts(&options).await {
            Ok(cards) => {
                println!(
                    "pull pb {}: {} in {:?}",
                    format.as_str(),
                    summarize(&cards),
                    started.elapsed()
                );
                if let Some(owner) = cards.first() {
                    println!(
                        "  entry 0: named {}, tels {}, emails {}",
                        !owner.name.is_empty(),
                        owner.tels.len(),
                        owner.emails.len()
                    );
                }
                let mut types = BTreeMap::new();
                for tel in cards.iter().flat_map(|c| &c.tels) {
                    *types.entry(tel.types.join(",")).or_insert(0) += 1;
                }
                println!("  tel types: {types:?}");
            }
            Err(e) => println!("pull pb {}: {} {}", format.as_str(), e.code(), e.message()),
        }
    }

    let paged = PullOptions {
        offset: 1,
        max_count: Some(5),
        ..PullOptions::default()
    };
    match session.pull_contacts(&paged).await {
        Ok(cards) => println!("pull pb offset 1 max 5: {} cards", cards.len()),
        Err(e) => println!("pull pb paged: {} {}", e.code(), e.message()),
    }

    if photos {
        let started = Instant::now();
        let options = PullOptions {
            photos: true,
            ..PullOptions::default()
        };
        match session.pull_contacts(&options).await {
            Ok(cards) => {
                let mut media = BTreeMap::new();
                let mut bytes = 0;
                for photo in cards.iter().filter_map(|c| c.photo.as_ref()) {
                    *media.entry(photo.media_type.as_str()).or_insert(0) += 1;
                    bytes += photo.data.len();
                }
                println!(
                    "pull pb photos: {} in {:?}; media types {media:?}, {bytes} base64 bytes",
                    summarize(&cards),
                    started.elapsed()
                );
            }
            Err(e) => println!("pull pb photos: {} {}", e.code(), e.message()),
        }
    }

    for book in &PHONEBOOKS[1..] {
        let started = Instant::now();
        match session.pull(*book, &PullOptions::default()).await {
            Ok(cards) => {
                let mut kinds = BTreeMap::new();
                let mut shapes = BTreeMap::new();
                for card in &cards {
                    *kinds.entry(card.call_type.as_str()).or_insert(0) += 1;
                    *shapes.entry(shape(&card.call_time)).or_insert(0) += 1;
                }
                println!(
                    "pull {}: {} in {:?}; call types {kinds:?}, call time shapes {shapes:?}",
                    book.as_str(),
                    summarize(&cards),
                    started.elapsed()
                );
            }
            Err(e) => println!("pull {}: {} {}", book.as_str(), e.code(), e.message()),
        }
    }

    session.close().await?;
    println!("close: ok");
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    let mut address = None;
    let mut photos = true;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--address" => address = args.next(),
            "--no-photos" => photos = false,
            other => {
                eprintln!("unknown argument {other}");
                return std::process::ExitCode::FAILURE;
            }
        }
    }
    let address = match address {
        Some(a) => a,
        None => match bluez::snapshot().await {
            Ok(snap) => match snap.devices.iter().find(|d| d.is_iphone && d.connected) {
                Some(d) => d.address.clone(),
                None => {
                    eprintln!("no connected iPhone; pass --address");
                    return std::process::ExitCode::FAILURE;
                }
            },
            Err(e) => {
                eprintln!("bluez: {} {}", e.code(), e.message());
                return std::process::ExitCode::FAILURE;
            }
        },
    };
    match run(&address, photos).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {} {}", e.code(), e.message());
            std::process::ExitCode::FAILURE
        }
    }
}

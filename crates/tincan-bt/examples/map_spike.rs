//! Phase 0.1 MAP spike.
//!
//! # WARNING: live phone, real personal data
//!
//! - This **talks to a real, paired iPhone** over Bluetooth: it opens a MAP
//!   session (which can displace another computer or app holding the phone's
//!   message connection), downloads messages, and with `--push` **sends a
//!   real text message**. Run it only when you mean to, with any other MAP
//!   client stopped. It is never run by tests or CI.
//! - With `--raw-dir DIR` it writes **raw, unredacted messages and listings**
//!   (bodies, phone numbers, names) to `DIR`. The directory is created (or
//!   tightened) to 0700 and each file to 0600, but the data is still on disk:
//!   delete it when done, and **never commit, attach or share it**. Redact by
//!   hand into synthetic fixtures instead.
//! - The console output is redacted, but review it before pasting it anywhere.
//!
//! Opens a MAP session, reports the folders and listings, downloads a few
//! messages, optionally pushes one message, then watches for MNS event reports.
//! Output is redacted: handles, counts, types, lengths and field presence only.
//! With `--raw-dir DIR`, raw listings and bMessages are written to `DIR` (0600)
//! for manual redaction into fixtures; never commit them as written.
//! With `--read-probe`, messages that arrive during the watch aren't downloaded
//! then; afterwards each one's read flag is listed, it is downloaded, and the
//! flag is listed again, to see whether `GetMessage` marks a message read.
//!
//! ```sh
//! cargo run -p tincan-bt --example map_spike -- [--address AA:BB:CC:DD:EE:FF]
//!     [--count 20] [--get 3] [--attachment] [--watch 120] [--read-probe] [--raw-dir DIR]
//!     [--push RECIPIENT --text TEXT [--folder outbox]]
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tincan_bt::bluez;
use tincan_bt::bmessage::recipient_from_input;
use tincan_bt::map::{ListFilter, MSG_ROOT, MapEvent, MapListing, MapSession};

#[derive(Debug, Default)]
struct Args {
    address: Option<String>,
    count: u16,
    get: usize,
    attachment: bool,
    watch: u64,
    read_probe: bool,
    raw_dir: Option<PathBuf>,
    push: Option<String>,
    text: Option<String>,
    folder: String,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        count: 20,
        get: 3,
        folder: "outbox".into(),
        ..Args::default()
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match flag.as_str() {
            "--address" => args.address = Some(value("--address")?),
            "--count" => args.count = value("--count")?.parse().map_err(|_| "bad --count")?,
            "--get" => args.get = value("--get")?.parse().map_err(|_| "bad --get")?,
            "--attachment" => args.attachment = true,
            "--watch" => args.watch = value("--watch")?.parse().map_err(|_| "bad --watch")?,
            "--read-probe" => args.read_probe = true,
            "--raw-dir" => args.raw_dir = Some(value("--raw-dir")?.into()),
            "--push" => args.push = Some(value("--push")?),
            "--text" => args.text = Some(value("--text")?),
            "--folder" => args.folder = value("--folder")?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if args.push.is_some() != args.text.is_some() {
        return Err("--push and --text go together".into());
    }
    Ok(args)
}

fn redact_address(address: &str) -> String {
    format!("…{}", &address[address.len().saturating_sub(5)..])
}

fn write_raw(dir: &Option<PathBuf>, name: &str, contents: &str) {
    let Some(dir) = dir else { return };
    if let Err(err) = write_private(dir, name, contents.as_bytes()) {
        println!("  raw write failed: {err}");
    }
}

/// Writes `contents` to `dir/name` with the directory 0700 and the file 0600,
/// whatever existed before and whatever the umask. Refuses a `dir` that is a
/// symlink or not a directory, and never follows a symlink at the file.
fn write_private(dir: &Path, name: &str, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    if !std::fs::symlink_metadata(dir)?.is_dir() {
        return Err(std::io::Error::other(
            "--raw-dir must be a directory, not a symlink",
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(name))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(contents)
}

fn summarize(label: &str, listings: &[MapListing]) {
    let mut types: BTreeMap<&str, usize> = BTreeMap::new();
    let mut present: BTreeMap<&str, usize> = BTreeMap::new();
    let mut statuses: BTreeMap<&str, usize> = BTreeMap::new();
    let mut folders: BTreeMap<&str, usize> = BTreeMap::new();
    let (mut read, mut sent, mut dated) = (0, 0, 0);
    for l in listings {
        *types.entry(l.msg_type.as_str()).or_default() += 1;
        *statuses.entry(l.status.as_str()).or_default() += 1;
        *folders.entry(l.folder.as_str()).or_default() += 1;
        for (name, has) in [
            ("subject", !l.subject.is_empty()),
            ("sender", !l.sender.is_empty()),
            ("senderAddress", !l.sender_address.is_empty()),
            ("replyTo", !l.reply_to.is_empty()),
            ("recipient", !l.recipient.is_empty()),
            ("recipientAddress", !l.recipient_address.is_empty()),
            ("size", l.size.is_some()),
            ("attachmentSize", l.attachment_size.is_some_and(|n| n > 0)),
        ] {
            if has {
                *present.entry(name).or_default() += 1;
            }
        }
        read += usize::from(l.read);
        sent += usize::from(l.sent);
        dated += usize::from(l.timestamp > 0);
    }
    println!("  {label}: {} messages", listings.len());
    if listings.is_empty() {
        return;
    }
    println!("    types {types:?}");
    println!("    folders {folders:?}");
    println!("    statuses {statuses:?}");
    println!("    read {read}, sent {sent}, timestamped {dated}");
    println!("    fields present {present:?}");
    let ordered = listings
        .windows(2)
        .all(|w| w[0].timestamp >= w[1].timestamp);
    let first = &listings[0];
    let last = &listings[listings.len() - 1];
    println!(
        "    newest {} (handle {}), oldest {} (handle {}), sorted {ordered}",
        first.timestamp, first.handle, last.timestamp, last.handle
    );
}

async fn list_folder(
    session: &MapSession,
    folder: &str,
    filter: &ListFilter,
) -> Result<Vec<MapListing>, String> {
    let started = Instant::now();
    match session.list_messages(folder, filter).await {
        Ok(listings) => {
            println!("  {folder}: listed in {:?}", started.elapsed());
            Ok(listings)
        }
        Err(err) => {
            println!(
                "  {folder}: ListMessages failed ({}: {}); trying SetFolder + ListMessages(\"\")",
                err.code(),
                err.message()
            );
            session
                .set_folder(folder)
                .await
                .map_err(|e| format!("SetFolder({folder}): {e}"))?;
            let result = session.list_current(filter).await;
            let _ = session.set_folder(MSG_ROOT).await;
            result.map_err(|e| format!("ListMessages(\"\") in {folder}: {e}"))
        }
    }
}

/// The inbox read flag of each of `wanted`, by handle (`?` if not listed).
async fn read_flags(session: &MapSession, args: &Args, wanted: &[MapListing]) -> String {
    let filter = ListFilter {
        max_count: Some(args.count),
        ..ListFilter::default()
    };
    let listings = match session.list_messages("inbox", &filter).await {
        Ok(listings) => listings,
        Err(err) => return format!("listing failed ({}: {})", err.code(), err.message()),
    };
    wanted
        .iter()
        .map(|w| {
            let flag = listings
                .iter()
                .find(|l| l.handle == w.handle)
                .map_or("?", |l| if l.read { "read" } else { "unread" });
            format!("{} {flag}", w.handle)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

async fn download(session: &MapSession, args: &Args, listing: &MapListing, tag: &str) {
    let started = Instant::now();
    match session.get_raw(&listing.path, args.attachment).await {
        Ok(raw) => {
            let parsed = tincan_bt::parse_bmessage(&raw);
            println!(
                "    {tag} {}: {} bytes in {:?}; valid {}, version {:?}, type {:?}, folder {:?}, \
                 read {}, charset {:?}, encoding {:?}, length {:?}, parts {}, body {} chars, \
                 originator tel {} email {} name {}, recipients {}",
                listing.handle,
                raw.len(),
                started.elapsed(),
                parsed.valid,
                parsed.version,
                parsed.msg_type,
                parsed.folder,
                parsed.read,
                parsed.charset,
                parsed.encoding,
                parsed.length,
                parsed.parts.len(),
                parsed.body.chars().count(),
                !parsed.originator.tel.is_empty(),
                !parsed.originator.email.is_empty(),
                !parsed.originator.name.is_empty(),
                parsed.recipients.len(),
            );
            write_raw(
                &args.raw_dir,
                &format!("{tag}-{}.bmsg", listing.handle),
                &raw,
            );
        }
        Err(err) => println!(
            "    {tag} {}: Get failed ({}: {})",
            listing.handle,
            err.code(),
            err.message()
        ),
    }
}

async fn run(args: Args) -> Result<(), String> {
    let address = match &args.address {
        Some(a) => a.clone(),
        None => {
            let snapshot = bluez::snapshot().await.map_err(|e| e.to_string())?;
            snapshot
                .devices
                .iter()
                .find(|d| d.is_iphone && d.connected && d.supports_map)
                .map(|d| d.address.clone())
                .ok_or("no connected iPhone with MAP; pass --address")?
        }
    };
    println!("phone {}", redact_address(&address));

    let started = Instant::now();
    let session = MapSession::open(&address)
        .await
        .map_err(|e| format!("open: {} ({})", e.message(), e.code()))?;
    println!(
        "session {} opened in {:?}",
        session.session_path(),
        started.elapsed()
    );

    let result = explore(&session, &args).await;
    match session.close().await {
        Ok(()) => println!("session closed"),
        Err(err) => println!("close failed: {err}"),
    }
    result
}

async fn explore(session: &MapSession, args: &Args) -> Result<(), String> {
    match session.supported_types().await {
        Ok(types) => println!("supported types {types:?}"),
        Err(err) => println!("supported types failed: {err}"),
    }
    match session.list_folders().await {
        Ok(folders) => println!("folders under {MSG_ROOT}: {folders:?}"),
        Err(err) => println!("ListFolders failed: {err}"),
    }

    // Subscribe before listing so no report is lost in between.
    let mut events = session.events().await.map_err(|e| e.to_string())?;

    let filter = ListFilter {
        max_count: Some(args.count),
        ..ListFilter::default()
    };
    println!("listings (MaxCount {}):", args.count);
    let mut inbox = Vec::new();
    for folder in ["inbox", "sent", "outbox", "deleted"] {
        match list_folder(session, folder, &filter).await {
            Ok(listings) => {
                summarize(folder, &listings);
                write_raw(
                    &args.raw_dir,
                    &format!("listing-{folder}.json"),
                    &serde_json::to_string_pretty(&listings).unwrap_or_default(),
                );
                if folder == "inbox" {
                    inbox = listings;
                }
            }
            Err(err) => println!("  {folder}: {err}"),
        }
    }

    let unread = ListFilter {
        max_count: Some(args.count),
        read: Some(false),
        ..ListFilter::default()
    };
    match session.list_messages("inbox", &unread).await {
        Ok(listings) => println!("  inbox Read=false filter: {} messages", listings.len()),
        Err(err) => println!("  inbox Read=false filter failed: {err}"),
    }

    if args.get > 0 {
        println!(
            "downloads (attachment {}):",
            if args.attachment { "on" } else { "off" }
        );
        for listing in inbox.iter().take(args.get) {
            download(session, args, listing, "get").await;
        }
    }

    let started = Instant::now();
    match session.update_inbox().await {
        Ok(()) => println!("UpdateInbox ok in {:?}", started.elapsed()),
        Err(err) => println!("UpdateInbox failed ({}: {})", err.code(), err.message()),
    }

    if let (Some(to), Some(text)) = (&args.push, &args.text) {
        let recipient = recipient_from_input(to).map_err(|e| e.to_string())?;
        let bmessage = tincan_bt::build_bmessage(&[recipient], text).map_err(|e| e.to_string())?;
        let started = Instant::now();
        match session.push_message(&args.folder, &bmessage).await {
            Ok(outcome) => println!(
                "push to folder {:?}: {outcome:?} in {:?}",
                args.folder,
                started.elapsed()
            ),
            Err(err) => println!(
                "push to folder {:?} failed ({}: {})",
                args.folder,
                err.code(),
                err.message()
            ),
        }
    }

    if args.watch > 0 {
        println!("watching events for {}s; text the phone now", args.watch);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(args.watch);
        let started = Instant::now();
        let mut arrived: Vec<MapListing> = Vec::new();
        loop {
            let event = tokio::select! {
                event = events.next() => event,
                () = tokio::time::sleep_until(deadline) => break,
            };
            let Some(event) = event else {
                println!("  event stream ended");
                break;
            };
            let at = started.elapsed().as_secs_f32();
            match &event {
                MapEvent::MessageAdded {
                    handle,
                    folder,
                    msg_type,
                    ..
                } => println!("  +{at:.1}s added {handle} folder {folder:?} type {msg_type:?}"),
                MapEvent::StatusChanged { handle, status, .. } => {
                    println!("  +{at:.1}s status {handle} {status:?}");
                }
                MapEvent::FolderChanged { handle, folder, .. } => {
                    println!("  +{at:.1}s folder {handle} {folder:?}");
                }
                MapEvent::ReadChanged { handle, read, .. } => {
                    println!("  +{at:.1}s read {handle} {read}");
                }
                MapEvent::MessageRemoved { handle, .. } => {
                    println!("  +{at:.1}s removed {handle}");
                }
                MapEvent::SessionClosed => println!("  +{at:.1}s session closed"),
            }
            if let MapEvent::StatusChanged {
                handle,
                path,
                status,
            } = &event
                && status == "notification"
            {
                let listing = MapListing {
                    handle: handle.clone(),
                    path: path.clone(),
                    ..MapListing::default()
                };
                if args.read_probe {
                    arrived.push(listing);
                } else {
                    download(session, args, &listing, "event").await;
                }
            }
        }
        if args.read_probe && !arrived.is_empty() {
            println!("read probe ({} arrived):", arrived.len());
            println!(
                "  before get: {}",
                read_flags(session, args, &arrived).await
            );
            for listing in &arrived {
                download(session, args, listing, "probe").await;
            }
            println!(
                "  after get:  {}",
                read_flags(session, args, &arrived).await
            );
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            return std::process::ExitCode::from(2);
        }
    };
    match run(args).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err}");
            std::process::ExitCode::FAILURE
        }
    }
}

//! Serves the test fake obexd (`tests/support/mod.rs`) as `org.bluez.obex` on
//! a private bus, for the Node tests of `@beyland/tincan-native`, with a
//! synthetic phonebook. It prints `ready` once the name is owned, then
//! answers one line per command read from stdin, and exits when stdin closes:
//!
//! - `state`: JSON `{ pbapOpen, selected, lastPull }`
//! - `mode <immediate|signalled|fail|stall>`: how the next transfers settle
//! - `bonded <true|false>`: whether the fake BlueZ has the phone bonded
//!
//! When the system bus is the same private bus, it also serves the test fake
//! BlueZ (`tests/support/bluez.rs`) as `org.bluez`, with the phone paired and
//! bonded, since `PbapSession.open` refuses a phone that isn't.
//!
//! It refuses to run on the real session bus: one under `/run/user`, or one
//! that already has an obexd.

#[path = "../tests/support/mod.rs"]
mod support;

#[path = "../tests/support/bluez.rs"]
mod fake_bluez;

use support::{FakeContact, FakeObexd, State, TransferMode};
use zbus::fdo::{DBusProxy, RequestNameFlags, RequestNameReply};

const NAME: &str = "org.bluez.obex";

fn phonebook() -> State {
    let mut owner = FakeContact::new("Owner", "Example", "+15550100");
    owner.email = "owner@example.com".to_owned();
    let mut ada = FakeContact::new("Ada", "Example", "+15550101");
    ada.photo = "/9j/4AAQSkZJRg==".to_owned();
    let grace = FakeContact::new("Grace", "Example", "+15550102");
    let mut missed = ada.clone();
    missed.photo.clear();
    missed.call = "MISSED".to_owned();
    State {
        favorites: vec![ada.clone()],
        contacts: vec![owner, ada, grace],
        calls: vec![missed],
        ..State::default()
    }
}

async fn run(
    fake: &FakeObexd,
    bluez: Option<&(fake_bluez::FakeBluez, zbus::Connection)>,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let words: Vec<&str> = line.split_whitespace().collect();
    match words.as_slice() {
        ["state"] => Ok(fake.with(|s| {
            let last_pull = s.last_pull.as_ref().map(|(format, offset, max, fields)| {
                serde_json::json!({
                    "format": format,
                    "offset": offset,
                    "maxCount": max,
                    "fields": fields,
                })
            });
            serde_json::json!({
                "pbapOpen": s.pbap_open,
                "selected": s.selected,
                "lastPull": last_pull,
            })
            .to_string()
        })),
        ["mode", mode] => {
            let mode = match *mode {
                "immediate" => TransferMode::Immediate,
                "signalled" => TransferMode::Signalled,
                "fail" => TransferMode::Fail,
                "stall" => TransferMode::Stall,
                _ => return Err(format!("unknown mode: {mode}").into()),
            };
            fake.with(|s| s.transfer_mode = mode);
            Ok("ok".to_owned())
        }
        ["bonded", value] => {
            let (bluez, connection) = bluez.ok_or("no fake BlueZ on this bus")?;
            let value = fake_bluez::Prop::Bool(*value == "true");
            let path = fake_bluez::device_path(fake_bluez::KNOWN);
            for key in ["Paired", "Bonded"] {
                bluez
                    .set_device(connection, &path, key, value.clone())
                    .await?;
            }
            Ok("ok".to_owned())
        }
        _ => Err(format!("unknown command: {line}").into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = std::env::var("DBUS_SESSION_BUS_ADDRESS")
        .map_err(|_| "set DBUS_SESSION_BUS_ADDRESS to a private bus")?;
    if address.contains("/run/user/") {
        return Err("refusing to serve on the real session bus".into());
    }
    let connection = zbus::connection::Builder::address(address.as_str())
        .build()
        .await?;
    let bus = DBusProxy::new(&connection).await?;
    if bus.name_has_owner(NAME.try_into()?).await? {
        return Err("this bus already has an obexd".into());
    }
    let fake = FakeObexd::serve(connection, phonebook()).await?;
    let reply = bus
        .request_name(NAME.try_into()?, RequestNameFlags::DO_NOT_QUEUE)
        .await?;
    if reply != RequestNameReply::PrimaryOwner {
        return Err("could not own the obexd name".into());
    }
    let bluez = if std::env::var("DBUS_SYSTEM_BUS_ADDRESS").ok().as_deref() == Some(&address) {
        let connection = zbus::connection::Builder::address(address.as_str())
            .build()
            .await?;
        let bluez = fake_bluez::FakeBluez::default();
        let path = fake_bluez::device_path(fake_bluez::KNOWN);
        bluez.with(|s| {
            if let Some(props) = s.devices.get_mut(&path) {
                for key in ["Paired", "Bonded"] {
                    props.insert(key.to_owned(), fake_bluez::Prop::Bool(true));
                }
            }
        });
        bluez.serve(&connection).await?;
        connection.request_name("org.bluez").await?;
        Some((bluez, connection))
    } else {
        None
    };
    println!("ready");

    loop {
        let line = tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .map(|n| (n > 0).then_some(line))
        })
        .await??;
        let Some(line) = line else { break };
        match run(&fake, bluez.as_ref(), line.trim()).await {
            Ok(out) => println!("{out}"),
            Err(e) => println!("error: {e}"),
        }
    }
    Ok(())
}

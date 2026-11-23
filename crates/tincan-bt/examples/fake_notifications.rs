//! Serves the test fake notification server (`tests/support/notifications.rs`)
//! as `org.freedesktop.Notifications` on a private bus, for the Node tests of
//! `@beyland/tincan-native`. It prints `ready` once the name is owned, then
//! answers one line per command read from stdin, and exits when stdin closes:
//!
//! - `state`: JSON `{ shown, closedByApp }`
//! - `capabilities a,b,c`: sets what GetCapabilities returns
//! - `invoke <id> <action> [token]`: the user clicks a notification
//! - `close <id> <reason>`: the notification goes away
//!
//! It refuses to run on the real session bus: one under `/run/user`, or one
//! that already has a notification server.

#[path = "../tests/support/notifications.rs"]
mod fake_notifications;

use fake_notifications::{FakeNotifications, Shown};
use zbus::fdo::{DBusProxy, RequestNameFlags, RequestNameReply};

const NAME: &str = "org.freedesktop.Notifications";

fn shown_json(shown: &Shown) -> serde_json::Value {
    let hint = |key: &str| shown.hints.get(key).cloned();
    serde_json::json!({
        "id": shown.id,
        "appName": shown.app_name,
        "replaces": shown.replaces,
        "icon": shown.icon,
        "summary": shown.summary,
        "body": shown.body,
        "actions": shown.actions,
        "category": hint("category").and_then(|v| String::try_from(v).ok()),
        "desktopEntry": hint("desktop-entry").and_then(|v| String::try_from(v).ok()),
        "urgency": hint("urgency").and_then(|v| u8::try_from(v).ok()),
        "expireTimeout": shown.expire_timeout,
    })
}

async fn run(
    fake: &FakeNotifications,
    connection: &zbus::Connection,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let words: Vec<&str> = line.split_whitespace().collect();
    match words.as_slice() {
        ["state"] => {
            let (shown, closed) = fake.with(|s| {
                (
                    s.shown.iter().map(shown_json).collect::<Vec<_>>(),
                    s.closed_by_app.clone(),
                )
            });
            Ok(serde_json::json!({ "shown": shown, "closedByApp": closed }).to_string())
        }
        ["capabilities", list] => {
            let list = list.split(',').filter(|c| !c.is_empty()).map(str::to_owned);
            fake.with(|s| s.capabilities = list.collect());
            Ok("ok".to_owned())
        }
        ["capabilities"] => {
            fake.with(|s| s.capabilities.clear());
            Ok("ok".to_owned())
        }
        ["invoke", id, action, rest @ ..] => {
            fake.invoke(connection, id.parse()?, action, rest.first().copied())
                .await?;
            Ok("ok".to_owned())
        }
        ["close", id, reason] => {
            fake.close(connection, id.parse()?, reason.parse()?).await?;
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
        return Err("this bus already has a notification server".into());
    }
    let fake = FakeNotifications::default();
    fake.serve(&connection).await?;
    let reply = bus
        .request_name(NAME.try_into()?, RequestNameFlags::DO_NOT_QUEUE)
        .await?;
    if reply != RequestNameReply::PrimaryOwner {
        return Err("could not own the notifications name".into());
    }
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
        match run(&fake, &connection, line.trim()).await {
            Ok(out) => println!("{out}"),
            Err(e) => println!("error: {e}"),
        }
    }
    Ok(())
}

//! Serves the test fake iPhone (`tests/support/ancs.rs`) as `org.bluez` on a
//! private bus, for the Node tests of `@beyland/tincan-native`. It prints
//! `ready` once the name is owned, then answers one line per command read
//! from stdin, and exits when stdin closes:
//!
//! - `state`: JSON `{ notifying, writes, actions, calls }`
//! - `post <uid> <title> <body>` / `remove <uid>`: a Messages notification
//!   (`_` in the title or body stands for a space)
//! - `backlog <uid> <title> <body>`: one already on the phone, replayed when
//!   the client subscribes
//! - `sharing <on|off>`: whether the phone answers Control Point writes
//! - `disconnect` / `reconnect`: the LE link
//!
//! It refuses to run unless `DBUS_SYSTEM_BUS_ADDRESS` names a bus other than
//! the real system bus. All data is synthetic.

#[path = "../tests/support/ancs.rs"]
mod fake_ancs;

use fake_ancs::{DATA_SOURCE, FakePhone, NOTIFICATION_SOURCE, Posted};

async fn run(
    phone: &FakePhone,
    connection: &zbus::Connection,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let text = |s: &str| s.replace('_', " ");
    match words.as_slice() {
        ["state"] => Ok(phone.with(|s| {
            let on = |p: &str| s.notifying.get(p).copied().unwrap_or(false);
            serde_json::json!({
                "notifying": on(NOTIFICATION_SOURCE) && on(DATA_SOURCE),
                "writes": s.writes.len(),
                "actions": s.actions,
                "calls": s.calls,
            })
            .to_string()
        })),
        ["post", uid, title, body] => {
            let posted = Posted::message(uid.parse()?, &text(title), &text(body));
            phone.post(connection, posted).await?;
            Ok("ok".to_owned())
        }
        ["backlog", uid, title, body] => {
            let posted = Posted::message(uid.parse()?, &text(title), &text(body));
            phone.with(|s| s.backlog.push(posted));
            Ok("ok".to_owned())
        }
        ["remove", uid] => {
            phone.remove(connection, uid.parse()?).await?;
            Ok("ok".to_owned())
        }
        ["sharing", on] => {
            let on = match *on {
                "on" => true,
                "off" => false,
                _ => return Err(format!("unknown sharing: {on}").into()),
            };
            phone.with(|s| s.sharing = on);
            Ok("ok".to_owned())
        }
        ["disconnect"] => {
            phone.disconnect(connection).await?;
            Ok("ok".to_owned())
        }
        ["reconnect"] => {
            phone.reconnect(connection).await?;
            Ok("ok".to_owned())
        }
        _ => Err(format!("unknown command: {line}").into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = std::env::var("DBUS_SYSTEM_BUS_ADDRESS")
        .map_err(|_| "set DBUS_SYSTEM_BUS_ADDRESS to a private bus")?;
    if address.contains("system_bus_socket") {
        return Err("refusing to serve on the real system bus".into());
    }
    let connection = zbus::connection::Builder::address(address.as_str())
        .build()
        .await?;
    let phone = FakePhone::default();
    phone.serve(&connection).await?;
    connection.request_name("org.bluez").await?;
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
        match run(&phone, &connection, line.trim()).await {
            Ok(out) => println!("{out}"),
            Err(e) => println!("error: {e}"),
        }
    }
    Ok(())
}

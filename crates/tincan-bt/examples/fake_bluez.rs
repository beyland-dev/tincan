//! Serves the test fake BlueZ (`tests/support/bluez.rs`) as `org.bluez` on
//! a private bus, for the Node tests of `@beyland/tincan-native`. It prints
//! `ready` once the name is owned, and exits when stdin closes.
//!
//! It refuses to run unless `DBUS_SYSTEM_BUS_ADDRESS` names a bus other than
//! the real system bus.

#[path = "../tests/support/bluez.rs"]
mod fake_bluez;

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
    let fake = fake_bluez::FakeBluez::default();
    fake.serve(&connection).await?;
    connection.request_name("org.bluez").await?;
    println!("ready");

    tokio::task::spawn_blocking(|| std::io::copy(&mut std::io::stdin(), &mut std::io::sink()))
        .await??;
    Ok(())
}

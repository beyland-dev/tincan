//! Read-only Phase 0 probe: lists BlueZ adapters and devices as JSON and flags
//! iPhones that advertise MAP and PBAP.
//!
//! It makes one `GetManagedObjects` call on the system bus. It never pairs,
//! connects, starts discovery or opens an OBEX session.
//!
//! ```sh
//! cargo run -p tincan-bt --example probe
//! ```

use tincan_bt::bluez;

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    match bluez::snapshot().await {
        Ok(snapshot) => {
            let iphones: Vec<serde_json::Value> = snapshot
                .devices
                .iter()
                .filter(|d| d.is_iphone)
                .map(|d| {
                    serde_json::json!({
                        "path": d.path,
                        "alias": d.alias,
                        "paired": d.paired,
                        "trusted": d.trusted,
                        "connected": d.connected,
                        "map": d.supports_map,
                        "pbap": d.supports_pbap,
                        "ancs": d.supports_ancs,
                    })
                })
                .collect();
            let report = serde_json::json!({
                "adapters": snapshot.adapters,
                "devices": snapshot.devices,
                "iphones": iphones,
            });
            match serde_json::to_string_pretty(&report) {
                Ok(text) => {
                    println!("{text}");
                    std::process::ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("probe: {err}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
        Err(err) => {
            eprintln!("probe: {} ({})", err, err.code());
            std::process::ExitCode::FAILURE
        }
    }
}

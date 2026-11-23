//! Phase 0.3 vault spike: a live round trip through the desktop keyring and
//! SQLCipher. It touches no phone. It stores a key under a throwaway vault id,
//! builds an encrypted database in a temporary directory, checks it can't be
//! read without the key, and deletes the keyring item afterwards.
//!
//! ```sh
//! cargo run -p tincan-vault --example vault_spike
//! ```

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Instant;

use tincan_vault::{
    KeyLocation, KeyOptions, SecretService, SqlValue, Vault, VaultKey, load_or_create,
};

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0)
}

fn header(path: &Path) -> Vec<u8> {
    let mut buf = vec![0; 16];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    buf.truncate(read);
    buf
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("tincan-vault-spike-{}", std::process::id()));
    let db = dir.join("tincan.db");
    let id = format!("spike-{}", std::process::id());
    let options = KeyOptions::for_database(&db, &id);

    let started = Instant::now();
    let (key, location) = load_or_create(&options).await?;
    println!("key: created in {:?} at {location:?}", started.elapsed());

    let result = exercise(&db, &key, &options).await;

    if location == KeyLocation::SecretService {
        let service = SecretService::connect().await?;
        let deleted = tincan_vault::key::delete_from_service(&service, &options).await?;
        service.close().await?;
        println!("keyring: deleted {deleted} test item(s)");
    }
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn exercise(
    db: &Path,
    key: &VaultKey,
    options: &KeyOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let vault = Vault::open(db, key)?;
    println!(
        "vault: opened in {:?}, SQLCipher {}",
        started.elapsed(),
        vault.cipher_version()?
    );
    vault.exec_batch(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT);
         CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id');",
    )?;
    let started = Instant::now();
    vault.transaction(|v| {
        for i in 0..1000 {
            let body = SqlValue::Text(format!("synthetic message {i}"));
            v.exec(
                "INSERT INTO messages (body) VALUES (?1)",
                std::slice::from_ref(&body),
            )?;
            v.exec(
                "INSERT INTO messages_fts (rowid, body) VALUES (last_insert_rowid(), ?1)",
                &[body],
            )?;
        }
        Ok(())
    })?;
    println!("vault: 1000 inserts + FTS in {:?}", started.elapsed());
    let started = Instant::now();
    let hits = vault.query(
        "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'message'",
        &[],
    )?;
    println!(
        "vault: FTS query {:?} -> {:?}",
        started.elapsed(),
        hits.rows[0][0]
    );
    vault.close()?;

    println!(
        "file: mode {:o}, dir mode {:o}, plaintext header: {}",
        mode(db),
        mode(db.parent().unwrap_or(db)),
        header(db).starts_with(b"SQLite format 3")
    );

    let reopen = KeyOptions {
        allow_create: false,
        ..options.clone()
    };
    let started = Instant::now();
    let (again, location) = load_or_create(&reopen).await?;
    println!(
        "key: reloaded in {:?} from {location:?}, matches: {}",
        started.elapsed(),
        &again == key
    );
    let vault = Vault::open(db, &again)?;
    let count = vault.query("SELECT count(*) FROM messages", &[])?;
    println!("vault: reopened, {:?} rows", count.rows[0][0]);
    vault.close()?;

    let wrong = VaultKey::generate()?;
    match Vault::open(db, &wrong) {
        Ok(_) => println!("wrong key: OPENED (unexpected)"),
        Err(err) => println!("wrong key: rejected ({})", err.code()),
    }
    Ok(())
}

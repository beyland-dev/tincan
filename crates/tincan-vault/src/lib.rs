//! Tincan's encrypted store: SQLCipher through rusqlite, with the key in the
//! Secret Service (or a 0600 file when there is no keyring).
//!
//! ```no_run
//! # async fn demo() -> tincan_vault::Result<()> {
//! use tincan_vault::{KeyOptions, Vault};
//! let path = std::path::Path::new("/home/me/.local/share/tincan/tincan.db");
//! let (key, _location) = tincan_vault::load_or_create(&KeyOptions::for_database(path, "default")).await?;
//! let vault = Vault::open(path, &key)?;
//! # Ok(()) }
//! ```

pub mod error;
pub mod key;
pub mod secret_service;
pub mod vault;

pub use error::{Error, ErrorCode, Result};
pub use key::{KeyLocation, KeyOptions, VaultKey, load_or_create, load_or_create_with};
pub use secret_service::SecretService;
pub use vault::{Changes, Rows, SqlValue, Vault};

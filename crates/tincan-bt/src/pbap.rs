//! OBEX PBAP (Phone Book Access Profile) client sessions through obexd
//! (`org.bluez.obex`) on the **session** bus. Read-only: PBAP can't change
//! the phone's contacts.
//!
//! obexd API used (BlueZ `doc/org.bluez.obex.PhonebookAccess.rst`):
//! - `Client1.CreateSession` with `Target = "pbap"`.
//! - The session's `PhonebookAccess1`: `Select(s location, s phonebook)`
//!   (must come first), `PullAll(s targetfile, a{sv} filters) -> (o, a{sv})`,
//!   `GetSize() -> q`, and the `Folder`, `DatabaseIdentifier`,
//!   `PrimaryCounter` and `SecondaryCounter` properties.
//!
//! Contact names, numbers and photos are never logged; only counts.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, ErrorCode, Result};
use crate::map::validate_address;
use crate::obex::{ObexSession, session_bus};
use crate::vcard::{VCard, parse_vcards_bytes};

/// A full phonebook with photos can take a while over Bluetooth.
const DEFAULT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

/// The largest phonebook download accepted, photos included (thousands of
/// contacts with photos run to tens of MiB). A larger one fails with
/// `INTERNAL`; pull in pages (`offset`, `max_count`) or without photos.
pub const MAX_PULL_SIZE: u64 = 64 * 1024 * 1024;

/// The properties a pull asks for without photos (names obexd accepts). The
/// phone leaves out any it doesn't share. `X-IRMC-CALL-DATETIME` only appears
/// in call history.
const FIELDS: [&str; 14] = [
    "VERSION",
    "FN",
    "N",
    "TEL",
    "EMAIL",
    "NICKNAME",
    "ORG",
    "TITLE",
    "BDAY",
    "ADR",
    "URL",
    "NOTE",
    "X-IRMC-CALL-DATETIME",
    "UID",
];

#[zbus::proxy(
    interface = "org.bluez.obex.PhonebookAccess1",
    default_service = "org.bluez.obex"
)]
trait PhonebookAccess {
    fn select(&self, location: &str, phonebook: &str) -> zbus::Result<()>;

    fn pull_all(
        &self,
        targetfile: &str,
        filters: HashMap<&str, zbus::Variant<'_>>,
    ) -> zbus::Result<crate::obex::TransferReply>;

    fn get_size(&self) -> zbus::Result<u16>;

    #[zbus(property)]
    fn folder(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn database_identifier(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn primary_counter(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn secondary_counter(&self) -> zbus::Result<String>;
}

/// A phonebook object on the phone's internal storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phonebook {
    /// `pb`: the contacts. Entry 0 is the phone owner's own card.
    #[default]
    Contacts,
    /// `fav`: favourites (PBAP 1.2; not every phone has it).
    Favorites,
    /// `ich`: incoming calls.
    Incoming,
    /// `och`: outgoing calls.
    Outgoing,
    /// `mch`: missed calls.
    Missed,
    /// `cch`: all calls.
    Combined,
}

impl Phonebook {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contacts => "pb",
            Self::Favorites => "fav",
            Self::Incoming => "ich",
            Self::Outgoing => "och",
            Self::Missed => "mch",
            Self::Combined => "cch",
        }
    }

    pub fn parse(name: &str) -> Result<Self> {
        Ok(match name {
            "pb" => Self::Contacts,
            "fav" => Self::Favorites,
            "ich" => Self::Incoming,
            "och" => Self::Outgoing,
            "mch" => Self::Missed,
            "cch" => Self::Combined,
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    "Expected a phonebook: pb, fav, ich, och, mch or cch.",
                ));
            }
        })
    }
}

/// The vCard version a pull asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VCardFormat {
    V21,
    #[default]
    V30,
}

impl VCardFormat {
    /// obexd's name for it: `vcard21` or `vcard30`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::V21 => "vcard21",
            Self::V30 => "vcard30",
        }
    }

    /// The inverse of [`VCardFormat::as_str`]; `INVALID_INPUT` otherwise.
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "vcard21" => Ok(Self::V21),
            "vcard30" => Ok(Self::V30),
            _ => Err(Error::new(
                ErrorCode::InvalidInput,
                "Expected a vCard format: vcard21 or vcard30.",
            )),
        }
    }
}

/// What a pull fetches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullOptions {
    pub format: VCardFormat,
    /// Entries to skip.
    pub offset: u16,
    /// At most this many entries (the phone's default is all of them).
    pub max_count: Option<u16>,
    /// Include `PHOTO`. Photos make a pull much larger and slower.
    pub photos: bool,
}

impl PullOptions {
    pub fn to_dbus(&self) -> HashMap<&'static str, zbus::Variant<'static>> {
        let mut fields: Vec<String> = FIELDS.iter().map(|f| (*f).to_owned()).collect();
        if self.photos {
            fields.push("PHOTO".to_owned());
        }
        let mut filters = HashMap::from([
            ("Format", zbus::Variant::from(self.format.as_str())),
            ("Fields", zbus::Variant::from(fields)),
        ]);
        if self.offset > 0 {
            filters.insert("Offset", zbus::Variant::from(self.offset));
        }
        if let Some(max) = self.max_count {
            filters.insert("MaxCount", zbus::Variant::from(max));
        }
        filters
    }
}

/// The phonebook's version properties, which change when the phone's
/// contacts do. Each is `None` when the phone doesn't report it (PBAP 1.2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonebookVersion {
    /// The selected folder, such as `/telecom/pb`.
    pub folder: Option<String>,
    pub database_identifier: Option<String>,
    pub primary_counter: Option<String>,
    pub secondary_counter: Option<String>,
}

/// An open obexd PBAP session. Call [`PbapSession::close`] when done.
pub struct PbapSession {
    obex: ObexSession,
    /// Held across `Select` and the call after it, which uses the selection.
    selection: tokio::sync::Mutex<()>,
}

impl PbapSession {
    /// Opens a PBAP session to the phone at `address` and selects its
    /// contacts. **Talks to the phone**, which may ask the user to allow
    /// contact sharing the first time.
    ///
    /// Refuses (`PERMISSION_DENIED`) a phone BlueZ hasn't paired and bonded
    /// with ([`crate::bluez::require_bonded`]).
    pub async fn open(address: &str) -> Result<Self> {
        validate_address(address)?;
        crate::bluez::require_bonded(&crate::bluez::system_bus().await?, address).await?;
        Self::open_on(session_bus().await?, address).await
    }

    /// [`PbapSession::open`] over an existing connection to obexd (tests use
    /// a peer-to-peer fake), without the bond check.
    pub async fn open_on(connection: zbus::Connection, address: &str) -> Result<Self> {
        let obex = ObexSession::create(
            connection,
            address,
            "pbap",
            "PBAP",
            DEFAULT_TRANSFER_TIMEOUT,
        )
        .await?;
        let this = Self {
            obex,
            selection: tokio::sync::Mutex::new(()),
        };
        if let Err(err) = this.select(Phonebook::Contacts).await {
            this.obex.close().await.ok();
            return Err(err);
        }
        Ok(this)
    }

    pub fn session_path(&self) -> &str {
        self.obex.path().as_str()
    }

    pub fn set_transfer_timeout(&mut self, timeout: Duration) {
        self.obex.transfer_timeout = timeout;
    }

    async fn access(&self) -> Result<PhonebookAccessProxy<'_>> {
        Ok(PhonebookAccessProxy::builder(self.obex.connection())
            .path(self.obex.path().as_ref())
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?)
    }

    async fn select(&self, phonebook: Phonebook) -> Result<PhonebookAccessProxy<'_>> {
        let access = self.access().await?;
        access.select("int", phonebook.as_str()).await?;
        Ok(access)
    }

    /// The number of entries in `phonebook`.
    pub async fn size(&self, phonebook: Phonebook) -> Result<u16> {
        let _selection = self.selection.lock().await;
        Ok(self.select(phonebook).await?.get_size().await?)
    }

    /// The folder and version properties of `phonebook`.
    pub async fn version(&self, phonebook: Phonebook) -> Result<PhonebookVersion> {
        let _selection = self.selection.lock().await;
        let access = self.select(phonebook).await?;
        Ok(PhonebookVersion {
            folder: access.folder().await.ok(),
            database_identifier: access.database_identifier().await.ok(),
            primary_counter: access.primary_counter().await.ok(),
            secondary_counter: access.secondary_counter().await.ok(),
        })
    }

    /// `PullAll` of `phonebook` as raw vCard bytes, undecoded: each
    /// property's `CHARSET` is applied when it is parsed
    /// ([`parse_vcards_bytes`]).
    pub async fn pull_raw(&self, phonebook: Phonebook, options: &PullOptions) -> Result<Vec<u8>> {
        let _selection = self.selection.lock().await;
        let access = self.select(phonebook).await?;
        let filters = options.to_dbus();
        self.obex
            .download("pbap-pull", "vcf", MAX_PULL_SIZE, |target| async move {
                access.pull_all(&target, filters).await
            })
            .await
    }

    /// `PullAll` of `phonebook`, parsed.
    pub async fn pull(&self, phonebook: Phonebook, options: &PullOptions) -> Result<Vec<VCard>> {
        let mut cards = parse_vcards_bytes(&self.pull_raw(phonebook, options).await?);
        if phonebook == Phonebook::Favorites {
            for card in &mut cards {
                card.favorite = true;
            }
        }
        tracing::debug!(
            phonebook = phonebook.as_str(),
            entries = cards.len(),
            "pulled a phonebook"
        );
        Ok(cards)
    }

    /// The contacts (`pb`), parsed.
    pub async fn pull_contacts(&self, options: &PullOptions) -> Result<Vec<VCard>> {
        self.pull(Phonebook::Contacts, options).await
    }

    /// `RemoveSession`. Closing twice is a no-op.
    pub async fn close(&self) -> Result<()> {
        self.obex.close().await
    }

    pub fn is_closed(&self) -> bool {
        self.obex.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_phonebooks() {
        for book in [
            Phonebook::Contacts,
            Phonebook::Favorites,
            Phonebook::Incoming,
            Phonebook::Outgoing,
            Phonebook::Missed,
            Phonebook::Combined,
        ] {
            assert_eq!(Phonebook::parse(book.as_str()).ok(), Some(book));
        }
        assert!(Phonebook::parse("../pb").is_err());
        for format in [VCardFormat::V21, VCardFormat::V30] {
            assert_eq!(VCardFormat::parse(format.as_str()).ok(), Some(format));
        }
        assert!(VCardFormat::parse("vcard40").is_err());
    }

    #[test]
    fn builds_filters() {
        let filters = PullOptions::default().to_dbus();
        let mut keys: Vec<_> = filters.keys().copied().collect();
        keys.sort_unstable();
        assert_eq!(keys, ["Fields", "Format"]);
        assert_eq!(filters["Format"], zbus::Variant::from("vcard30"));
        let fields = Vec::<String>::try_from(filters["Fields"].clone()).unwrap_or_default();
        assert!(!fields.iter().any(|f| f == "PHOTO"));

        let filters = PullOptions {
            format: VCardFormat::V21,
            offset: 5,
            max_count: Some(10),
            photos: true,
        }
        .to_dbus();
        assert_eq!(filters["Format"], zbus::Variant::from("vcard21"));
        assert_eq!(filters["Offset"], zbus::Variant::from(5u16));
        assert_eq!(filters["MaxCount"], zbus::Variant::from(10u16));
        let fields = Vec::<String>::try_from(filters["Fields"].clone()).unwrap_or_default();
        assert!(fields.iter().any(|f| f == "PHOTO"));
    }
}

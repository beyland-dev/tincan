//! `PbapSession`: read-only phonebook access (PBAP) to one phone.
//!
//! Each session is one obexd PBAP connection. Unlike `MapLink` it isn't
//! supervised: open one, pull what you need and close it.

use std::sync::Arc;
use std::time::Duration;

use napi::Env;
use napi::bindgen_prelude::PromiseRaw;
use napi_derive::napi;
use tincan_bt::pbap::{self, Phonebook, PullOptions, VCardFormat};
use tincan_bt::{Error, ErrorCode};

use crate::{ParsedVCard, spawn_js};

#[napi(object)]
#[derive(Default)]
pub struct PbapSessionOptions {
    /// Limit on one pull (default 120000).
    pub transfer_timeout_ms: Option<u32>,
}

/// What a pull fetches.
#[napi(object)]
#[derive(Default)]
pub struct PbapPullOptions {
    /// Default `'vcard30'`.
    #[napi(ts_type = "'vcard21' | 'vcard30'")]
    pub format: Option<String>,
    /// Entries to skip (default 0). Entry 0 of `pb` is the owner's card.
    pub offset: Option<u32>,
    /// At most this many entries (default all).
    pub max_count: Option<u32>,
    /// Include photos (default false). They make a pull much larger.
    pub photos: Option<bool>,
}

/// The phonebook's version properties; each is absent when the phone
/// doesn't report it.
#[napi(object)]
pub struct PhonebookVersion {
    pub folder: Option<String>,
    pub database_identifier: Option<String>,
    pub primary_counter: Option<String>,
    pub secondary_counter: Option<String>,
}

fn u16_option(value: Option<u32>, name: &str) -> tincan_bt::Result<Option<u16>> {
    value
        .map(|v| {
            u16::try_from(v).map_err(|_| {
                Error::new(
                    ErrorCode::InvalidInput,
                    format!("{name} must be at most 65535."),
                )
            })
        })
        .transpose()
}

fn pull_options(options: Option<PbapPullOptions>) -> tincan_bt::Result<PullOptions> {
    let options = options.unwrap_or_default();
    Ok(PullOptions {
        format: options
            .format
            .as_deref()
            .map(VCardFormat::parse)
            .transpose()?
            .unwrap_or_default(),
        offset: u16_option(options.offset, "offset")?.unwrap_or(0),
        max_count: u16_option(options.max_count, "maxCount")?,
        photos: options.photos.unwrap_or(false),
    })
}

fn phonebook(name: Option<String>) -> tincan_bt::Result<Phonebook> {
    name.as_deref()
        .map(Phonebook::parse)
        .transpose()
        .map(Option::unwrap_or_default)
}

/// An open PBAP session. Call `close()` when done.
#[napi]
pub struct PbapSession {
    inner: Arc<pbap::PbapSession>,
}

#[napi]
impl PbapSession {
    /// Connects to the phone at `address` over obexd's PBAP client. Rejects
    /// `INVALID_INPUT` for a bad address, `NOT_CONNECTED` when obexd or the
    /// phone can't be reached, `PERMISSION_DENIED` when the phone refuses
    /// (on iOS: allow "Sync Contacts" for this computer).
    #[napi(
        ts_args_type = "address: string, options?: PbapSessionOptions",
        ts_return_type = "Promise<PbapSession>"
    )]
    pub fn open(
        env: &Env,
        address: String,
        options: Option<PbapSessionOptions>,
    ) -> napi::Result<PromiseRaw<'_, PbapSession>> {
        let timeout = options.unwrap_or_default().transfer_timeout_ms;
        spawn_js(
            env,
            async move {
                let timeout = match timeout {
                    Some(0) => {
                        return Err(Error::new(
                            ErrorCode::InvalidInput,
                            "transferTimeoutMs must be positive.",
                        ));
                    }
                    other => other.map(|ms| Duration::from_millis(u64::from(ms))),
                };
                let mut session = pbap::PbapSession::open(&address).await?;
                if let Some(timeout) = timeout {
                    session.set_transfer_timeout(timeout);
                }
                Ok(session)
            },
            |session| PbapSession {
                inner: Arc::new(session),
            },
        )
    }

    /// The obexd session object path.
    #[napi(getter)]
    pub fn session_path(&self) -> String {
        self.inner.session_path().to_owned()
    }

    /// Whether `close()` was called.
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.inner.is_closed()
    }

    /// Pulls and parses the contacts (`pb`).
    #[napi(
        ts_args_type = "options?: PbapPullOptions",
        ts_return_type = "Promise<Array<ParsedVCard>>"
    )]
    pub fn pull_contacts<'env>(
        &self,
        env: &'env Env,
        options: Option<PbapPullOptions>,
    ) -> napi::Result<PromiseRaw<'env, Vec<ParsedVCard>>> {
        self.pull(env, "pb".to_owned(), options)
    }

    /// Pulls and parses one phonebook: contacts (`pb`), favourites (`fav`,
    /// marked `favorite`) or call history (`ich` incoming, `och` outgoing,
    /// `mch` missed, `cch` all).
    #[napi(
        ts_args_type = "phonebook: 'pb' | 'fav' | 'ich' | 'och' | 'mch' | 'cch', options?: PbapPullOptions",
        ts_return_type = "Promise<Array<ParsedVCard>>"
    )]
    pub fn pull<'env>(
        &self,
        env: &'env Env,
        phonebook_name: String,
        options: Option<PbapPullOptions>,
    ) -> napi::Result<PromiseRaw<'env, Vec<ParsedVCard>>> {
        let session = self.inner.clone();
        spawn_js(
            env,
            async move {
                let book = phonebook(Some(phonebook_name))?;
                let options = pull_options(options)?;
                session.pull(book, &options).await
            },
            |cards| cards.into_iter().map(ParsedVCard::from).collect(),
        )
    }

    /// How many entries a phonebook has (default `pb`).
    #[napi(
        ts_args_type = "phonebook?: 'pb' | 'fav' | 'ich' | 'och' | 'mch' | 'cch'",
        ts_return_type = "Promise<number>"
    )]
    pub fn size<'env>(
        &self,
        env: &'env Env,
        phonebook_name: Option<String>,
    ) -> napi::Result<PromiseRaw<'env, u32>> {
        let session = self.inner.clone();
        spawn_js(
            env,
            async move { session.size(phonebook(phonebook_name)?).await },
            u32::from,
        )
    }

    /// A phonebook's version properties (default `pb`): compare them with a
    /// stored copy to tell whether contacts changed.
    #[napi(
        ts_args_type = "phonebook?: 'pb' | 'fav' | 'ich' | 'och' | 'mch' | 'cch'",
        ts_return_type = "Promise<PhonebookVersion>"
    )]
    pub fn version<'env>(
        &self,
        env: &'env Env,
        phonebook_name: Option<String>,
    ) -> napi::Result<PromiseRaw<'env, PhonebookVersion>> {
        let session = self.inner.clone();
        spawn_js(
            env,
            async move { session.version(phonebook(phonebook_name)?).await },
            |v| PhonebookVersion {
                folder: v.folder,
                database_identifier: v.database_identifier,
                primary_counter: v.primary_counter,
                secondary_counter: v.secondary_counter,
            },
        )
    }

    /// Ends the session. Safe to call twice.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let session = self.inner.clone();
        spawn_js(env, async move { session.close().await }, |()| ())
    }
}

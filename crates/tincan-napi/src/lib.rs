//! Thin napi-rs bindings over `tincan-bt` and `tincan-vault` for
//! `@beyland/tincan-native`.
//!
//! Every export catches panics, and every failure reaches JS as an `Error`
//! whose `code` is a Tincan error code string (`INVALID_INPUT`,
//! `NOT_CONNECTED`, ..., `INTERNAL`).

mod ancs;
mod bluetooth;
pub mod log;
mod map;
mod notifier;
pub mod pbap;
mod vault;

use std::panic::{AssertUnwindSafe, catch_unwind};

use futures_util::FutureExt;
use napi::bindgen_prelude::{PromiseRaw, ToNapiValue};
use napi::{Env, JsError};
use napi_derive::napi;
use tincan_bt::{bluez, bmessage, vcard};

type JsResult<T> = std::result::Result<T, napi::Error<String>>;

/// Runs when Node loads the addon, on the JS thread: reads the time zone once
/// so MAP timestamps can later be converted on worker threads without
/// touching the environment (see `bmessage::init_local_time_zone`).
#[napi_derive::module_init]
fn init() {
    bmessage::init_local_time_zone();
}

/// A failure on its way to JS: a Tincan error code and a message.
struct Failure {
    code: &'static str,
    message: String,
}

impl From<tincan_bt::Error> for Failure {
    fn from(err: tincan_bt::Error) -> Self {
        Self {
            code: err.code().as_str(),
            message: err.message().to_string(),
        }
    }
}

impl From<tincan_vault::Error> for Failure {
    fn from(err: tincan_vault::Error) -> Self {
        Self {
            code: err.code().as_str(),
            // Secret Service and bus descriptions are copied verbatim by
            // `tincan-vault`; mask any device address on the way out, as
            // `tincan_bt::Error::new` does for Bluetooth errors.
            message: tincan_bt::redact::scrub(err.message()).into_owned(),
        }
    }
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn panicked() -> Self {
        Self::new("INTERNAL", "native code panicked")
    }

    fn into_napi(self) -> napi::Error<String> {
        napi::Error::new(self.code.to_string(), self.message)
    }

    /// A JS `Error` object with `code`, for results whose error status is a
    /// napi `Status` (promises, functions that call back into JS).
    fn into_js(self, env: &Env) -> napi::Error {
        napi::Error::from(JsError::from(self.into_napi()).into_unknown(*env))
    }
}

/// Runs `f`, turning a panic into an `INTERNAL` failure.
fn catch<T, E: Into<Failure>>(f: impl FnOnce() -> Result<T, E>) -> Result<T, Failure> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(Into::into),
        Err(_) => Err(Failure::panicked()),
    }
}

/// [`catch`] for a sync export.
fn guard_as<T, E: Into<Failure>>(f: impl FnOnce() -> Result<T, E>) -> JsResult<T> {
    catch(f).map_err(Failure::into_napi)
}

/// [`guard_as`] for `tincan-bt` results.
fn guard<T>(f: impl FnOnce() -> tincan_bt::Result<T>) -> JsResult<T> {
    guard_as(f)
}

/// `tokio::spawn` for a long-running forwarding task: a panic inside it is
/// logged (without its payload) instead of silently ending the events.
fn spawn_logged<F>(task: &'static str, future: F) -> tokio::task::JoinHandle<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        if AssertUnwindSafe(future).catch_unwind().await.is_err() {
            tracing::error!(task, "native background task panicked; its events stop");
        }
    })
}

/// Runs `future` on the addon's Tokio runtime and settles a promise with
/// `convert` of its value. A failure or panic rejects with an `Error` whose
/// `code` is the Tincan error code.
fn spawn_js<'env, T, E, V>(
    env: &'env Env,
    future: impl Future<Output = Result<T, E>> + Send + 'static,
    convert: impl FnOnce(T) -> V + 'static,
) -> napi::Result<PromiseRaw<'env, V>>
where
    T: Send + 'static,
    E: Into<Failure> + Send + 'static,
    V: ToNapiValue,
{
    // The future never fails at the napi level: its result is carried to the
    // callback, which runs on the JS thread and can build an error object
    // with a custom `code` (the future's own error type cannot).
    let future = AssertUnwindSafe(future).catch_unwind().map(|outcome| {
        Ok(match outcome {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(Failure::panicked()),
        })
    });
    env.spawn_future_with_callback(future, move |env, outcome| match outcome {
        Ok(value) => catch_unwind(AssertUnwindSafe(|| convert(value)))
            .map_err(|_| Failure::panicked().into_js(env)),
        Err(failure) => Err(failure.into_js(env)),
    })
}

/// The `tincan-napi` crate version.
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A bMessage vCard party. Only `tel` and `email` identify it.
#[napi(object)]
pub struct Party {
    pub name: String,
    pub tel: String,
    pub email: String,
}

impl From<bmessage::Party> for Party {
    fn from(p: bmessage::Party) -> Self {
        Self {
            name: p.name,
            tel: p.tel,
            email: p.email,
        }
    }
}

/// A parsed bMessage. Parsing never fails; `valid` is false when the input
/// had no `BEGIN:BMSG`.
#[napi(object)]
pub struct ParsedBMessage {
    pub valid: bool,
    pub version: String,
    pub read: bool,
    /// Always `SMS_GSM` from an iPhone, for SMS and iMessage alike.
    #[napi(js_name = "type")]
    pub msg_type: String,
    pub folder: String,
    pub originator: Party,
    pub recipients: Vec<Party>,
    /// Every MSG part joined with `\n`, decoded.
    pub body: String,
    pub parts: Vec<String>,
    pub charset: String,
    pub encoding: String,
    pub language: String,
    pub length: Option<f64>,
    /// The conversation key of the originator (`tel:+1555…`, `email:…`), or
    /// an empty string when the originator is empty (e.g. a sent message).
    pub thread_key: String,
}

impl From<bmessage::BMessage> for ParsedBMessage {
    fn from(m: bmessage::BMessage) -> Self {
        let thread_key = if m.originator.is_empty() {
            String::new()
        } else {
            bmessage::thread_key_for(&m.originator)
        };
        Self {
            valid: m.valid,
            version: m.version,
            read: m.read,
            msg_type: m.msg_type,
            folder: m.folder,
            originator: m.originator.into(),
            recipients: m.recipients.into_iter().map(Party::from).collect(),
            body: m.body,
            parts: m.parts,
            charset: m.charset,
            encoding: m.encoding,
            language: m.language,
            length: m.length.map(|n| n as f64),
            thread_key,
        }
    }
}

#[napi(object)]
pub struct TypedValue {
    pub value: String,
    /// Lower-case TYPE parameters (`cell`, `home`, `pref`, ...).
    pub types: Vec<String>,
}

impl From<vcard::TypedValue> for TypedValue {
    fn from(v: vcard::TypedValue) -> Self {
        Self {
            value: v.value,
            types: v.types,
        }
    }
}

#[napi(object)]
pub struct Photo {
    pub media_type: String,
    /// Base64 data (empty when the photo is a `uri`).
    pub data: String,
    pub uri: String,
}

#[napi(object)]
pub struct ParsedVCard {
    pub version: String,
    pub name: String,
    pub family: String,
    pub given: String,
    pub tels: Vec<TypedValue>,
    pub emails: Vec<TypedValue>,
    pub photo: Option<Photo>,
    /// `X-IRMC-CALL-DATETIME` type (`MISSED`, `RECEIVED`, `DIALED`), or empty.
    pub call_type: String,
    pub call_time: String,
    pub favorite: bool,
    pub nickname: String,
    pub organization: String,
    pub department: String,
    pub title: String,
    pub birthday: String,
    pub note: String,
    /// Formatted addresses, lines joined with `\n`.
    pub addresses: Vec<TypedValue>,
    pub urls: Vec<TypedValue>,
}

impl From<vcard::VCard> for ParsedVCard {
    fn from(c: vcard::VCard) -> Self {
        Self {
            version: c.version,
            name: c.name,
            family: c.family,
            given: c.given,
            tels: c.tels.into_iter().map(TypedValue::from).collect(),
            emails: c.emails.into_iter().map(TypedValue::from).collect(),
            photo: c.photo.map(|p| Photo {
                media_type: p.media_type,
                data: p.data,
                uri: p.uri,
            }),
            call_type: c.call_type,
            call_time: c.call_time,
            favorite: c.favorite,
            nickname: c.nickname,
            organization: c.organization,
            department: c.department,
            title: c.title,
            birthday: c.birthday,
            note: c.note,
            addresses: c.addresses.into_iter().map(TypedValue::from).collect(),
            urls: c.urls.into_iter().map(TypedValue::from).collect(),
        }
    }
}

/// Parses a bMessage (MAP `GetMessage` payload). Tolerant: never throws for
/// malformed input; check `valid`.
#[napi(js_name = "parseBMessage")]
pub fn parse_bmessage(text: String) -> napi::Result<ParsedBMessage, String> {
    guard(|| Ok(bmessage::parse_bmessage(&text).into()))
}

/// Parses a vCard 2.1/3.0 document holding any number of cards.
#[napi(js_name = "parseVCards")]
pub fn parse_vcards(text: String) -> napi::Result<Vec<ParsedVCard>, String> {
    guard(|| {
        Ok(vcard::parse_vcards(&text)
            .into_iter()
            .map(ParsedVCard::from)
            .collect())
    })
}

/// Builds an outgoing bMessage for MAP `PushMessage`. A recipient containing
/// `@` is an Apple ID email, anything else a phone number. Throws
/// `INVALID_INPUT` for an empty or malformed recipient list.
#[napi(js_name = "buildBMessage")]
pub fn build_bmessage(recipients: Vec<String>, body: String) -> napi::Result<String, String> {
    guard(|| {
        let recipients = recipients
            .iter()
            .map(|r| bmessage::recipient_from_input(r))
            .collect::<tincan_bt::Result<Vec<_>>>()?;
        bmessage::build_bmessage(&recipients, &body)
    })
}

/// The conversation key for an address: `tel:<normalised number>` or
/// `email:<lower-cased address>`. Throws `INVALID_INPUT` for an invalid one.
#[napi]
pub fn thread_key_for(address: String) -> napi::Result<String, String> {
    guard(|| Ok(bmessage::recipient_from_input(&address)?.thread_key()))
}

#[napi(object)]
pub struct AdapterInfo {
    pub path: String,
    pub address: String,
    pub name: String,
    pub alias: String,
    pub powered: bool,
    pub discoverable: bool,
    pub pairable: bool,
    pub discovering: bool,
    /// Class of Device, when BlueZ reports one.
    pub class: Option<u32>,
}

#[napi(object)]
pub struct BtDevice {
    pub path: String,
    /// Object path of the adapter the device belongs to.
    pub adapter: String,
    pub address: String,
    pub name: Option<String>,
    pub alias: String,
    pub icon: Option<String>,
    pub class: Option<u32>,
    pub modalias: Option<String>,
    pub paired: bool,
    pub bonded: bool,
    pub trusted: bool,
    pub blocked: bool,
    pub connected: bool,
    /// Lower-case 128-bit service UUIDs.
    pub uuids: Vec<String>,
    pub is_iphone: bool,
    /// Advertises the MAP Message Server Equipment (0x1132).
    pub supports_map: bool,
    /// Advertises the PBAP Phonebook Server Equipment (0x112f).
    pub supports_pbap: bool,
    pub supports_ancs: bool,
}

#[napi(object)]
pub struct BluetoothSnapshot {
    pub adapters: Vec<AdapterInfo>,
    pub devices: Vec<BtDevice>,
}

impl From<bluez::Adapter> for AdapterInfo {
    fn from(a: bluez::Adapter) -> Self {
        Self {
            path: a.path,
            address: a.address,
            name: a.name,
            alias: a.alias,
            powered: a.powered,
            discoverable: a.discoverable,
            pairable: a.pairable,
            discovering: a.discovering,
            class: a.class,
        }
    }
}

impl From<bluez::Device> for BtDevice {
    fn from(d: bluez::Device) -> Self {
        Self {
            path: d.path,
            adapter: d.adapter,
            address: d.address,
            name: d.name,
            alias: d.alias,
            icon: d.icon,
            class: d.class,
            modalias: d.modalias,
            paired: d.paired,
            bonded: d.bonded,
            trusted: d.trusted,
            blocked: d.blocked,
            connected: d.connected,
            uuids: d.uuids,
            is_iphone: d.is_iphone,
            supports_map: d.supports_map,
            supports_pbap: d.supports_pbap,
            supports_ancs: d.supports_ancs,
        }
    }
}

impl From<bluez::Snapshot> for BluetoothSnapshot {
    fn from(s: bluez::Snapshot) -> Self {
        Self {
            adapters: s.adapters.into_iter().map(Into::into).collect(),
            devices: s.devices.into_iter().map(Into::into).collect(),
        }
    }
}

/// Reads BlueZ adapters and devices from the system bus (one read-only
/// `GetManagedObjects` call). Rejects with `NOT_CONNECTED` when the bus or
/// BlueZ is unavailable.
#[napi(ts_return_type = "Promise<BluetoothSnapshot>")]
pub fn bluetooth_snapshot(env: &Env) -> napi::Result<PromiseRaw<'_, BluetoothSnapshot>> {
    spawn_js(env, bluez::snapshot(), BluetoothSnapshot::from)
}

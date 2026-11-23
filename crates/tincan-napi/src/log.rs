//! Forwards the native layer's `tracing` events to a JS callback, so the
//! daemon logs them with its own logger. Values that could identify people
//! are already redacted where they're logged (see `tincan_bt::redact`), and
//! Bluetooth addresses in any record's text (zbus and BlueZ messages quote
//! object paths such as `/org/bluez/hci0/dev_AA_BB_…`) are masked here.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use napi::Status;

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tracing::field::{Field, Visit};
use tracing::subscriber::Interest;
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

use crate::guard;
use tincan_bt::{Error, ErrorCode};

/// One native log event.
#[napi(object)]
pub struct LogRecord {
    #[napi(ts_type = "'error' | 'warn' | 'info' | 'debug' | 'trace'")]
    pub level: String,
    /// The Rust module that logged it, e.g. `tincan_bt::supervisor`.
    pub target: String,
    pub message: String,
    /// Structured fields, formatted as text.
    pub fields: HashMap<String, String>,
}

type LogCallback = ThreadsafeFunction<LogRecord, (), LogRecord, Status, false, true>;

/// The JS callback, and the most verbose level forwarded (0 = off, 1 =
/// error … 5 = trace).
static SINK: RwLock<Option<Arc<LogCallback>>> = RwLock::new(None);
static MAX_LEVEL: AtomicU8 = AtomicU8::new(0);
static INSTALLED: OnceLock<bool> = OnceLock::new();

fn rank(level: &Level) -> u8 {
    match *level {
        Level::ERROR => 1,
        Level::WARN => 2,
        Level::INFO => 3,
        Level::DEBUG => 4,
        Level::TRACE => 5,
    }
}

fn parse_level(level: Option<&str>) -> Option<u8> {
    match level.unwrap_or("info") {
        "error" => Some(1),
        "warn" => Some(2),
        "info" => Some(3),
        "debug" => Some(4),
        "trace" => Some(5),
        _ => None,
    }
}

/// Tincan's own crates log at the chosen level; dependencies (zbus, …) only
/// warnings and errors, since their debug output can include message
/// contents.
fn wanted(metadata: &Metadata<'_>) -> bool {
    let max = MAX_LEVEL.load(Ordering::Relaxed);
    let own = metadata.target().starts_with("tincan_");
    let limit = if own { max } else { max.min(2) };
    rank(metadata.level()) <= limit
}

struct JsLayer;

impl<S: Subscriber> Layer<S> for JsLayer {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn enabled(&self, metadata: &Metadata<'_>, _: Context<'_, S>) -> bool {
        wanted(metadata)
    }

    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let Some(sink) = SINK.read().ok().and_then(|sink| sink.clone()) else {
            return;
        };
        let metadata = event.metadata();
        let mut fields = Fields::default();
        event.record(&mut fields);
        let record = LogRecord {
            level: metadata.level().as_str().to_ascii_lowercase(),
            target: metadata.target().to_string(),
            message: fields.message,
            fields: fields.rest,
        };
        sink.call(record, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[derive(Default)]
struct Fields {
    message: String,
    rest: HashMap<String, String>,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }
}

impl Fields {
    fn put(&mut self, field: &Field, value: String) {
        let value = match tincan_bt::redact::scrub(&value) {
            std::borrow::Cow::Owned(scrubbed) => scrubbed,
            std::borrow::Cow::Borrowed(_) => value,
        };
        if field.name() == "message" {
            self.message = value;
        } else {
            self.rest.insert(field.name().to_string(), value);
        }
    }
}

/// Sends native log events at `level` (default `info`) and above to
/// `onLog`, replacing any earlier logger; `null` stops them. Dependencies
/// only report warnings and errors. Doesn't keep Node running. Message
/// text, phone numbers, names and device addresses are redacted unless the
/// process started with `TINCAN_LOG_SENSITIVE=1`.
#[napi(
    ts_args_type = "onLog: ((record: LogRecord) => void) | null, level?: 'error' | 'warn' | 'info' | 'debug' | 'trace'"
)]
pub fn set_logger(on_log: Option<LogCallback>, level: Option<String>) -> napi::Result<(), String> {
    guard(|| {
        let max = parse_level(level.as_deref())
            .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Unknown log level."))?;
        let installed = *INSTALLED.get_or_init(|| {
            tracing::subscriber::set_global_default(tracing_subscriber::registry().with(JsLayer))
                .is_ok()
        });
        if !installed {
            return Err(Error::new(
                ErrorCode::Internal,
                "Another tracing subscriber is installed.",
            ));
        }
        let mut sink = SINK
            .write()
            .map_err(|_| Error::new(ErrorCode::Internal, "Logger lock poisoned."))?;
        MAX_LEVEL.store(if on_log.is_some() { max } else { 0 }, Ordering::Relaxed);
        *sink = on_log.map(Arc::new);
        Ok(())
    })
}

//! Redaction for log fields. Message text, phone numbers, contact names and
//! device addresses go into `tracing` events only through these wrappers,
//! which hide them unless `TINCAN_LOG_SENSITIVE=1` was set when the process
//! first logged one.
//!
//! ```
//! # let body = "hi"; let address = "AA:BB:CC:DD:EE:FF";
//! use tincan_bt::redact;
//! tracing::debug!(body = %redact::text(body), phone = %redact::address(address), "pushing");
//! ```

use std::borrow::Cow;
use std::fmt;
use std::sync::OnceLock;

/// The environment variable that turns redaction off.
pub const SENSITIVE_ENV: &str = "TINCAN_LOG_SENSITIVE";

/// Whether sensitive values are logged as they are. Read once from
/// [`SENSITIVE_ENV`]; only the exact value `1` reveals them.
pub fn sensitive() -> bool {
    static SENSITIVE: OnceLock<bool> = OnceLock::new();
    *SENSITIVE.get_or_init(|| std::env::var_os(SENSITIVE_ENV).is_some_and(|v| v == "1"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Phone,
    Name,
    Address,
}

/// A value shown by `Display` and `Debug` only when [`sensitive`] is on.
#[derive(Clone, Copy)]
pub struct Redacted<'a> {
    kind: Kind,
    value: &'a str,
    reveal: bool,
}

/// Message text: redacted to its length in characters.
pub fn text(value: &str) -> Redacted<'_> {
    Redacted::new(Kind::Text, value)
}

/// A phone number or email address: fully redacted.
pub fn phone(value: &str) -> Redacted<'_> {
    Redacted::new(Kind::Phone, value)
}

/// A contact or sender name: fully redacted.
pub fn name(value: &str) -> Redacted<'_> {
    Redacted::new(Kind::Name, value)
}

/// A Bluetooth address: redacted to its last two octets.
pub fn address(value: &str) -> Redacted<'_> {
    Redacted::new(Kind::Address, value)
}

impl<'a> Redacted<'a> {
    fn new(kind: Kind, value: &'a str) -> Self {
        Self {
            kind,
            value,
            reveal: sensitive(),
        }
    }

    /// Overrides the environment, for tests and for callers with their own
    /// setting.
    pub fn reveal(self, reveal: bool) -> Self {
        Self { reveal, ..self }
    }
}

impl fmt::Display for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.reveal {
            return f.write_str(self.value);
        }
        match self.kind {
            Kind::Text => write!(f, "[text: {} chars]", self.value.chars().count()),
            Kind::Phone if self.value.is_empty() => f.write_str("[no phone]"),
            Kind::Phone => f.write_str("[phone]"),
            Kind::Name if self.value.is_empty() => f.write_str("[no name]"),
            Kind::Name => f.write_str("[name]"),
            Kind::Address => {
                let octets: Vec<&str> = self.value.split(':').collect();
                let well_formed = octets.len() == 6
                    && octets
                        .iter()
                        .all(|o| o.len() == 2 && o.bytes().all(|b| b.is_ascii_hexdigit()));
                if well_formed {
                    write!(f, "…:{}:{}", octets[4], octets[5])
                } else {
                    f.write_str("[address]")
                }
            }
        }
    }
}

impl fmt::Debug for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.reveal {
            fmt::Debug::fmt(self.value, f)
        } else {
            fmt::Display::fmt(self, f)
        }
    }
}

/// Masks every Bluetooth address in free text (D-Bus error descriptions,
/// third-party log lines) to its last two octets, unless [`sensitive`] is on.
/// Matches `AA:BB:CC:DD:EE:FF`, and the `AA_BB_…` form in BlueZ object paths
/// (`/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF` → `dev_…_EE_FF`).
pub fn scrub(text: &str) -> Cow<'_, str> {
    if sensitive() {
        Cow::Borrowed(text)
    } else {
        scrub_addresses(text)
    }
}

/// [`scrub`] regardless of [`sensitive`].
pub fn scrub_addresses(text: &str) -> Cow<'_, str> {
    const LEN: usize = 17;
    let bytes = text.as_bytes();
    let is_address_at = |i: usize| -> bool {
        let Some(window) = bytes.get(i..i + LEN) else {
            return false;
        };
        let sep = window[2];
        if !matches!(sep, b':' | b'_' | b'-') {
            return false;
        }
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let after_ok = bytes
            .get(i + LEN)
            .is_none_or(|b| !b.is_ascii_alphanumeric());
        before_ok
            && after_ok
            && window.iter().enumerate().all(|(j, &b)| {
                if j % 3 == 2 {
                    b == sep
                } else {
                    b.is_ascii_hexdigit()
                }
            })
    };
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    while i + LEN <= bytes.len() {
        if is_address_at(i) {
            let out = out.get_or_insert_with(|| String::with_capacity(text.len()));
            // The match is ASCII, so these are char boundaries.
            out.push_str(&text[copied..i]);
            let sep = char::from(bytes[i + 2]);
            out.push('…');
            out.push(sep);
            out.push_str(&text[i + 12..i + 14]);
            out.push(sep);
            out.push_str(&text[i + 15..i + LEN]);
            i += LEN;
            copied = i;
        } else {
            i += 1;
        }
    }
    match out {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hidden(r: Redacted<'_>) -> (String, String) {
        let r = r.reveal(false);
        (r.to_string(), format!("{r:?}"))
    }

    #[test]
    fn hides_text_phones_and_names() {
        assert_eq!(hidden(text("héllo 👋")).0, "[text: 7 chars]");
        assert_eq!(hidden(text("")).0, "[text: 0 chars]");
        assert_eq!(hidden(phone("+15555550100")).0, "[phone]");
        assert_eq!(hidden(phone("")).0, "[no phone]");
        assert_eq!(hidden(name("Ada Lovelace")).0, "[name]");
        assert_eq!(hidden(name("")).0, "[no name]");
        let (display, debug) = hidden(phone("+15555550100"));
        assert_eq!(display, debug);
        assert!(!debug.contains("555"));
    }

    #[test]
    fn keeps_two_octets_of_an_address() {
        assert_eq!(hidden(address("AA:BB:CC:DD:EE:0f")).0, "…:EE:0f");
        assert_eq!(hidden(address("not an address")).0, "[address]");
        assert_eq!(hidden(address("AA:BB:CC:DD:EE:FG")).0, "[address]");
    }

    #[test]
    fn reveals_on_request() {
        let r = text("hi \"there\"").reveal(true);
        assert_eq!(r.to_string(), "hi \"there\"");
        assert_eq!(format!("{r:?}"), "\"hi \\\"there\\\"\"");
        assert_eq!(
            address("AA:BB:CC:DD:EE:FF").reveal(true).to_string(),
            "AA:BB:CC:DD:EE:FF"
        );
    }

    #[test]
    fn follows_the_environment() {
        let expected = std::env::var_os(SENSITIVE_ENV).is_some_and(|v| v == "1");
        assert_eq!(sensitive(), expected);
        assert_eq!(phone("+15555550100").reveal, expected);
    }

    #[test]
    fn scrubs_addresses_in_free_text() {
        assert_eq!(
            scrub_addresses(
                "Method failed on /org/bluez/hci0/dev_AA_BB_CC_DD_EE_0F/service0012: busy"
            ),
            "Method failed on /org/bluez/hci0/dev_…_EE_0F/service0012: busy"
        );
        assert_eq!(
            scrub_addresses("AA:BB:CC:DD:EE:FF and 11-22-33-44-55-66."),
            "…:EE:FF and …-55-66."
        );
        assert_eq!(scrub_addresses("dev_aa_bb_cc_dd_ee_ff"), "dev_…_ee_ff");
        // Not addresses: mixed separators, longer hex runs, UUIDs, plain text.
        for text in [
            "AA:BB_CC:DD:EE:FF",
            "AAA:BB:CC:DD:EE:FF",
            "AA:BB:CC:DD:EE:FFF",
            "0000180f-0000-1000-8000-00805f9b34fb",
            "héllo AA:BB:CC:DD:EE",
            "",
        ] {
            assert_eq!(scrub_addresses(text), text, "{text}");
        }
        assert!(matches!(scrub_addresses("nothing here"), Cow::Borrowed(_)));
        assert_eq!(scrub_addresses("é AA:BB:CC:DD:EE:FF é"), "é …:EE:FF é");
    }
}

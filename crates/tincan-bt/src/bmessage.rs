//! bMessage (Bluetooth MAP 1.x §3.1.3) parsing and building, plus the address
//! identity rules that decide which conversation a message belongs to.

use serde::Serialize;

use crate::error::{Error, Result};
use crate::vcard;

/// A party from a bMessage vCard. Only `tel` and `email` identify it; `name`
/// is for display.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub name: String,
    pub tel: String,
    pub email: String,
}

impl Party {
    pub fn is_empty(&self) -> bool {
        self.tel.is_empty() && self.email.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BMessage {
    /// False when the input had no `BEGIN:BMSG`. Parsing never fails.
    pub valid: bool,
    pub version: String,
    /// STATUS:READ as reported by the phone.
    pub read: bool,
    /// Always SMS_GSM from an iPhone, for SMS and iMessage alike.
    #[serde(rename = "type")]
    pub msg_type: String,
    pub folder: String,
    pub originator: Party,
    pub recipients: Vec<Party>,
    /// Every MSG part joined with '\n', decoded, without trailing line breaks.
    pub body: String,
    /// Each `BEGIN:MSG`..`END:MSG` block on its own, decoded the same way.
    pub parts: Vec<String>,
    /// The BBODY properties, as written (empty when absent).
    pub charset: String,
    pub encoding: String,
    pub language: String,
    pub length: Option<u64>,
}

fn upper(text: &str) -> String {
    text.to_ascii_uppercase()
}

/// Splits on CRLF, LF or a bare CR. Text ending in a line break yields a final
/// empty line.
pub fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                lines.push(&text[start..i]);
                i += if bytes.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = i;
            }
            b'\n' => {
                lines.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    lines.push(&text[start..]);
    lines
}

/// True when a body line, ignoring leading spaces or tabs, would read as a
/// structural token and therefore needs byte-stuffing.
fn is_stuffable_token_bytes(line: &[u8]) -> bool {
    let mut rest = line;
    while let Some(b' ' | b'\t') = rest.first() {
        rest = &rest[1..];
    }
    rest.len() >= 6 && rest[..6].eq_ignore_ascii_case(b"BEGIN:")
        || rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(b"END:")
}

fn is_stuffable_token(line: &str) -> bool {
    is_stuffable_token_bytes(line.as_bytes())
}

fn unstuff_bytes(line: &[u8]) -> &[u8] {
    if line.starts_with(b" ") && is_stuffable_token_bytes(line) {
        &line[1..]
    } else {
        line
    }
}

fn trim_ascii_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        .map_or(start, |i| i + 1);
    &bytes[start..end]
}

/// iOS writes some addresses with a two-character scheme tag ("7:", "e:").
fn strip_scheme_tag(value: &str) -> &str {
    if value.len() > 2 && value.as_bytes()[1] == b':' {
        &value[2..]
    } else {
        value
    }
}

fn read_vcard_bytes(lines: &[&[u8]], at: &mut usize) -> Party {
    let mut logical: Vec<String> = Vec::new();
    while *at < lines.len() {
        let raw_bytes = lines[*at];
        *at += 1;
        let raw = String::from_utf8_lossy(raw_bytes);
        if upper(vcard::trim(&raw)) == "END:VCARD" {
            break;
        }
        match logical.last_mut() {
            Some(last) if raw.starts_with([' ', '\t']) => last.push_str(&raw[1..]),
            _ => logical.push(raw.into_owned()),
        }
    }

    let mut party = Party::default();
    let mut structured_name = String::new();
    for line in &logical {
        let Some(property) = vcard::parse_property(vcard::trim(line)) else {
            continue;
        };
        if property.value.is_empty() {
            continue;
        }
        let value = property.text();
        let value = vcard::trim(&value);
        match property.name.as_str() {
            "TEL" if party.tel.is_empty() => party.tel = strip_scheme_tag(value).to_string(),
            "EMAIL" if party.email.is_empty() => party.email = strip_scheme_tag(value).to_string(),
            "FN" => party.name = vcard::unescape(value),
            "N" => structured_name = vcard::name_from_n(value),
            _ => {}
        }
    }
    if party.name.is_empty() {
        party.name = structured_name;
    }
    party
}

fn decode_body_bytes(bytes: &[u8], encoding: &str, charset: &str) -> String {
    let charset = (!charset.is_empty()).then_some(charset);
    match upper(encoding).as_str() {
        "QUOTED-PRINTABLE" => {
            let ascii = String::from_utf8_lossy(bytes);
            vcard::decode_charset(&vcard::decode_quoted_printable(&ascii), charset)
        }
        "BASE64" => {
            let ascii = String::from_utf8_lossy(bytes);
            match vcard::decode_base64(&ascii) {
                Some(decoded) => vcard::decode_charset(&decoded, charset),
                None => vcard::decode_charset(bytes, charset),
            }
        }
        _ => vcard::decode_charset(bytes, charset),
    }
}

fn strip_trailing_breaks(text: &str) -> &str {
    text.trim_end_matches(['\n', '\r'])
}

/// Tolerant parser: accepts CRLF, LF or CR, missing optional fields, unknown
/// properties and truncated input. Never fails; check `valid`.
pub fn parse_bmessage(text: &str) -> BMessage {
    parse_bmessage_bytes(text.as_bytes())
}

/// Splits on CRLF, LF or a bare CR, returning `(line_slice, consumed_len_with_linebreak)`.
fn split_byte_lines_with_len(bytes: &[u8]) -> Vec<(&[u8], usize)> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                let brk = if bytes.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                lines.push((&bytes[start..i], (i - start) + brk));
                i += brk;
                start = i;
            }
            b'\n' => {
                lines.push((&bytes[start..i], (i - start) + 1));
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    lines.push((&bytes[start..], bytes.len() - start));
    lines
}

fn is_unindented_end_msg(line: &[u8]) -> bool {
    !line.starts_with(b" ")
        && !line.starts_with(b"\t")
        && trim_ascii_bytes(line).eq_ignore_ascii_case(b"END:MSG")
}

/// True when the line after an `END:MSG` starts another body part: a new
/// `BEGIN:MSG`, or the `LENGTH:` that precedes one.
fn starts_next_part(line: Option<&[u8]>) -> bool {
    let Some(line) = line else {
        return false;
    };
    let line = trim_ascii_bytes(line);
    line.eq_ignore_ascii_case(b"BEGIN:MSG")
        || line.len() >= 7 && line[..7].eq_ignore_ascii_case(b"LENGTH:")
}

/// Parses raw bMessage bytes, decoding the `BEGIN:MSG` body according to its
/// declared `ENCODING` and `CHARSET` rather than assuming UTF-8 up front.
///
/// Body termination does not trust an unstuffed `END:MSG` inside the body
/// (iOS does not byte-stuff): with `LENGTH`, an `END:MSG` before the declared
/// length ends the body only when no later `END:MSG` exists; without it, an
/// `END:MSG` ends the body only when it is the last one in the input or the
/// next line starts another part. vCards after the first `BEGIN:BBODY` or
/// `BEGIN:MSG` are never read as parties, so body text cannot add recipients.
pub fn parse_bmessage_bytes(bytes: &[u8]) -> BMessage {
    let mut message = BMessage::default();
    let lines_with_len = split_byte_lines_with_len(bytes);
    let lines: Vec<&[u8]> = lines_with_len.iter().map(|(l, _)| *l).collect();
    // One pass up front, so deciding whether an `END:MSG` is final stays O(1)
    // per line (a per-line forward scan made newline-heavy bodies quadratic).
    let last_end = lines.iter().rposition(|l| is_unindented_end_msg(l));

    let mut seen_begin = false;
    let mut seen_msg = false;
    let mut seen_body = false;
    let mut depth: u32 = 0;
    let mut in_body = false;
    let mut in_msg = false;
    let mut msg_bytes_seen: usize = 0;
    let mut body_lines: Vec<&[u8]> = Vec::new();
    let mut part_lines: Vec<&[u8]> = Vec::new();
    let mut raw_parts: Vec<Vec<&[u8]>> = Vec::new();

    let mut i = 0;
    while i < lines_with_len.len() {
        let (raw, raw_len) = lines_with_len[i];
        let at = i;
        i += 1;

        if in_msg {
            let is_last_end = last_end == Some(at);
            let ends_part = is_unindented_end_msg(raw)
                && match message.length {
                    // MAP 1.x §3.1.3: LENGTH covers `BEGIN:MSG\r\n` + body +
                    // `END:MSG\r\n`. Ignore an early `END:MSG` while a later
                    // unindented one exists.
                    Some(declared) => (msg_bytes_seen + raw_len) as u64 >= declared || is_last_end,
                    None => is_last_end || starts_next_part(lines.get(i).copied()),
                };
            if ends_part {
                in_msg = false;
                raw_parts.push(std::mem::take(&mut part_lines));
                continue;
            }
            msg_bytes_seen += raw_len;
            let line = unstuff_bytes(raw);
            body_lines.push(line);
            part_lines.push(line);
            continue;
        }

        let line_cow = String::from_utf8_lossy(raw);
        let line = vcard::trim(&line_cow);
        let token = upper(line);
        match token.as_str() {
            "BEGIN:BMSG" => seen_begin = true,
            "END:BMSG" => break,
            "BEGIN:BENV" => depth += 1,
            "END:BENV" => depth = depth.saturating_sub(1),
            "BEGIN:BBODY" => {
                in_body = true;
                seen_body = true;
            }
            "END:BBODY" => in_body = false,
            "BEGIN:MSG" => {
                in_msg = true;
                seen_msg = true;
                msg_bytes_seen = raw_len;
            }
            "BEGIN:VCARD" => {
                let party = read_vcard_bytes(&lines, &mut i);
                // Parties live in the envelope, before any body.
                if seen_body || seen_msg {
                    continue;
                }
                if depth == 0 {
                    if message.originator.is_empty() {
                        message.originator = party;
                    }
                } else if !party.is_empty() {
                    message.recipients.push(party);
                }
            }
            _ => {
                // Never allow anything after a message body to overwrite envelope/body metadata.
                if seen_msg {
                    continue;
                }
                let Some((name, value)) = vcard::split_property(line) else {
                    continue;
                };
                if in_body {
                    match name.as_str() {
                        "CHARSET" if message.charset.is_empty() => message.charset = value,
                        "ENCODING" if message.encoding.is_empty() => message.encoding = value,
                        "LANGUAGE" if message.language.is_empty() => message.language = value,
                        "LENGTH" if message.length.is_none() => message.length = value.parse().ok(),
                        _ => {}
                    }
                } else {
                    match name.as_str() {
                        "STATUS" => message.read = upper(&value) == "READ",
                        "TYPE" if message.msg_type.is_empty() => message.msg_type = value,
                        "FOLDER" if message.folder.is_empty() => message.folder = value,
                        "VERSION" if depth == 0 && message.version.is_empty() => {
                            message.version = value
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    if in_msg {
        raw_parts.push(part_lines);
    }

    let decode = |lines: &[&[u8]]| {
        let joined = lines.join(&b'\n');
        let decoded = decode_body_bytes(&joined, &message.encoding, &message.charset);
        strip_trailing_breaks(&decoded).to_string()
    };
    message.body = decode(&body_lines);
    message.parts = raw_parts.iter().map(|p| decode(p)).collect();
    message.valid = seen_begin;
    message
}

// --- Identity --------------------------------------------------------------

/// Digits, plus a leading '+' when it is the first non-space character. Never
/// invents a country code.
pub fn normalize_phone(raw: &str) -> String {
    let mut out = String::new();
    let mut only_spaces = true;
    for c in raw.chars() {
        if c.is_ascii_digit() || (c == '+' && only_spaces && out.is_empty()) {
            out.push(c);
        }
        if !c.is_whitespace() {
            only_spaces = false;
        }
    }
    out
}

pub fn normalize_email(raw: &str) -> String {
    vcard::trim(raw).to_lowercase()
}

/// The conversation a party belongs to: `sender:<id>` for an alphanumeric
/// sender, `tel:<normalized>`, or `email:<normalized>`; empty when there is no
/// usable address.
pub fn thread_key_for(party: &Party) -> String {
    if !party.tel.is_empty() {
        if party.tel.chars().any(|c| c.is_ascii_alphabetic()) {
            let id: String = party
                .tel
                .chars()
                .filter(|&c| c > ' ' && c != '\x7f')
                .map(|c| c.to_ascii_lowercase())
                .collect();
            if !id.is_empty() {
                return format!("sender:{id}");
            }
        }
        let tel = normalize_phone(&party.tel);
        if !tel.is_empty() {
            return format!("tel:{tel}");
        }
    }
    if !party.email.is_empty() {
        let email = normalize_email(&party.email);
        if !email.is_empty() {
            return format!("email:{email}");
        }
    }
    String::new()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How a party's address is shown: the normalized number or email.
pub fn display_address(party: &Party) -> String {
    if party.tel.is_empty() {
        return normalize_email(&party.email);
    }
    let tel = normalize_phone(&party.tel);
    if tel.is_empty() {
        collapse_whitespace(&party.tel)
    } else {
        tel
    }
}

/// Short codes and alphanumeric senders cannot receive replies.
pub fn is_short_code(thread_key: &str) -> bool {
    if thread_key.starts_with("sender:") {
        return true;
    }
    thread_key.starts_with("tel:")
        && thread_key.len() > 4
        && thread_key.len() <= 10
        && thread_key.as_bytes()[4] != b'+'
}

const TEL_SUFFIX_DIGITS: usize = 9;

/// The last nine digits of a number, or empty when it has fewer.
pub fn tel_suffix(raw: &str) -> String {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < TEL_SUFFIX_DIGITS {
        String::new()
    } else {
        digits[digits.len() - TEL_SUFFIX_DIGITS..].to_string()
    }
}

/// Groups `tel:` keys that differ only by country code or trunk prefix.
pub fn thread_bucket(thread_key: &str) -> String {
    let Some(number) = thread_key.strip_prefix("tel:") else {
        return thread_key.to_string();
    };
    let mut suffix = tel_suffix(number);
    if suffix.is_empty() {
        suffix = number.chars().filter(char::is_ascii_digit).collect();
    }
    if suffix.is_empty() {
        thread_key.to_string()
    } else {
        format!("tel:{suffix}")
    }
}

/// The trailing id of an obexd message object path. The session number in the
/// prefix changes on every reconnect; the id does not.
pub fn map_handle_from_path(object_path: &str) -> String {
    let tail = object_path
        .rsplit_once('/')
        .map_or(object_path, |(_, tail)| tail);
    let tail = tail.strip_prefix("message").unwrap_or(tail);
    if tail.is_empty() {
        object_path.to_string()
    } else {
        tail.to_string()
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

static TIME_ZONE_INIT: std::sync::Once = std::sync::Once::new();

/// Reads the time zone (`TZ`, else `/etc/localtime`) into libc's global state.
///
/// Call this once from the thread that owns the process environment (the
/// addon does it at load, on the JS thread) before any MAP timestamp is
/// parsed elsewhere. `mktime` re-reads `TZ` with `getenv` on every call,
/// which is undefined behaviour while another thread (Node's
/// `process.env.TZ = …`) calls `setenv`. glibc's `localtime_r` only reads
/// the environment on its first use, under glibc's own time zone lock, so
/// after this call converting local times never touches the environment.
/// Node itself calls `tzset` when JS changes `TZ`, which this picks up.
pub fn init_local_time_zone() {
    TIME_ZONE_INIT.call_once(|| {
        unsafe extern "C" {
            fn tzset();
        }
        // SAFETY: `tzset` takes no arguments and only updates libc's time
        // zone state under its internal lock.
        unsafe { tzset() }
    });
}

/// This machine's UTC offset in seconds at the instant `t`.
fn utc_offset_at(t: i64) -> Option<i64> {
    let t = libc::time_t::try_from(t).ok()?;
    // SAFETY: `tm` is plain data that `localtime_r` fully writes on success,
    // and both pointers are valid for the call. `localtime_r` is thread-safe.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return None;
        }
        // `c_long` is `i64` on the 64-bit targets, but not everywhere.
        #[allow(clippy::useless_conversion)]
        Some(i64::from(tm.tm_gmtoff))
    }
}

/// Wall-clock time in this machine's zone → Unix seconds, without `mktime`.
/// A time that falls in a DST gap or overlap resolves to one of its
/// neighbouring instants, as `mktime` would.
fn local_to_unix(year: i64, month: i64, day: i64, hour: i64, min: i64, sec: i64) -> Option<i64> {
    init_local_time_zone();
    let naive = days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + min * 60 + sec)?;
    let first = naive - utc_offset_at(naive)?;
    let offset = utc_offset_at(first)?;
    let second = naive - offset;
    if second == first || utc_offset_at(second)? == offset {
        Some(second)
    } else {
        Some(first)
    }
}

/// Parses the MAP timestamp `YYYYMMDDTHHMMSS[Z]` (optionally followed by an
/// offset, which is ignored). Without `Z` the time is the phone's local time
/// and is read in this machine's time zone. Returns 0 for anything unparseable.
pub fn parse_map_timestamp(text: &str) -> i64 {
    let bytes = text.as_bytes();
    if bytes.len() < 15 || bytes[8] != b'T' {
        return 0;
    }
    let field = |range: std::ops::Range<usize>| -> Option<i64> {
        let s = text.get(range)?;
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse().ok())
            .flatten()
    };
    let parsed = (|| {
        Some((
            field(0..4)?,
            field(4..6)?,
            field(6..8)?,
            field(9..11)?,
            field(11..13)?,
            field(13..15)?,
        ))
    })();
    let Some((year, month, day, hour, min, sec)) = parsed else {
        return 0;
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return 0;
    }
    if matches!(bytes.get(15), Some(b'Z' | b'z')) {
        days_from_civil(year, month, day) * 86_400 + hour * 3_600 + min * 60 + sec
    } else {
        local_to_unix(year, month, day, hour, min, sec).unwrap_or(0)
    }
}

// --- Building --------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecipientKind {
    Tel,
    Email,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipient {
    pub kind: RecipientKind,
    pub address: String,
}

impl Recipient {
    pub fn tel(address: impl Into<String>) -> Self {
        Self {
            kind: RecipientKind::Tel,
            address: address.into(),
        }
    }

    pub fn email(address: impl Into<String>) -> Self {
        Self {
            kind: RecipientKind::Email,
            address: address.into(),
        }
    }

    pub fn thread_key(&self) -> String {
        match self.kind {
            RecipientKind::Tel => format!("tel:{}", normalize_phone(&self.address)),
            RecipientKind::Email => format!("email:{}", normalize_email(&self.address)),
        }
    }
}

fn invalid(message: &str) -> Error {
    Error::InvalidInput(message.to_string())
}

/// Refuses any address that could alter the bMessage around it (line breaks,
/// vCard delimiters) or that is not plausibly an address. The error message
/// names the problem, never the address.
pub fn validate_recipient(recipient: &Recipient) -> Result<()> {
    let address = recipient.address.as_str();
    if address.is_empty() {
        return Err(invalid("Recipient address is empty."));
    }
    if address.len() > 254 {
        return Err(invalid("Recipient address is too long."));
    }
    if address.chars().any(|c| c < ' ' || c == '\x7f') {
        return Err(invalid("Recipient address contains a control character."));
    }
    if address.contains([';', ':', ',', '\\']) {
        return Err(invalid("Recipient address contains a vCard delimiter."));
    }
    match recipient.kind {
        RecipientKind::Tel => {
            if !address
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '(' | ')' | ' ' | '.'))
            {
                return Err(invalid("Phone number contains an unexpected character."));
            }
            if !address.chars().any(|c| c.is_ascii_digit()) {
                return Err(invalid("Phone number contains no digits."));
            }
        }
        RecipientKind::Email => {
            if address.matches('@').count() != 1 {
                return Err(invalid("Email address must contain exactly one '@'."));
            }
            let (local, domain) = address.split_once('@').unwrap_or_default();
            if local.is_empty() || domain.is_empty() {
                return Err(invalid(
                    "Email address is missing a local part or a domain.",
                ));
            }
            if address.contains(' ') {
                return Err(invalid("Email address contains a space."));
            }
        }
    }
    Ok(())
}

/// Parses `tel:<number>` or `email:<address>` into a validated recipient.
/// Anything else (groups, alphanumeric senders) is refused.
pub fn recipient_from_thread_key(thread_key: &str) -> Result<Recipient> {
    let recipient = if let Some(address) = thread_key.strip_prefix("tel:") {
        Recipient::tel(address)
    } else if let Some(address) = thread_key.strip_prefix("email:") {
        Recipient::email(address)
    } else {
        return Err(invalid(
            "Unsupported conversation type; only one-to-one threads can be replied to.",
        ));
    };
    validate_recipient(&recipient)?;
    Ok(recipient)
}

/// Parses what a user typed into a "To:" field: an '@' means an Apple ID
/// email, anything else a phone number.
pub fn recipient_from_input(text: &str) -> Result<Recipient> {
    let address = vcard::trim(text);
    let recipient = if address.contains('@') {
        Recipient::email(address)
    } else {
        Recipient::tel(address)
    };
    validate_recipient(&recipient)?;
    Ok(recipient)
}

/// Byte-stuffs a body for the MSG block: lines that look structural get a
/// leading space, line breaks become CRLF, and a trailing line break is not
/// content.
pub fn stuff_body(body: &str) -> String {
    if body.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(body.len() + 16);
    for line in split_lines(body) {
        if is_stuffable_token(line) {
            out.push(' ');
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    let drop = if body.ends_with(['\n', '\r']) { 4 } else { 2 };
    out.truncate(out.len().saturating_sub(drop));
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildOptions {
    /// Prefix for EMAIL recipient values. iOS discards the first two
    /// characters of an EMAIL value, so a two-character scheme tag is sent for
    /// it to eat.
    pub email_tag: String,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            email_tag: "7:".to_string(),
        }
    }
}

/// Builds the bMessage for `MessageAccess1.PushMessage` with default options.
pub fn build_bmessage(recipients: &[Recipient], body: &str) -> Result<String> {
    build_bmessage_with(recipients, body, &BuildOptions::default())
}

/// Builds the bMessage for `MessageAccess1.PushMessage`. Every recipient is
/// validated first; one bad address refuses the whole message.
///
/// The shape is what iOS accepts: TYPE is always SMS_GSM (iOS picks iMessage
/// itself), an empty vCard 2.1 originator outside BENV, `N:;;;;` in every
/// vCard, a UTF-8 body, and LENGTH counting the whole BEGIN:MSG..END:MSG block.
pub fn build_bmessage_with(
    recipients: &[Recipient],
    body: &str,
    options: &BuildOptions,
) -> Result<String> {
    if recipients.is_empty() {
        return Err(invalid("A message needs at least one recipient."));
    }
    for recipient in recipients {
        validate_recipient(recipient)?;
    }
    if options.email_tag.contains(|c: char| c < ' ' || c == '\x7f') {
        return Err(invalid("The email tag contains a control character."));
    }

    let stuffed = stuff_body(body);
    let mut block = String::from("BEGIN:MSG\r\n");
    block.push_str(&stuffed);
    if !stuffed.is_empty() {
        block.push_str("\r\n");
    }
    block.push_str("END:MSG\r\n");

    let mut out = String::with_capacity(block.len() + 256);
    for line in [
        "BEGIN:BMSG",
        "VERSION:1.0",
        "STATUS:UNREAD",
        "TYPE:SMS_GSM",
        "FOLDER:telecom/msg/outbox",
        "BEGIN:VCARD",
        "VERSION:2.1",
        "N:;;;;",
        "TEL:",
        "END:VCARD",
        "BEGIN:BENV",
    ] {
        out.push_str(line);
        out.push_str("\r\n");
    }
    for recipient in recipients {
        out.push_str("BEGIN:VCARD\r\nVERSION:2.1\r\nN:;;;;\r\n");
        match recipient.kind {
            RecipientKind::Tel => {
                out.push_str("TEL:");
            }
            RecipientKind::Email => {
                out.push_str("EMAIL:");
                out.push_str(&options.email_tag);
            }
        }
        out.push_str(&recipient.address);
        out.push_str("\r\nEND:VCARD\r\n");
    }
    out.push_str("BEGIN:BBODY\r\nCHARSET:UTF-8\r\n");
    out.push_str(&format!("LENGTH:{}\r\n", block.len()));
    out.push_str(&block);
    out.push_str("END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INCOMING_TEL: &str = "BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:UNREAD\r\nTYPE:SMS_GSM\r\n\
        FOLDER:telecom/msg/inbox\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jane\r\n\
        TEL:+1 (555) 555-0123\r\nEND:VCARD\r\nBEGIN:BENV\r\nBEGIN:VCARD\r\nVERSION:2.1\r\n\
        TEL:+15555550199\r\nEND:VCARD\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:42\r\n\
        BEGIN:MSG\r\nRunning late\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n";

    const INCOMING_EMAIL: &str = "BEGIN:BMSG\nVERSION:1.0\nSTATUS:READ\nTYPE:SMS_GSM\n\
        FOLDER:telecom/msg/inbox\nBEGIN:VCARD\nFN:Sam Smith\nEMAIL:Sam.Smith@Example.COM\n\
        END:VCARD\nBEGIN:BENV\nBEGIN:BBODY\nBEGIN:MSG\nsent from an apple id\nEND:MSG\n\
        END:BBODY\nEND:BENV\nEND:BMSG\n";

    fn wrap_body(msg_lines: &str) -> String {
        format!(
            "BEGIN:BMSG\r\nSTATUS:UNREAD\r\nBEGIN:VCARD\r\nTEL:+15555550111\r\nEND:VCARD\r\n\
             BEGIN:BENV\r\nBEGIN:BBODY\r\nBEGIN:MSG\r\n{msg_lines}END:MSG\r\nEND:BBODY\r\n\
             END:BENV\r\nEND:BMSG\r\n"
        )
    }

    fn tel(party_tel: &str) -> Party {
        Party {
            tel: party_tel.to_string(),
            ..Party::default()
        }
    }

    // --- Parse ------------------------------------------------------------

    #[test]
    fn parses_telephone_originator() {
        let m = parse_bmessage(INCOMING_TEL);
        assert!(m.valid);
        assert!(!m.read);
        assert_eq!(m.msg_type, "SMS_GSM");
        assert_eq!(m.folder, "telecom/msg/inbox");
        assert_eq!(m.originator.tel, "+1 (555) 555-0123");
        assert_eq!(m.originator.name, "Jane Doe");
        assert_eq!(m.body, "Running late");
        assert_eq!(m.recipients.len(), 1);
        assert_eq!(m.recipients[0].tel, "+15555550199");
        assert_eq!(m.version, "1.0");
        assert_eq!(m.charset, "UTF-8");
        assert_eq!(m.length, Some(42));
        assert_eq!(m.parts, ["Running late"]);
    }

    #[test]
    fn parses_apple_id_originator() {
        let m = parse_bmessage(INCOMING_EMAIL);
        assert!(m.valid);
        assert!(m.read);
        assert!(m.originator.tel.is_empty());
        assert_eq!(m.originator.email, "Sam.Smith@Example.COM");
        assert_eq!(m.originator.name, "Sam Smith");
        assert_eq!(m.body, "sent from an apple id");
    }

    #[test]
    fn keeps_multiline_and_utf8_bodies() {
        let m = parse_bmessage(&wrap_body("line one\r\nline two\r\néà ✓ 🎉\r\n"));
        assert!(m.valid);
        assert_eq!(m.body, "line one\nline two\néà ✓ 🎉");
    }

    #[test]
    fn unstuffs_body_lines_that_look_structural() {
        let m = parse_bmessage(&wrap_body(" END:MSG\r\n BEGIN:VCARD\r\nreal text\r\n"));
        assert!(m.valid);
        assert_eq!(m.body, "END:MSG\nBEGIN:VCARD\nreal text");
        assert!(m.recipients.is_empty());
    }

    #[test]
    fn accepts_lf_only_and_ignores_unknown_properties() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nX-WEIRD:whatever\nSTATUS:READ\n\
             BEGIN:VCARD\nTEL;TYPE=CELL:+15555550111\nX-OTHER:x\nEND:VCARD\n\
             BEGIN:BENV\nBEGIN:BBODY\nBEGIN:MSG\nhi\nEND:MSG\nEND:BBODY\nEND:BENV\nEND:BMSG",
        );
        assert!(m.valid);
        assert_eq!(m.originator.tel, "+15555550111");
        assert_eq!(m.body, "hi");
    }

    #[test]
    fn rejects_malformed_input_without_panicking() {
        assert!(!parse_bmessage("").valid);
        assert!(!parse_bmessage("not a bmessage at all").valid);
        assert!(!parse_bmessage("STATUS:READ\nBEGIN:MSG\nbody\n").valid);
        let truncated = parse_bmessage("BEGIN:BMSG\nSTATUS:UNREAD\nBEGIN:VCARD\nTEL:+1555");
        assert!(truncated.valid);
        assert!(truncated.body.is_empty());
    }

    #[test]
    fn strips_the_scheme_tag_ios_puts_on_addresses() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:VCARD\nEMAIL:e:someone@example.com\nEND:VCARD\n\
             BEGIN:BENV\nBEGIN:VCARD\nTEL:7:+15555550123\nEND:VCARD\nEND:BENV\nEND:BMSG\n",
        );
        assert_eq!(m.originator.email, "someone@example.com");
        assert_eq!(m.recipients[0].tel, "+15555550123");
    }

    #[test]
    fn leaves_an_untagged_address_alone() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:VCARD\nEMAIL:someone@example.com\nTEL:+1\nEND:VCARD\nEND:BMSG\n",
        );
        assert_eq!(m.originator.email, "someone@example.com");
        assert_eq!(m.originator.tel, "+1");
    }

    #[test]
    fn multi_line_body_keeps_its_line_breaks() {
        for eol in ["\r\n", "\n", "\r"] {
            let text = format!(
                "BEGIN:BMSG{eol}BEGIN:BENV{eol}BEGIN:BBODY{eol}BEGIN:MSG{eol}first line{eol}\
                 second line{eol}END:MSG{eol}END:BBODY{eol}END:BENV{eol}END:BMSG{eol}"
            );
            assert_eq!(
                parse_bmessage(&text).body,
                "first line\nsecond line",
                "{eol:?}"
            );
        }
    }

    // --- Parse (Tincan extensions) ------------------------------------------

    #[test]
    fn keeps_each_msg_part() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:BENV\nBEGIN:BBODY\nPARTID:1\nCHARSET:UTF-8\nLANGUAGE:en\n\
             BEGIN:MSG\none\nEND:MSG\nBEGIN:MSG\ntwo\nEND:MSG\nEND:BBODY\nEND:BENV\nEND:BMSG\n",
        );
        assert_eq!(m.parts, ["one", "two"]);
        assert_eq!(m.body, "one\ntwo");
        assert_eq!(m.language, "en");
    }

    #[test]
    fn decodes_a_quoted_printable_body() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:BENV\nBEGIN:BBODY\nENCODING:QUOTED-PRINTABLE\nCHARSET:UTF-8\n\
             BEGIN:MSG\ncaf=C3=A9 at =\nsix\nEND:MSG\nEND:BBODY\nEND:BENV\nEND:BMSG\n",
        );
        assert_eq!(m.encoding, "QUOTED-PRINTABLE");
        assert_eq!(m.body, "café at six");
    }

    #[test]
    fn reads_folded_vcard_lines_and_structured_names() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:VCARD\nVERSION:2.1\nN:Doe;\n Jane\nTEL:+1555\n 5550123\nEND:VCARD\nEND:BMSG\n",
        );
        assert_eq!(m.originator.name, "Jane Doe");
        assert_eq!(m.originator.tel, "+15555550123");
    }

    #[test]
    fn keeps_an_unterminated_msg_block() {
        let m = parse_bmessage("BEGIN:BMSG\nBEGIN:BENV\nBEGIN:BBODY\nBEGIN:MSG\npartial\n");
        assert_eq!(m.body, "partial");
        assert_eq!(m.parts, ["partial"]);
    }

    // --- Identity ---------------------------------------------------------

    #[test]
    fn normalizes_phone_formatting() {
        assert_eq!(normalize_phone("+1 (555) 123-4567"), "+15551234567");
        assert_eq!(normalize_phone("+1-555-123-4567"), "+15551234567");
        assert_eq!(normalize_phone("555.123.4567"), "5551234567");
        assert_eq!(normalize_phone("  +1 555"), "+1555");
        assert_eq!(normalize_phone("1+555"), "1555");
        assert_eq!(normalize_phone(""), "");
    }

    #[test]
    fn does_not_invent_country_codes() {
        assert_ne!(
            normalize_phone("5551234567"),
            normalize_phone("+15551234567")
        );
    }

    #[test]
    fn email_is_case_insensitive() {
        assert_eq!(
            normalize_email("  Sam.Smith@Example.COM "),
            "sam.smith@example.com"
        );
    }

    #[test]
    fn thread_key_prefers_tel_and_namespaces_types() {
        let both = Party {
            tel: "+1 555 123 4567".into(),
            email: "a@b.com".into(),
            ..Party::default()
        };
        assert_eq!(thread_key_for(&both), "tel:+15551234567");
        let email_only = Party {
            email: "A@B.com".into(),
            ..Party::default()
        };
        assert_eq!(thread_key_for(&email_only), "email:a@b.com");
        assert_ne!(thread_key_for(&both), thread_key_for(&email_only));
        assert!(thread_key_for(&Party::default()).is_empty());
    }

    #[test]
    fn alphanumeric_sender_keeps_its_own_key() {
        assert_eq!(thread_key_for(&tel("MMA")), "sender:mma");
        assert_eq!(thread_key_for(&tel("  mma ")), "sender:mma");
        assert_eq!(thread_key_for(&tel("MMA-123")), "sender:mma-123");
        assert_eq!(thread_key_for(&tel("+15551234567")), "tel:+15551234567");
        assert_eq!(thread_key_for(&tel("M\x01MA")), "sender:mma");
        assert!(thread_key_for(&tel("\x01\x02")).is_empty());
    }

    #[test]
    fn name_does_not_affect_thread_key() {
        let a = Party {
            name: "Sam".into(),
            tel: "+15551110000".into(),
            ..Party::default()
        };
        let b = Party {
            name: "Sam".into(),
            tel: "+15552220000".into(),
            ..Party::default()
        };
        assert_ne!(thread_key_for(&a), thread_key_for(&b));
    }

    #[test]
    fn display_address_normalizes_or_collapses() {
        assert_eq!(display_address(&tel("+1 (555) 555-0123")), "+15555550123");
        assert_eq!(display_address(&tel("  My   Bank ")), "My Bank");
        let email = Party {
            email: " A@B.com".into(),
            ..Party::default()
        };
        assert_eq!(display_address(&email), "a@b.com");
    }

    #[test]
    fn recognises_short_codes() {
        for key in ["sender:amazon", "tel:32665", "tel:123456"] {
            assert!(is_short_code(key), "{key}");
        }
        for key in ["tel:1234567", "tel:+12345", "tel:", "email:a@b.c"] {
            assert!(!is_short_code(key), "{key}");
        }
    }

    #[test]
    fn buckets_tel_keys_by_suffix() {
        assert_eq!(tel_suffix("+1 555 555 0123"), "555550123");
        assert_eq!(tel_suffix("12345"), "");
        assert_eq!(thread_bucket("tel:+15555550123"), "tel:555550123");
        assert_eq!(thread_bucket("tel:5555550123"), "tel:555550123");
        assert_eq!(thread_bucket("tel:32665"), "tel:32665");
        assert_eq!(thread_bucket("tel:"), "tel:");
        assert_eq!(thread_bucket("email:a@b.c"), "email:a@b.c");
    }

    // --- Timestamps and handles -------------------------------------------

    #[test]
    fn parses_map_basic_iso() {
        assert!(parse_map_timestamp("20260816T024500") > 0);
        assert_eq!(parse_map_timestamp("20260816T024500Z"), 1_786_848_300);
        assert_eq!(parse_map_timestamp("19700101T000000Z"), 0);
        assert_eq!(parse_map_timestamp("20000229T120000Z"), 951_825_600);
        assert_eq!(parse_map_timestamp(""), 0);
        assert_eq!(parse_map_timestamp("garbage"), 0);
        assert_eq!(parse_map_timestamp("20261399T999999"), 0);
        assert_eq!(parse_map_timestamp("2026081XT024500Z"), 0);
    }

    #[test]
    fn local_timestamps_use_this_machines_offset() {
        // Whatever the zone, a local wall-clock time is the UTC reading minus
        // the offset in effect at that instant.
        for text in ["20260816T024500", "20260115T120000", "20001231T235959"] {
            let utc = parse_map_timestamp(&format!("{text}Z"));
            let local = parse_map_timestamp(text);
            let offset = utc_offset_at(local).unwrap();
            assert_eq!(local + offset, utc, "{text}");
        }
    }

    #[test]
    fn map_handle_strips_the_session_scoped_prefix() {
        assert_eq!(
            map_handle_from_path("/org/bluez/obex/client/session5/message1086086778701665313"),
            "1086086778701665313"
        );
        assert_eq!(
            map_handle_from_path("/org/bluez/obex/client/session11/message1086086778701665313"),
            "1086086778701665313"
        );
        assert_eq!(map_handle_from_path("12345"), "12345");
        assert_eq!(map_handle_from_path(""), "");
    }

    // --- Build ------------------------------------------------------------

    fn build(recipients: &[Recipient], body: &str) -> String {
        build_bmessage(recipients, body).expect("valid message")
    }

    fn block(body: &str) -> String {
        let out = build(&[Recipient::tel("+15551234567")], body);
        let begin = out.find("BEGIN:MSG\r\n").unwrap();
        let end = out[begin..].find("END:MSG\r\n").unwrap() + begin + "END:MSG\r\n".len();
        out[begin..end].to_string()
    }

    fn declared_length(out: &str) -> usize {
        let at = out.find("LENGTH:").unwrap() + 7;
        out[at..].split("\r\n").next().unwrap().parse().unwrap()
    }

    #[test]
    fn produces_the_shape_the_phone_accepts() {
        let out = build(&[Recipient::tel("+15551234567")], "on my way");
        for needle in [
            "BEGIN:BMSG",
            "TYPE:SMS_GSM",
            "FOLDER:telecom/msg/outbox",
            "CHARSET:UTF-8",
            "TEL:+15551234567",
            "on my way",
        ] {
            assert!(out.contains(needle), "{needle}");
        }
        let originator = out.find("BEGIN:VCARD").unwrap();
        let envelope = out.find("BEGIN:BENV").unwrap();
        let recipient = out.find("TEL:+15551234567").unwrap();
        assert!(originator < envelope);
        assert!(envelope < recipient);
        assert!(out.split("\r\n").all(|line| !line.contains('\n')));
        assert!(out.ends_with("END:BMSG\r\n"));
    }

    #[test]
    fn always_uses_sms_gsm_even_for_apple_id_recipients() {
        let out = build(&[Recipient::email("someone@example.com")], "hi");
        assert!(out.contains("TYPE:SMS_GSM"));
        assert!(out.contains("EMAIL:7:someone@example.com"));
        assert!(!out.contains("TEL:+"));
        assert!(!out.contains("TEL:someone"));
    }

    #[test]
    fn apple_id_addresses_carry_a_scheme_tag() {
        let out = build(&[Recipient::email("jane.doe@example.com")], "hi");
        assert!(out.contains("EMAIL:7:jane.doe@example.com"));
        assert!(!out.contains("EMAIL:jane.doe"));
        let tel_out = build(&[Recipient::tel("+15551234567")], "hi");
        assert!(tel_out.contains("TEL:+15551234567"));
        assert!(!tel_out.contains("TEL:7:"));
    }

    #[test]
    fn email_tag_is_configurable() {
        let options = BuildOptions {
            email_tag: String::new(),
        };
        let out =
            build_bmessage_with(&[Recipient::email("a@example.com")], "hi", &options).unwrap();
        assert!(out.contains("EMAIL:a@example.com\r\n"));
        let bad = BuildOptions {
            email_tag: "\r\n".into(),
        };
        assert!(build_bmessage_with(&[Recipient::email("a@example.com")], "hi", &bad).is_err());
    }

    #[test]
    fn uses_the_vcard_shape_ios_parses_correctly() {
        let out = build(&[Recipient::email("jane.doe@example.com")], "hi");
        assert!(!out.contains("VERSION:3.0"));
        assert!(out.contains("VERSION:2.1"));
        assert!(out.contains("N:;;;;"));
        assert!(!out.contains("N:\r\n"));
    }

    #[test]
    fn email_recipient_survives_a_parse_of_what_was_built() {
        let parsed = parse_bmessage(&build(&[Recipient::email("jane.doe@example.com")], "hi"));
        assert!(parsed.valid);
        assert_eq!(parsed.recipients.len(), 1);
        assert_eq!(parsed.recipients[0].email, "jane.doe@example.com");
    }

    #[test]
    fn length_counts_the_whole_message_block() {
        let out = build(&[Recipient::tel("+15551234567")], "hello");
        assert_eq!(declared_length(&out), block("hello").len());
        assert_eq!(declared_length(&out), "hello".len() + 22);
    }

    #[test]
    fn a_trailing_newline_does_not_become_blank_lines() {
        assert_eq!(block("hello"), "BEGIN:MSG\r\nhello\r\nEND:MSG\r\n");
        assert_eq!(block("hello\n"), "BEGIN:MSG\r\nhello\r\nEND:MSG\r\n");
        assert_eq!(block("a\nb"), "BEGIN:MSG\r\na\r\nb\r\nEND:MSG\r\n");
        assert_eq!(block("a\n\nb"), "BEGIN:MSG\r\na\r\n\r\nb\r\nEND:MSG\r\n");
        let out = build(&[Recipient::tel("+15551234567")], "hello\n");
        assert_eq!(declared_length(&out), block("hello\n").len());
    }

    #[test]
    fn rejects_newline_injected_recipient() {
        for r in [
            Recipient::tel("+15551234567\r\nTEL:+15559999999"),
            Recipient::tel("+15551234567\nTEL:+15559999999"),
            Recipient::email("a@b.com\r\nEMAIL:evil@example.com"),
        ] {
            let err = validate_recipient(&r).unwrap_err();
            assert_eq!(err.code(), crate::ErrorCode::InvalidInput);
            assert!(!err.message().is_empty());
        }
    }

    #[test]
    fn rejects_vcard_delimiters() {
        for address in [
            "a@b.com;TYPE=WORK",
            "a@b.com:x",
            "a@b.com,c@d.com",
            "a\\@b.com",
        ] {
            assert!(
                validate_recipient(&Recipient::email(address)).is_err(),
                "{address}"
            );
        }
    }

    #[test]
    fn rejects_control_characters() {
        assert!(validate_recipient(&Recipient::tel("+1555\x01234")).is_err());
        assert!(validate_recipient(&Recipient::email("a@b\x7f.com")).is_err());
        assert!(validate_recipient(&Recipient::tel("+1555\t234")).is_err());
    }

    #[test]
    fn build_refuses_an_invalid_recipient_entirely() {
        assert!(
            build_bmessage(&[Recipient::tel("+15551234567\r\nTEL:+15559999999")], "hi").is_err()
        );
        assert!(build_bmessage(&[], "hi").is_err());
        assert!(
            build_bmessage(
                &[
                    Recipient::tel("+15551234567"),
                    Recipient::email("a@b.com\r\nEMAIL:evil@example.com"),
                ],
                "hi"
            )
            .is_err()
        );
    }

    #[test]
    fn injected_recipient_never_survives_into_a_parsed_message() {
        let parsed = parse_bmessage(&build(&[Recipient::tel("+15551234567")], "hi"));
        assert!(parsed.valid);
        assert_eq!(parsed.recipients.len(), 1);
        assert_eq!(parsed.recipients[0].tel, "+15551234567");
    }

    #[test]
    fn accepts_addresses_people_actually_write() {
        assert!(validate_recipient(&Recipient::tel("+1 (555) 123-4567")).is_ok());
        assert!(validate_recipient(&Recipient::tel("5551234567")).is_ok());
        assert!(validate_recipient(&Recipient::email("first.last+tag@example.co.uk")).is_ok());
    }

    #[test]
    fn rejects_addresses_that_are_not_addresses() {
        let cases = [
            (Recipient::tel(""), "Recipient address is empty."),
            (
                Recipient::tel("no-digits-here"),
                "Phone number contains an unexpected character.",
            ),
            (Recipient::tel("()-"), "Phone number contains no digits."),
            (
                Recipient::email("missing-at-sign"),
                "Email address must contain exactly one '@'.",
            ),
            (
                Recipient::email("two@at@signs.com"),
                "Email address must contain exactly one '@'.",
            ),
            (
                Recipient::email("@nolocal.com"),
                "Email address is missing a local part or a domain.",
            ),
            (
                Recipient::email("nodomain@"),
                "Email address is missing a local part or a domain.",
            ),
            (
                Recipient::email("a b@c.com"),
                "Email address contains a space.",
            ),
            (
                Recipient::tel("5".repeat(300)),
                "Recipient address is too long.",
            ),
        ];
        for (recipient, message) in cases {
            assert_eq!(
                validate_recipient(&recipient).unwrap_err().message(),
                message
            );
        }
    }

    #[test]
    fn stuffs_body_lines_that_look_structural() {
        let out = build(&[Recipient::tel("+15551234567")], "END:MSG");
        assert_eq!(out.matches("\r\nEND:MSG\r\n").count(), 1);
        assert!(out.contains(" END:MSG"));
    }

    #[test]
    fn stuffed_body_survives_a_round_trip() {
        for body in [
            "END:MSG",
            "BEGIN:VCARD",
            "line one\nEND:BMSG\nline three",
            " BEGIN:MSG",
            "begin:msg",
        ] {
            let parsed = parse_bmessage(&build(&[Recipient::tel("+15551234567")], body));
            assert!(parsed.valid, "{body}");
            assert_eq!(parsed.body, body);
            assert_eq!(parsed.recipients.len(), 1, "{body}");
        }
    }

    #[test]
    fn preserves_utf8_bodies() {
        let body = "emoji 💩 and accents éè";
        let parsed = parse_bmessage(&build(&[Recipient::tel("+15551234567")], body));
        assert!(parsed.valid);
        assert_eq!(parsed.body, body);
        let out = build(&[Recipient::tel("+15551234567")], body);
        assert_eq!(declared_length(&out), body.len() + 22);
    }

    #[test]
    fn handles_multi_line_and_empty_bodies() {
        let multi = parse_bmessage(&build(&[Recipient::tel("+15551234567")], "one\ntwo\nthree"));
        assert_eq!(multi.body, "one\ntwo\nthree");
        let empty = parse_bmessage(&build(&[Recipient::tel("+15551234567")], ""));
        assert!(empty.valid);
        assert_eq!(empty.body, "");
    }

    #[test]
    fn parses_recipients_from_thread_keys() {
        let r = recipient_from_thread_key("tel:+15551234567").unwrap();
        assert_eq!(r, Recipient::tel("+15551234567"));
        let r = recipient_from_thread_key("email:a@b.com").unwrap();
        assert_eq!(r, Recipient::email("a@b.com"));
    }

    #[test]
    fn refuses_thread_keys_it_does_not_understand() {
        let err = recipient_from_thread_key("group:weekend-trip").unwrap_err();
        assert_eq!(
            err.message(),
            "Unsupported conversation type; only one-to-one threads can be replied to."
        );
        assert!(recipient_from_thread_key("+15551234567").is_err());
        assert!(recipient_from_thread_key("").is_err());
        assert!(recipient_from_thread_key("tel:+1555\r\nTEL:+1999").is_err());
    }

    #[test]
    fn decodes_non_utf8_raw_bmessage_bytes() {
        // ISO-8859-1 body: "café" (0xE9)
        let mut latin1 = Vec::new();
        latin1.extend_from_slice(
            b"BEGIN:BMSG\r\nVERSION:1.0\r\nBEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:ISO-8859-1\r\nBEGIN:MSG\r\ncaf",
        );
        latin1.push(0xE9);
        latin1.extend_from_slice(b"\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n");
        let parsed = parse_bmessage_bytes(&latin1);
        assert!(parsed.valid);
        assert_eq!(parsed.body, "café");

        // Windows-1252 smart quote (0x92) in NATIVE / undeclared charset
        let mut cp1252 = Vec::new();
        cp1252.extend_from_slice(
            b"BEGIN:BMSG\r\nVERSION:1.0\r\nBEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:NATIVE\r\nBEGIN:MSG\r\nit",
        );
        cp1252.push(0x92);
        cp1252.extend_from_slice(b"s ok\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n");
        let parsed = parse_bmessage_bytes(&cp1252);
        assert!(parsed.valid);
        assert_eq!(parsed.body, "it\u{2019}s ok");

        // UTF-16BE body: "Hi!"
        let mut utf16 = Vec::new();
        utf16.extend_from_slice(
            b"BEGIN:BMSG\r\nVERSION:1.0\r\nBEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-16BE\r\nBEGIN:MSG\r\n",
        );
        utf16.extend_from_slice(&[0x00, b'H', 0x00, b'i', 0x00, b'!']);
        utf16.extend_from_slice(b"\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n");
        let parsed = parse_bmessage_bytes(&utf16);
        assert!(parsed.valid);
        assert_eq!(parsed.body, "Hi!");
    }

    #[test]
    fn resists_end_msg_and_tab_header_injection() {
        // Tab-indented END:MSG survives build/parse round-trip.
        let body = "before\n\tEND:MSG\nFOLDER:telecom/msg/sent\nafter";
        let built = build(&[Recipient::tel("+15551234567")], body);
        let parsed = parse_bmessage(&built);
        assert!(parsed.valid);
        assert_eq!(parsed.body, body);
        assert_eq!(parsed.folder, "telecom/msg/outbox");

        // Unstuffed END:MSG inside a LENGTH-bounded incoming bMessage cannot spoof FOLDER or STATUS.
        let payload = "hi\r\nEND:MSG\r\nFOLDER:telecom/msg/sent\r\nSTATUS:READ\r\nstill body";
        let len = "BEGIN:MSG\r\n".len() + payload.len() + "\r\nEND:MSG\r\n".len();
        let raw = format!(
            "BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:UNREAD\r\nTYPE:SMS_GSM\r\nFOLDER:telecom/msg/inbox\r\n\
             BEGIN:VCARD\r\nVERSION:2.1\r\nTEL:+15551234567\r\nEND:VCARD\r\n\
             BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:{len}\r\n\
             BEGIN:MSG\r\n{payload}\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n"
        );
        let parsed = parse_bmessage(&raw);
        assert!(parsed.valid);
        assert_eq!(parsed.folder, "telecom/msg/inbox");
        assert!(!parsed.read);
        assert!(parsed.body.contains("still body"));
    }

    fn wrap_with_length(payload: &str, length: usize) -> String {
        format!(
            "BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:UNREAD\r\nFOLDER:telecom/msg/inbox\r\n\
             BEGIN:VCARD\r\nVERSION:2.1\r\nTEL:+15555550111\r\nEND:VCARD\r\n\
             BEGIN:BENV\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nTEL:+15555550100\r\nEND:VCARD\r\n\
             BEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:{length}\r\n\
             BEGIN:MSG\r\n{payload}\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n"
        )
    }

    #[test]
    fn newline_heavy_bodies_parse_in_linear_time() {
        // A stranger controls the body; the parser must not be quadratic in
        // its line count (this took ~11 s per parse before).
        let payload = "x\r\n".repeat(200_000);
        let payload = payload.trim_end();
        let length = "BEGIN:MSG\r\n".len() + payload.len() + "\r\nEND:MSG\r\n".len();
        for text in [
            wrap_with_length(payload, length),
            wrap_body(&format!("{payload}\r\n")),
        ] {
            let started = std::time::Instant::now();
            let m = parse_bmessage(&text);
            let elapsed = started.elapsed();
            assert_eq!(m.body.lines().count(), 200_000);
            assert!(elapsed < std::time::Duration::from_secs(1), "{elapsed:?}");
        }
        // Many early END:MSG lines under LENGTH (the worst case for a forward scan).
        let payload = "END:MSG\r\n".repeat(100_000);
        let started = std::time::Instant::now();
        let m = parse_bmessage(&wrap_with_length(payload.trim_end(), usize::MAX));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(m.parts.len(), 1);
    }

    #[test]
    fn an_unstuffed_end_msg_without_length_stays_in_the_body() {
        let m = parse_bmessage(&wrap_body(
            "hi\r\nEND:MSG\r\nBEGIN:VCARD\r\nTEL:+15555550199\r\nEND:VCARD\r\nFOLDER:x\r\nbye\r\n",
        ));
        assert!(m.valid);
        assert!(m.recipients.is_empty());
        assert_eq!(
            m.body,
            "hi\nEND:MSG\nBEGIN:VCARD\nTEL:+15555550199\nEND:VCARD\nFOLDER:x\nbye"
        );
        assert_eq!(m.parts.len(), 1);
    }

    #[test]
    fn body_text_never_becomes_a_party() {
        // A LENGTH that is too short lets an early END:MSG end the body; the
        // vCard after it still must not become a recipient or the originator.
        let payload = "hi\r\nEND:MSG\r\nBEGIN:VCARD\r\nTEL:+15555550199\r\nEND:VCARD\r\nbye";
        let m = parse_bmessage(&wrap_with_length(payload, 4));
        assert_eq!(m.recipients.len(), 1);
        assert_eq!(m.recipients[0].tel, "+15555550100");
        assert_eq!(m.originator.tel, "+15555550111");
        assert_eq!(m.body, "hi");

        // A vCard inside BBODY but before MSG is not a party either.
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:BENV\nBEGIN:BBODY\nBEGIN:VCARD\nTEL:+15555550199\nEND:VCARD\n\
             BEGIN:MSG\nhi\nEND:MSG\nEND:BBODY\nEND:BENV\nEND:BMSG\n",
        );
        assert!(m.recipients.is_empty());
        assert!(m.originator.is_empty());
    }

    #[test]
    fn adjacent_parts_still_split_without_length() {
        let m = parse_bmessage(
            "BEGIN:BMSG\nBEGIN:BENV\nBEGIN:BBODY\nBEGIN:MSG\none\nEND:MSG\nLENGTH:20\n\
             BEGIN:MSG\ntwo\nEND:MSG\nEND:BBODY\nEND:BENV\nEND:BMSG\n",
        );
        assert_eq!(m.parts, ["one", "two"]);
    }

    #[test]
    fn parses_recipients_from_typed_input() {
        let r = recipient_from_input("+1 (555) 123-4567").unwrap();
        assert_eq!(r.kind, RecipientKind::Tel);
        assert_eq!(r.thread_key(), "tel:+15551234567");
        let r = recipient_from_input("  Alice@iCloud.com ").unwrap();
        assert_eq!(r.kind, RecipientKind::Email);
        assert_eq!(r.thread_key(), "email:alice@icloud.com");
        let r = recipient_from_input("555-1234").unwrap();
        let round_trip = recipient_from_thread_key(&r.thread_key()).unwrap();
        assert_eq!(round_trip.kind, r.kind);
        assert_eq!(round_trip.thread_key(), r.thread_key());
    }

    #[test]
    fn refuses_typed_input_that_is_not_an_address() {
        for input in [
            "Alice",
            "",
            "   \t ",
            "a@b;c@d",
            "a@b\r\nTEL:+1999",
            "a@b@c.com",
            "@nobody.com",
        ] {
            assert!(recipient_from_input(input).is_err(), "{input:?}");
        }
    }
}

//! vCard 2.1 / 3.0 parsing for PBAP phonebooks, call history and the parties
//! inside a bMessage.

use base64::Engine as _;
use serde::Serialize;

/// A TEL or EMAIL value with its TYPE parameters, lowercased (`cell`, `home`,
/// `pref`, `internet`, ...). vCard 2.1 bare parameters (`TEL;CELL;VOICE:`)
/// count as types.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedValue {
    pub value: String,
    pub types: Vec<String>,
}

/// A contact photo. `data` is standard base64 with whitespace removed; `uri`
/// is set instead when the card references the image by URI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// A MIME type such as `image/jpeg`, or empty when the card did not say.
    pub media_type: String,
    pub data: String,
    pub uri: String,
}

impl Photo {
    pub fn bytes(&self) -> Option<Vec<u8>> {
        if self.data.is_empty() {
            return None;
        }
        decode_base64(&self.data)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VCard {
    pub version: String,
    /// FN, or the name assembled from N when there is no FN.
    pub name: String,
    pub family: String,
    pub given: String,
    pub tels: Vec<TypedValue>,
    pub emails: Vec<TypedValue>,
    pub photo: Option<Photo>,
    /// Call history only (X-IRMC-CALL-DATETIME): MISSED, RECEIVED or DIALED.
    pub call_type: String,
    /// The phone's local time as `YYYYMMDDTHHMMSS`.
    pub call_time: String,
    /// On the phone's Favorites list (PBAP `fav`); set by the caller.
    pub favorite: bool,
    pub nickname: String,
    /// ORG's first part.
    pub organization: String,
    /// ORG's remaining parts, joined with ", ".
    pub department: String,
    pub title: String,
    /// BDAY as sent (`YYYY-MM-DD`, `YYYYMMDD` or `--MMDD`).
    pub birthday: String,
    pub note: String,
    /// ADR, formatted as lines joined with `\n`.
    pub addresses: Vec<TypedValue>,
    pub urls: Vec<TypedValue>,
}

impl VCard {
    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
            && self.tels.is_empty()
            && self.emails.is_empty()
            && self.call_time.is_empty()
    }
}

/// One content line split into its parts. `name` is uppercased with any group
/// prefix (`item1.`) removed; parameter names are uppercased.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Property {
    pub name: String,
    pub params: Vec<Param>,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Param {
    /// Empty for a vCard 2.1 bare parameter such as `CELL`.
    pub name: String,
    pub value: String,
}

impl Property {
    fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.value.as_str())
    }

    fn encoding(&self) -> Encoding {
        let explicit = self.param("ENCODING");
        let bare = self
            .params
            .iter()
            .filter(|p| p.name.is_empty())
            .map(|p| p.value.as_str());
        for value in explicit.into_iter().chain(bare) {
            match value.to_ascii_uppercase().as_str() {
                "QUOTED-PRINTABLE" => return Encoding::QuotedPrintable,
                "B" | "BASE64" => return Encoding::Base64,
                _ => {}
            }
        }
        Encoding::None
    }

    fn charset(&self) -> Option<&str> {
        self.param("CHARSET")
    }

    /// TYPE values, lowercased, from `TYPE=a,b`, repeated `TYPE=`, and 2.1 bare
    /// parameters. Encodings and charsets are not types.
    pub fn types(&self) -> Vec<String> {
        let mut out = Vec::new();
        for param in &self.params {
            let values: Vec<&str> = match param.name.as_str() {
                "TYPE" => param.value.split(',').collect(),
                "" => vec![param.value.as_str()],
                _ => continue,
            };
            for value in values {
                let value = value.trim().trim_matches('"').to_ascii_lowercase();
                let structural = matches!(
                    value.as_str(),
                    "quoted-printable" | "base64" | "b" | "7bit" | "8bit"
                );
                if !value.is_empty() && !structural && !out.contains(&value) {
                    out.push(value);
                }
            }
        }
        out
    }

    /// The value with its transfer encoding undone, as text.
    pub fn text(&self) -> String {
        match self.encoding() {
            Encoding::QuotedPrintable => {
                decode_charset(&decode_quoted_printable(&self.value), self.charset())
            }
            Encoding::Base64 => match decode_base64(&self.value) {
                Some(bytes) => decode_charset(&bytes, self.charset()),
                None => self.value.clone(),
            },
            Encoding::None => self.value.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    None,
    QuotedPrintable,
    Base64,
}

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches([' ', '\t', '\r', '\n'])
}

fn find_unquoted_colon(line: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some(i),
            _ => {}
        }
    }
    // An unbalanced quote: fall back to the first colon.
    line.find(':')
}

/// Splits a content line into name, parameters and trimmed value. Returns
/// `None` when there is no ':' or no name.
pub fn parse_property(line: &str) -> Option<Property> {
    let colon = find_unquoted_colon(line)?;
    let head = &line[..colon];
    let mut pieces = head.split(';');
    let raw_name = trim(pieces.next().unwrap_or_default());
    let name = raw_name
        .rsplit_once('.')
        .map_or(raw_name, |(_, n)| n)
        .to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let params = pieces
        .map(trim)
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => Param {
                name: trim(k).to_ascii_uppercase(),
                value: trim(v).trim_matches('"').to_string(),
            },
            None => Param {
                name: String::new(),
                value: p.to_string(),
            },
        })
        .collect();
    Some(Property {
        name,
        params,
        value: trim(&line[colon + 1..]).to_string(),
    })
}

/// Splits a content line into its uppercased name (parameters dropped) and
/// trimmed value.
pub fn split_property(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    let left = &line[..colon];
    let name = trim(left.split(';').next().unwrap_or_default()).to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    Some((name, trim(&line[colon + 1..]).to_string()))
}

/// Undoes vCard escaping: `\n`/`\N` become a newline, `\,` `\;` `\\` the
/// character; unknown escapes are kept verbatim.
pub fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(e @ (',' | ';' | '\\')) => out.push(e),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Splits a structured value (N) on unescaped ';', then unescapes and trims
/// each part. Always returns at least one part.
pub fn n_parts(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                current.push('\\');
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ';' => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
        .into_iter()
        .map(|p| trim(&unescape(&p)).to_string())
        .collect()
}

fn text_value(property: &Property) -> String {
    trim(&unescape(&property.text())).to_string()
}

/// ADR (`POBox;Ext;Street;City;Region;Postal;Country`) as lines: street parts,
/// then "City, Region Postal", then the country. Empty parts are skipped.
pub fn format_address(value: &str) -> String {
    let parts = n_parts(value);
    let part = |i: usize| parts.get(i).map_or("", String::as_str);
    let mut lines: Vec<String> = Vec::new();
    for i in [0, 1, 2] {
        lines.extend(
            part(i)
                .lines()
                .map(|l| trim(l).to_string())
                .filter(|l| !l.is_empty()),
        );
    }
    let region_postal = [part(4), part(5)]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let locality = [part(3), region_postal.as_str()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if !locality.is_empty() {
        lines.push(locality);
    }
    if !part(6).is_empty() {
        lines.push(part(6).to_string());
    }
    lines.join("\n")
}

/// "Given Family" from an N value, or whichever of the two exists.
pub fn name_from_n(value: &str) -> String {
    let parts = n_parts(value);
    let family = parts[0].as_str();
    let given = parts.get(1).map_or("", String::as_str);
    match (given.is_empty(), family.is_empty()) {
        (false, false) => format!("{given} {family}"),
        (true, _) => family.to_string(),
        (false, true) => given.to_string(),
    }
}

fn head_encoding(line: &[u8]) -> Encoding {
    match line.iter().position(|&b| b == b':') {
        Some(colon) => parse_property(&String::from_utf8_lossy(&line[..=colon]))
            .map_or(Encoding::None, |p| p.encoding()),
        None => Encoding::None,
    }
}

fn is_base64_line(line: &[u8]) -> bool {
    !line.is_empty()
        && line
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn trim_bytes(bytes: &[u8]) -> &[u8] {
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

/// Joins physical lines into logical content lines:
/// - a line starting with a space or tab continues the previous one, minus that
///   first character (RFC 2425 folding);
/// - a quoted-printable value ending in a soft line break ('=') continues on
///   the next line verbatim (vCard 2.1);
/// - an unindented run of base64 lines after a base64 property belongs to it,
///   up to the blank line that ends it (vCard 2.1 as some phones write it).
pub fn unfold(text: &str) -> Vec<String> {
    unfold_bytes(text.as_bytes())
        .into_iter()
        // Only ASCII bytes are ever split off, so each line stays UTF-8.
        .map(|line| String::from_utf8(line).unwrap_or_else(|e| lossy(e.as_bytes())))
        .collect()
}

/// [`unfold`] over raw bytes, so 8-bit values stay undecoded until their
/// property's `CHARSET` is known.
pub fn unfold_bytes(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut lines: Vec<Vec<u8>> = Vec::new();
    let mut open = Encoding::None;
    for raw in bytes.split(|&b| b == b'\n') {
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        if let Some(last) = lines.last_mut() {
            if open == Encoding::QuotedPrintable && last.ends_with(b"=") {
                last.pop();
                last.extend_from_slice(line);
                continue;
            }
            if let [b' ' | b'\t', rest @ ..] = line {
                last.extend_from_slice(rest);
                continue;
            }
            if open == Encoding::Base64 && is_base64_line(trim_bytes(line)) {
                last.extend_from_slice(trim_bytes(line));
                continue;
            }
        }
        open = head_encoding(line);
        lines.push(line.to_vec());
    }
    lines
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn is_utf8_charset(charset: &str) -> bool {
    matches!(
        charset.trim().to_ascii_uppercase().as_str(),
        "UTF-8" | "UTF8" | "US-ASCII"
    )
}

/// One raw logical line as text. A value with no transfer encoding is
/// decoded from its own `CHARSET` (8-bit ISO-8859-1, Windows-1252, …); a
/// quoted-printable or base64 value is ASCII and decoded later, by
/// [`Property::text`]. Undeclared non-UTF-8 bytes are read as Windows-1252,
/// as for bMessage bodies.
fn decode_line(line: Vec<u8>) -> String {
    if line.is_ascii() {
        return String::from_utf8(line).unwrap_or_default();
    }
    let head_end = {
        let mut quoted = false;
        line.iter().position(|&b| match b {
            b'"' => {
                quoted = !quoted;
                false
            }
            b':' => !quoted,
            _ => false,
        })
    };
    let Some(colon) = head_end else {
        return String::from_utf8(line).unwrap_or_else(|e| lossy(e.as_bytes()));
    };
    let head = String::from_utf8_lossy(&line[..colon]);
    let value = &line[colon + 1..];
    let declared = parse_property(&format!("{head}:"))
        .filter(|p| p.encoding() == Encoding::None)
        .map(|p| p.charset().map(str::to_owned));
    match declared {
        Some(Some(charset)) if !is_utf8_charset(&charset) => {
            format!("{head}:{}", decode_charset(value, Some(&charset)))
        }
        Some(charset) if std::str::from_utf8(value).is_err() => {
            format!("{head}:{}", decode_charset(value, charset.as_deref()))
        }
        _ => String::from_utf8(line).unwrap_or_else(|e| lossy(e.as_bytes())),
    }
}

/// Decodes quoted-printable text to bytes. Soft line breaks (`=` before a line
/// break) are removed; malformed escapes are kept as written.
pub fn decode_quoted_printable(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != b'=' {
            out.push(b);
            i += 1;
            continue;
        }
        match (bytes.get(i + 1), bytes.get(i + 2)) {
            (Some(b'\r'), Some(b'\n')) => i += 3,
            (Some(b'\n'), _) => i += 2,
            (Some(&h), Some(&l)) if h.is_ascii_hexdigit() && l.is_ascii_hexdigit() => {
                out.push(hex_value(h) << 4 | hex_value(l));
                i += 3;
            }
            (None, _) => i += 1,
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

fn hex_value(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        _ => digit - b'A' + 10,
    }
}

/// Bytes to text in the given charset. Supports UTF-8, ISO-8859-1/Latin-1,
/// Windows-1252, UTF-16 (BE/LE/BOM) and UCS-2.
pub fn decode_charset(bytes: &[u8], charset: Option<&str>) -> String {
    let raw_charset = charset.unwrap_or("").trim().to_ascii_uppercase();
    match raw_charset.as_str() {
        "ISO-8859-1" | "ISO_8859-1" | "LATIN1" | "US-ASCII" => {
            bytes.iter().map(|&b| char::from(b)).collect()
        }
        "WINDOWS-1252" | "CP1252" => decode_windows_1252(bytes),
        "UTF-16BE" | "UCS-2" | "UCS2" | "UCS-2BE" => decode_utf16(bytes, true),
        "UTF-16LE" | "UCS-2LE" => decode_utf16(bytes, false),
        "UTF-16" => match bytes {
            [0xFE, 0xFF, rest @ ..] => decode_utf16(rest, true),
            [0xFF, 0xFE, rest @ ..] => decode_utf16(rest, false),
            _ => decode_utf16(bytes, true),
        },
        _ => {
            if let Ok(valid) = std::str::from_utf8(bytes) {
                return valid.to_owned();
            }
            match bytes {
                [0xFE, 0xFF, rest @ ..] => decode_utf16(rest, true),
                [0xFF, 0xFE, rest @ ..] => decode_utf16(rest, false),
                _ if raw_charset.is_empty() || raw_charset == "NATIVE" => {
                    decode_windows_1252(bytes)
                }
                _ => String::from_utf8_lossy(bytes).into_owned(),
            }
        }
    }
}

fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
    let units = bytes.as_chunks::<2>().0.iter().map(|&pair| {
        if big_endian {
            u16::from_be_bytes(pair)
        } else {
            u16::from_le_bytes(pair)
        }
    });
    char::decode_utf16(units)
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn decode_windows_1252(bytes: &[u8]) -> String {
    const C1: [char; 32] = [
        '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}',
        '\u{017D}', '\u{008F}', '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
    ];
    bytes
        .iter()
        .map(|&b| {
            if (0x80..=0x9F).contains(&b) {
                C1[usize::from(b - 0x80)]
            } else {
                char::from(b)
            }
        })
        .collect()
}

pub(crate) fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(&compact)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(compact.trim_end_matches('='))
        })
        .ok()
}

fn media_type_for(kind: &str) -> String {
    let kind = kind.trim().to_ascii_lowercase();
    if kind.is_empty() || kind.contains('/') {
        return kind;
    }
    match kind.as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        other => format!("image/{other}"),
    }
}

fn photo_from(property: &Property) -> Option<Photo> {
    let declared = property
        .param("TYPE")
        .or_else(|| property.param("MEDIATYPE"))
        .or_else(|| {
            property
                .params
                .iter()
                .find(|p| {
                    p.name.is_empty()
                        && matches!(
                            p.value.to_ascii_uppercase().as_str(),
                            "JPEG" | "JPG" | "PNG" | "GIF" | "BMP" | "HEIC" | "WEBP"
                        )
                })
                .map(|p| p.value.as_str())
        })
        .map(media_type_for)
        .unwrap_or_default();

    let value = property.value.as_str();
    if let Some(rest) = value.strip_prefix("data:")
        && let Some((meta, data)) = rest.split_once(',')
        && meta.to_ascii_lowercase().ends_with(";base64")
    {
        let media_type = meta[..meta.len() - ";base64".len()].to_ascii_lowercase();
        return Some(Photo {
            media_type,
            data: data.chars().filter(|c| !c.is_whitespace()).collect(),
            uri: String::new(),
        });
    }

    let is_uri = property
        .param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("uri") || v.eq_ignore_ascii_case("url"));
    if is_uri || property.encoding() != Encoding::Base64 {
        return (!value.is_empty()).then(|| Photo {
            media_type: declared,
            data: String::new(),
            uri: value.to_string(),
        });
    }

    let data: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    decode_base64(&data)?;
    Some(Photo {
        media_type: declared,
        data,
        uri: String::new(),
    })
}

/// Parses a document holding any number of cards. Cards with no name, number,
/// address or call time are dropped; an unterminated card still yields what it
/// had. The text is already decoded, so `CHARSET` only applies to values
/// with a transfer encoding; use [`parse_vcards_bytes`] for raw PBAP data.
pub fn parse_vcards(text: &str) -> Vec<VCard> {
    parse_logical_lines(unfold(text))
}

/// [`parse_vcards`] over raw bytes (a PBAP download): every value is decoded
/// from its own `CHARSET`, including 8-bit values without quoted-printable.
pub fn parse_vcards_bytes(bytes: &[u8]) -> Vec<VCard> {
    parse_logical_lines(unfold_bytes(bytes).into_iter().map(decode_line).collect())
}

fn parse_logical_lines(lines: Vec<String>) -> Vec<VCard> {
    let mut cards = Vec::new();

    let mut current = VCard::default();
    let mut structured_name = String::new();
    let mut in_card = false;

    let mut flush = |current: &mut VCard, structured_name: &mut String| {
        let mut card = std::mem::take(current);
        if card.name.is_empty() {
            card.name = std::mem::take(structured_name);
        }
        structured_name.clear();
        if !card.is_empty() {
            cards.push(card);
        }
    };

    for raw in lines {
        let line = trim(&raw);
        let token = line.to_ascii_uppercase();

        if token == "BEGIN:VCARD" {
            if in_card {
                flush(&mut current, &mut structured_name);
            }
            in_card = true;
            continue;
        }
        if token == "END:VCARD" {
            if in_card {
                flush(&mut current, &mut structured_name);
            }
            in_card = false;
            continue;
        }
        if !in_card {
            continue;
        }

        let Some(property) = parse_property(line) else {
            continue;
        };
        if property.value.is_empty() {
            continue;
        }

        match property.name.as_str() {
            "VERSION" => current.version = property.value.clone(),
            "TEL" | "EMAIL" => {
                let value = trim(&unescape(&property.text())).to_string();
                if value.is_empty() {
                    continue;
                }
                let entry = TypedValue {
                    value,
                    types: property.types(),
                };
                if property.name == "TEL" {
                    current.tels.push(entry);
                } else {
                    current.emails.push(entry);
                }
            }
            "FN" => current.name = trim(&unescape(&property.text())).to_string(),
            "N" => {
                let value = property.text();
                let parts = n_parts(&value);
                current.family = parts[0].clone();
                current.given = parts.get(1).cloned().unwrap_or_default();
                structured_name = name_from_n(&value);
            }
            "NICKNAME" => current.nickname = text_value(&property),
            "TITLE" => current.title = text_value(&property),
            "BDAY" => current.birthday = text_value(&property),
            "NOTE" => current.note = text_value(&property),
            "ORG" => {
                let parts: Vec<String> = n_parts(&property.text())
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect();
                if let Some((first, rest)) = parts.split_first() {
                    current.organization = first.clone();
                    current.department = rest.join(", ");
                }
            }
            "ADR" => {
                let value = format_address(&property.text());
                if !value.is_empty() {
                    current.addresses.push(TypedValue {
                        value,
                        types: property.types(),
                    });
                }
            }
            "URL" => {
                let value = text_value(&property);
                if !value.is_empty() {
                    current.urls.push(TypedValue {
                        value,
                        types: property.types(),
                    });
                }
            }
            "PHOTO" => {
                if current.photo.is_none() {
                    current.photo = photo_from(&property);
                }
            }
            "X-IRMC-CALL-DATETIME" => {
                // The call type is the parameter: ";MISSED:" (iOS) or ";TYPE=MISSED:".
                let head = &token[..token.find(':').unwrap_or(token.len())];
                let kind = head.split_once(';').map_or("", |(_, rest)| trim(rest));
                current.call_type = kind.strip_prefix("TYPE=").unwrap_or(kind).to_string();
                current.call_time = property.value.clone();
            }
            _ => {}
        }
    }

    if in_card {
        flush(&mut current, &mut structured_name);
    }
    cards
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tels(card: &VCard) -> Vec<&str> {
        card.tels.iter().map(|t| t.value.as_str()).collect()
    }

    // --- vCard parsing tests ----------------------------------------------

    #[test]
    fn parses_name_tel_and_email() {
        let cards = parse_vcards(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nTEL;TYPE=CELL:+15555550123\r\n\
             EMAIL;TYPE=INTERNET:ada@example.com\r\nEND:VCARD\r\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "Ada Lovelace");
        assert_eq!(tels(&cards[0]), ["+15555550123"]);
        assert_eq!(cards[0].emails.len(), 1);
        assert_eq!(cards[0].emails[0].value, "ada@example.com");
        assert_eq!(cards[0].version, "3.0");
        assert_eq!(cards[0].tels[0].types, ["cell"]);
        assert_eq!(cards[0].emails[0].types, ["internet"]);
    }

    #[test]
    fn keeps_every_tel_and_email() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:Grace Hopper\nTEL;TYPE=CELL:+15550000001\nTEL;TYPE=HOME:+15550000002\n\
             EMAIL:grace@example.com\nEMAIL:grace@navy.example\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].tels.len(), 2);
        assert_eq!(cards[0].emails.len(), 2);
    }

    #[test]
    fn parses_multiple_cards() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:One\nTEL:+1555000001\nEND:VCARD\n\
             BEGIN:VCARD\nFN:Two\nTEL:+1555000002\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].name, "One");
        assert_eq!(cards[1].name, "Two");
    }

    #[test]
    fn unfolds_continuation_lines() {
        let cards = parse_vcards(
            "BEGIN:VCARD\r\nFN:A Very Long Contact\r\n  Name Indeed\r\nTEL:+1555\r\n 0000001\r\nEND:VCARD\r\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "A Very Long Contact Name Indeed");
        assert_eq!(tels(&cards[0]), ["+15550000001"]);
    }

    #[test]
    fn falls_back_to_structured_name() {
        let cards = parse_vcards("BEGIN:VCARD\nN:Lovelace;Ada;;;\nTEL:+1555\nEND:VCARD\n");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "Ada Lovelace");
    }

    #[test]
    fn prefers_formatted_name_over_structured() {
        let cards =
            parse_vcards("BEGIN:VCARD\nN:Lovelace;Ada;;;\nFN:Countess Ada\nTEL:+1555\nEND:VCARD\n");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "Countess Ada");
    }

    #[test]
    fn unescapes_values() {
        let cards = parse_vcards("BEGIN:VCARD\nFN:Smith\\, Alice\nTEL:+1555\nEND:VCARD\n");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "Smith, Alice");
    }

    #[test]
    fn ignores_malformed_input() {
        assert!(parse_vcards("").is_empty());
        assert!(parse_vcards("not a vcard at all").is_empty());
        assert!(parse_vcards("BEGIN:VCARD\nEND:VCARD\n").is_empty());
    }

    #[test]
    fn recovers_from_unterminated_card() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:First\nTEL:+1555000001\n\
             BEGIN:VCARD\nFN:Second\nTEL:+1555000002\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].name, "First");
        assert_eq!(cards[1].name, "Second");
    }

    #[test]
    fn parses_call_history_entry() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nVERSION:3.0\nFN:\nN:\nTEL;TYPE=CELL:+15555550123\n\
             X-IRMC-CALL-DATETIME;MISSED:20261007T111657\nEND:VCARD\n\
             BEGIN:VCARD\nFN:Ada\nX-IRMC-CALL-DATETIME;TYPE=DIALED:20261005T092933\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].call_type, "MISSED");
        assert_eq!(cards[0].call_time, "20261007T111657");
        assert_eq!(tels(&cards[0]), ["+15555550123"]);
        assert_eq!(cards[1].call_type, "DIALED");
    }

    #[test]
    fn keeps_call_entry_with_no_number() {
        let cards =
            parse_vcards("BEGIN:VCARD\nX-IRMC-CALL-DATETIME;RECEIVED:20261005T122204\nEND:VCARD\n");
        assert_eq!(cards.len(), 1);
        assert!(cards[0].tels.is_empty());
        assert_eq!(cards[0].call_type, "RECEIVED");
    }

    #[test]
    fn keeps_structured_name_parts() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nN:van Beethoven;Ludwig;;;\nFN:Ludwig van Beethoven\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].family, "van Beethoven");
        assert_eq!(cards[0].given, "Ludwig");
    }

    #[test]
    fn splits_structured_name_before_unescaping() {
        let cards = parse_vcards("BEGIN:VCARD\nN:Smith\\;Jones;Ann\\, Marie;;;\nEND:VCARD\n");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].family, "Smith;Jones");
        assert_eq!(cards[0].given, "Ann, Marie");
        assert_eq!(cards[0].name, "Ann, Marie Smith;Jones");
    }

    // --- Tincan extensions --------------------------------------------------

    #[test]
    fn reads_vcard_21_bare_type_parameters() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nVERSION:2.1\nN:Doe;Jane\nTEL;CELL;VOICE:+15555550123\nTEL;HOME:+15555550124\n\
             EMAIL;INTERNET;PREF:jane@example.com\nEND:VCARD\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].version, "2.1");
        assert_eq!(cards[0].tels[0].types, ["cell", "voice"]);
        assert_eq!(cards[0].tels[1].types, ["home"]);
        assert_eq!(cards[0].emails[0].types, ["internet", "pref"]);
    }

    #[test]
    fn merges_repeated_and_comma_separated_types() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:X\nTEL;TYPE=CELL,VOICE;type=pref:+15555550123\nEND:VCARD\n",
        );
        assert_eq!(cards[0].tels[0].types, ["cell", "voice", "pref"]);
    }

    #[test]
    fn strips_group_prefixes() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:X\nitem1.EMAIL;type=INTERNET:x@example.com\nitem1.X-ABLabel:other\nEND:VCARD\n",
        );
        assert_eq!(cards[0].emails[0].value, "x@example.com");
    }

    #[test]
    fn decodes_quoted_printable_with_charset() {
        let cards = parse_vcards(
            "BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen\r\n\
             FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen =\r\nM=C3=BCller\r\nEND:VCARD\r\n",
        );
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "Jürgen Müller");
        assert_eq!(cards[0].family, "Müller");
        assert_eq!(cards[0].given, "Jürgen");
    }

    #[test]
    fn decodes_bare_quoted_printable_in_latin1() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=ISO-8859-1;QUOTED-PRINTABLE:Ren=E9e\nEND:VCARD\n",
        );
        assert_eq!(cards[0].name, "Renée");
    }

    #[test]
    fn reads_base64_photo_in_vcard_30() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nVERSION:3.0\nFN:Pic\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ\n SkZJRg==\nEND:VCARD\n",
        );
        let photo = cards[0].photo.as_ref().expect("photo");
        assert_eq!(photo.media_type, "image/jpeg");
        assert_eq!(photo.data, "/9j/4AAQSkZJRg==");
        assert_eq!(
            photo.bytes().unwrap(),
            [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F']
        );
    }

    #[test]
    fn reads_base64_photo_in_vcard_21_with_unindented_continuation() {
        let cards = parse_vcards(
            "BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Pic\r\nPHOTO;ENCODING=BASE64;PNG:iVBORw0K\r\nGgoAAAAN\r\n\r\n\
             TEL:+15555550123\r\nEND:VCARD\r\n",
        );
        let photo = cards[0].photo.as_ref().expect("photo");
        assert_eq!(photo.media_type, "image/png");
        assert_eq!(&photo.bytes().unwrap()[1..4], b"PNG");
        assert_eq!(tels(&cards[0]), ["+15555550123"]);
    }

    #[test]
    fn reads_photo_uri() {
        let cards = parse_vcards(
            "BEGIN:VCARD\nFN:Pic\nPHOTO;VALUE=URI:https://example.com/a.jpg\nEND:VCARD\n",
        );
        let photo = cards[0].photo.as_ref().expect("photo");
        assert_eq!(photo.uri, "https://example.com/a.jpg");
        assert!(photo.data.is_empty());
    }

    #[test]
    fn drops_undecodable_photo() {
        let cards =
            parse_vcards("BEGIN:VCARD\nFN:Pic\nPHOTO;ENCODING=b;TYPE=JPEG:###\nEND:VCARD\n");
        assert!(cards[0].photo.is_none());
    }

    #[test]
    fn unescape_handles_every_escape() {
        assert_eq!(
            unescape("a\\nb\\Nc\\,d\\;e\\\\f\\xg\\"),
            "a\nb\nc,d;e\\f\\xg\\"
        );
    }

    #[test]
    fn quoted_printable_handles_soft_breaks_and_junk() {
        assert_eq!(decode_quoted_printable("a=\r\nb=\nc=3D=zz="), b"abc==zz");
    }

    #[test]
    fn reads_details() {
        let cards = parse_vcards(concat!(
            "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\n",
            "NICKNAME:Ada\nORG:Analytical Engines;Research;Math\nTITLE:Countess\n",
            "BDAY:1815-12-10\nNOTE:First\\nprogrammer\n",
            "item1.ADR;type=HOME;type=pref:;;12 St James\\nApt 3;London;;SW1;UK\n",
            "item2.URL;type=pref:https://example.com\n",
            "END:VCARD\n",
        ));
        let card = &cards[0];
        assert_eq!(card.nickname, "Ada");
        assert_eq!(card.organization, "Analytical Engines");
        assert_eq!(card.department, "Research, Math");
        assert_eq!(card.title, "Countess");
        assert_eq!(card.birthday, "1815-12-10");
        assert_eq!(card.note, "First\nprogrammer");
        assert_eq!(card.addresses.len(), 1);
        assert_eq!(
            card.addresses[0].value,
            "12 St James\nApt 3\nLondon, SW1\nUK"
        );
        assert_eq!(card.addresses[0].types, ["home", "pref"]);
        assert_eq!(card.urls[0].value, "https://example.com");
    }

    #[test]
    fn formats_partial_addresses() {
        assert_eq!(
            format_address(";;;Springfield;IL;62701;"),
            "Springfield, IL 62701"
        );
        assert_eq!(format_address(";;;;;;"), "");
        assert_eq!(format_address("PO Box 1;;;;;;Canada"), "PO Box 1\nCanada");
    }

    #[test]
    fn raw_bytes_decode_each_value_from_its_own_charset() {
        let mut raw = Vec::new();
        raw.extend_from_slice(b"BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=ISO-8859-1:M");
        raw.push(0xFC); // ü
        raw.extend_from_slice(b"ller;J");
        raw.push(0xF6); // ö
        raw.extend_from_slice(b"rg\r\nNOTE;CHARSET=ISO-8859-1:\xC3\xA9\r\n");
        raw.extend_from_slice(b"ORG;CHARSET=WINDOWS-1252:It\x92s\r\n");
        raw.extend_from_slice(b"TITLE:caf\xE9\r\n");
        raw.extend_from_slice("FN:Zoë ✓\r\n".as_bytes());
        raw.extend_from_slice(b"ADR;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:;;Stra=DFe 1\r\n");
        raw.extend_from_slice(b"TEL:+15555550123\r\nEND:VCARD\r\n");
        let cards = parse_vcards_bytes(&raw);
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!(card.family, "Müller");
        assert_eq!(card.given, "Jörg");
        // Declared Latin-1 wins even when the bytes happen to be valid UTF-8.
        assert_eq!(card.note, "Ã©");
        assert_eq!(card.organization, "It\u{2019}s");
        // Undeclared 8-bit text that isn't UTF-8 reads as Windows-1252.
        assert_eq!(card.title, "café");
        assert_eq!(card.name, "Zoë ✓");
        assert_eq!(card.addresses[0].value, "Straße 1");
        assert_eq!(tels(card), ["+15555550123"]);
    }

    #[test]
    fn raw_bytes_match_text_for_utf8_documents() {
        for text in [
            include_str!("../../../fixtures/vcard/phonebook.vcf"),
            include_str!("../../../fixtures/vcard/call-history.vcf"),
        ] {
            assert_eq!(parse_vcards_bytes(text.as_bytes()), parse_vcards(text));
        }
        assert!(parse_vcards_bytes(b"").is_empty());
        assert!(parse_vcards_bytes(b"\xFF\xFE:\xFF").is_empty());
    }

    #[test]
    fn unfold_keeps_bytes_and_text_in_step() {
        let text = "A:1\r\n 2\r\nB;ENCODING=QUOTED-PRINTABLE:x=\r\ny\r\nPHOTO;ENCODING=b:QUJD\r\nREVG\r\n\r\nC:é";
        let bytes: Vec<String> = unfold_bytes(text.as_bytes())
            .into_iter()
            .map(|l| String::from_utf8(l).expect("utf-8"))
            .collect();
        assert_eq!(bytes, unfold(text));
        assert_eq!(unfold(text)[0], "A:12");
        assert_eq!(unfold(text)[1], "B;ENCODING=QUOTED-PRINTABLE:xy");
        assert_eq!(unfold(text)[2], "PHOTO;ENCODING=b:QUJDREVG");
    }
}

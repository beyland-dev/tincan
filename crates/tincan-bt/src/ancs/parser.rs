//! Reassembles Data Source responses. They carry no total length and arrive
//! split across GATT notifications, so a response is complete only once every
//! requested attribute has been read, in order.

use super::protocol::command;

/// Longer than any cap we ask for, short of what a two-byte length allows.
pub const MAX_ATTRIBUTE_LENGTH: usize = 1024;
/// A response that grows past this is cut off.
pub const MAX_RESPONSE_BYTES: usize = 4096;

/// A complete Data Source response.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Response {
    pub command: u8,
    /// GetNotificationAttributes: the notification's uid.
    pub uid: u32,
    /// GetAppAttributes: the app id echoed back.
    pub app_id: String,
    /// `(attribute id, raw value)` in the order requested.
    pub attributes: Vec<(u8, Vec<u8>)>,
}

impl Response {
    /// The attribute's text, lossily decoded; empty when absent.
    pub fn attribute(&self, id: u8) -> String {
        self.attributes
            .iter()
            .find(|(attr, _)| *attr == id)
            .map(|(_, value)| String::from_utf8_lossy(value).into_owned())
            .unwrap_or_default()
    }

    pub fn has(&self, id: u8) -> bool {
        self.attributes.iter().any(|(attr, _)| *attr == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assembled {
    NeedMore,
    /// The fragment isn't the start of the expected response: the rest of a
    /// response that failed, or a late answer to a request that timed out.
    /// It was dropped and the request is still waiting.
    Stale,
    Complete(Response),
    Error(String),
}

#[derive(Debug, Default)]
pub struct DataSourceAssembler {
    /// The response's header (command and echoed uid or app id) and its
    /// attribute ids.
    expected: Option<(Vec<u8>, Vec<u8>)>,
    buffer: Vec<u8>,
}

enum Parse {
    NeedMore,
    Done(Response, usize),
    Bad(String),
}

/// Whether `bytes` could be the start of a response beginning with `header`.
fn starts_like(bytes: &[u8], header: &[u8]) -> bool {
    let n = bytes.len().min(header.len());
    bytes[..n] == header[..n]
}

impl DataSourceAssembler {
    /// Waits for the response that starts with `header` (see
    /// `Request::response_header`). Fragments that don't are dropped, so a
    /// lost or late response can't shift later ones onto the wrong request.
    pub fn expect(&mut self, header: Vec<u8>, attribute_ids: Vec<u8>) {
        self.expected = Some((header, attribute_ids));
        self.buffer.clear();
    }

    pub fn reset(&mut self) {
        self.expected = None;
        self.buffer.clear();
    }

    pub fn expecting(&self) -> bool {
        self.expected.is_some()
    }

    pub fn append(&mut self, fragment: &[u8]) -> Assembled {
        let Some((header, ids)) = &self.expected else {
            return Assembled::Error("data source fragment with no request in flight".into());
        };
        self.buffer.extend_from_slice(fragment);
        if !starts_like(&self.buffer, header) {
            self.buffer.clear();
            if !starts_like(fragment, header) {
                return Assembled::Stale;
            }
            self.buffer.extend_from_slice(fragment);
        }
        let Some(&command) = header.first() else {
            self.reset();
            return Assembled::Error("data source request with an empty header".into());
        };
        let outcome = match parse(command, ids, &self.buffer) {
            Parse::NeedMore if self.buffer.len() > MAX_RESPONSE_BYTES => {
                Assembled::Error("data source response too long".into())
            }
            Parse::NeedMore => return Assembled::NeedMore,
            Parse::Done(_, used) if used != self.buffer.len() => {
                Assembled::Error("trailing bytes after a data source response".into())
            }
            Parse::Done(response, _) => Assembled::Complete(response),
            Parse::Bad(reason) => Assembled::Error(reason),
        };
        self.reset();
        outcome
    }
}

fn parse(command: u8, ids: &[u8], bytes: &[u8]) -> Parse {
    let Some(&first) = bytes.first() else {
        return Parse::NeedMore;
    };
    if first != command {
        return Parse::Bad("data source response for another command".into());
    }
    let mut response = Response {
        command,
        ..Response::default()
    };
    let mut at = match command {
        command::GET_NOTIFICATION_ATTRIBUTES => {
            let Some(uid) = bytes.get(1..5) else {
                return Parse::NeedMore;
            };
            response.uid = u32::from_le_bytes([uid[0], uid[1], uid[2], uid[3]]);
            5
        }
        command::GET_APP_ATTRIBUTES => {
            let Some(nul) = bytes[1..].iter().position(|&b| b == 0) else {
                return Parse::NeedMore;
            };
            response.app_id = String::from_utf8_lossy(&bytes[1..1 + nul]).into_owned();
            1 + nul + 1
        }
        _ => return Parse::Bad("unsupported data source command".into()),
    };
    for &id in ids {
        let Some(header) = bytes.get(at..at + 3) else {
            return Parse::NeedMore;
        };
        if header[0] != id {
            return Parse::Bad("data source attribute out of order".into());
        }
        let len = usize::from(u16::from_le_bytes([header[1], header[2]]));
        if len > MAX_ATTRIBUTE_LENGTH {
            return Parse::Bad("data source attribute too long".into());
        }
        at += 3;
        let Some(value) = bytes.get(at..at + len) else {
            return Parse::NeedMore;
        };
        response.attributes.push((id, value.to_vec()));
        at += len;
    }
    Parse::Done(response, at)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn push_attribute(bytes: &mut Vec<u8>, id: u8, value: &str) {
        bytes.push(id);
        bytes.extend_from_slice(&u16::try_from(value.len()).expect("len").to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }

    fn notification_response(uid: u32) -> Vec<u8> {
        let mut bytes = vec![0];
        bytes.extend_from_slice(&uid.to_le_bytes());
        push_attribute(&mut bytes, 0, "com.example.app");
        push_attribute(&mut bytes, 1, "Title here");
        bytes
    }

    fn expecting(header: &[u8], ids: &[u8]) -> DataSourceAssembler {
        let mut assembler = DataSourceAssembler::default();
        assembler.expect(header.to_vec(), ids.to_vec());
        assembler
    }

    #[test]
    fn an_empty_header_is_an_error_not_a_panic() {
        let mut assembler = expecting(&[], &[]);
        assert!(matches!(assembler.append(&[0, 1, 2]), Assembled::Error(_)));
        assert!(!assembler.expecting());
    }

    fn notification_header(uid: u32) -> Vec<u8> {
        let mut header = vec![0];
        header.extend_from_slice(&uid.to_le_bytes());
        header
    }

    fn expecting_uid(uid: u32, ids: &[u8]) -> DataSourceAssembler {
        expecting(&notification_header(uid), ids)
    }

    fn complete(result: Assembled) -> Response {
        match result {
            Assembled::Complete(response) => response,
            other => panic!("expected a complete response, got {other:?}"),
        }
    }

    #[test]
    fn reassembles_a_complete_response() {
        let mut assembler = expecting_uid(42, &[0, 1]);
        let response = complete(assembler.append(&notification_response(42)));
        assert_eq!(response.uid, 42);
        assert_eq!(response.attribute(0), "com.example.app");
        assert_eq!(response.attribute(1), "Title here");
        assert!(!assembler.expecting());
    }

    #[test]
    fn reassembles_across_arbitrary_fragment_boundaries() {
        let full = notification_response(7);
        for split in 1..full.len() {
            let mut assembler = expecting_uid(7, &[0, 1]);
            assert_eq!(
                assembler.append(&full[..split]),
                Assembled::NeedMore,
                "split at {split}"
            );
            let response = complete(assembler.append(&full[split..]));
            assert_eq!(response.attribute(1), "Title here");
        }
    }

    #[test]
    fn reassembles_one_byte_at_a_time() {
        let full = notification_response(9);
        let mut assembler = expecting_uid(9, &[0, 1]);
        for byte in &full[..full.len() - 1] {
            assert_eq!(assembler.append(&[*byte]), Assembled::NeedMore);
        }
        complete(assembler.append(&full[full.len() - 1..]));
    }

    #[test]
    fn parses_app_attribute_responses() {
        let mut bytes = b"\x01com.apple.MobileSMS\x00".to_vec();
        push_attribute(&mut bytes, 0, "Messages");
        let response = complete(expecting(b"\x01com.apple.MobileSMS\x00", &[0]).append(&bytes));
        assert_eq!(response.app_id, "com.apple.MobileSMS");
        assert_eq!(response.attribute(0), "Messages");
    }

    #[test]
    fn waits_for_an_unterminated_app_identifier() {
        assert_eq!(
            expecting(b"\x01com.apple.MobileSMS\x00", &[0]).append(b"\x01com"),
            Assembled::NeedMore
        );
    }

    #[test]
    fn drops_a_fragment_that_does_not_start_the_expected_response() {
        let mut assembler = expecting_uid(1, &[0, 1]);
        assert_eq!(assembler.append(&[7, 0, 0, 0, 0]), Assembled::Stale);
        assert_eq!(
            assembler.append(&notification_response(2)),
            Assembled::Stale,
            "another notification's response"
        );
        assert!(assembler.expecting());
        assert_eq!(complete(assembler.append(&notification_response(1))).uid, 1);
    }

    #[test]
    fn drops_the_tail_of_an_earlier_response() {
        let earlier = notification_response(1);
        let mut assembler = expecting_uid(2, &[0, 1]);
        assert_eq!(assembler.append(&earlier[6..]), Assembled::Stale);
        assert_eq!(complete(assembler.append(&notification_response(2))).uid, 2);
    }

    #[test]
    fn restarts_when_a_partial_header_is_followed_by_a_fresh_response() {
        let mut assembler = expecting_uid(3, &[0, 1]);
        assert_eq!(assembler.append(&[0, 3]), Assembled::NeedMore);
        assert_eq!(complete(assembler.append(&notification_response(3))).uid, 3);
    }

    #[test]
    fn drops_an_app_response_for_another_app() {
        let mut other = b"\x01com.apple.mobilephone\x00".to_vec();
        push_attribute(&mut other, 0, "Phone");
        let mut assembler = expecting(b"\x01com.apple.MobileSMS\x00", &[0]);
        assert_eq!(assembler.append(&other), Assembled::Stale);
    }

    #[test]
    fn rejects_attributes_returned_out_of_order() {
        let mut bytes = notification_header(1);
        push_attribute(&mut bytes, 3, "wrong attribute");
        assert!(matches!(
            expecting_uid(1, &[0, 1]).append(&bytes),
            Assembled::Error(_)
        ));
    }

    #[test]
    fn rejects_an_implausible_attribute_length() {
        assert!(matches!(
            expecting_uid(1, &[0]).append(&[0, 1, 0, 0, 0, 0, 0xff, 0xff]),
            Assembled::Error(_)
        ));
    }

    #[test]
    fn rejects_trailing_bytes_after_a_complete_response() {
        let mut bytes = notification_response(3);
        bytes.extend_from_slice(&[0xaa, 0xbb]);
        assert!(matches!(
            expecting_uid(3, &[0, 1]).append(&bytes),
            Assembled::Error(_)
        ));
    }

    #[test]
    fn rejects_a_response_that_grows_without_ending() {
        let ids = [0, 1, 2, 3, 4];
        let mut bytes = notification_header(1);
        for id in ids {
            bytes.push(id);
            bytes.extend_from_slice(&1000u16.to_le_bytes());
            bytes.extend(std::iter::repeat_n(b'a', 1000));
        }
        let mut assembler = expecting_uid(1, &ids);
        let mut result = Assembled::NeedMore;
        for chunk in bytes.chunks(512) {
            result = assembler.append(chunk);
            if result != Assembled::NeedMore {
                break;
            }
        }
        assert!(matches!(result, Assembled::Error(_)));
        assert!(!assembler.expecting());
    }

    #[test]
    fn refuses_fragments_with_no_request_in_flight() {
        let mut assembler = DataSourceAssembler::default();
        assert!(matches!(
            assembler.append(&notification_response(1)),
            Assembled::Error(_)
        ));
    }

    #[test]
    fn recovers_after_an_error() {
        let mut bad = notification_header(4);
        push_attribute(&mut bad, 3, "wrong attribute");
        let mut assembler = expecting_uid(4, &[0, 1]);
        assert!(matches!(assembler.append(&bad), Assembled::Error(_)));
        assert!(!assembler.expecting());
        assembler.expect(notification_header(5), vec![0, 1]);
        assert_eq!(complete(assembler.append(&notification_response(5))).uid, 5);
    }

    #[test]
    fn handles_empty_attribute_values() {
        let mut bytes = notification_header(4);
        push_attribute(&mut bytes, 0, "com.example.app");
        push_attribute(&mut bytes, 1, "");
        let response = complete(expecting_uid(4, &[0, 1]).append(&bytes));
        assert_eq!(response.attribute(1), "");
        assert!(response.has(1));
        assert_eq!(response.attributes.len(), 2);
    }
}

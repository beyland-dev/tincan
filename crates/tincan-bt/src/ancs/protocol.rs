//! The ANCS wire format: Notification Source events, Control Point requests
//! and the attribute ids they name.

pub const SERVICE_UUID: &str = crate::bluez::ANCS_UUID;
pub const NOTIFICATION_SOURCE_UUID: &str = "9fbf120d-6301-42d9-8c58-25e699a21dbd";
pub const CONTROL_POINT_UUID: &str = "69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9";
pub const DATA_SOURCE_UUID: &str = "22eac6e9-24d6-4bb5-be44-b36ace7c7bfb";
/// GAP Device Name: read to check that the LE link is really up.
pub const DEVICE_NAME_UUID: &str = "00002a00-0000-1000-8000-00805f9b34fb";

/// Messages' bundle id; also asked for to probe whether ANCS answers.
pub const APP_ID_MESSAGES: &str = "com.apple.MobileSMS";

/// The cap asked for a notification's message text.
pub const MAX_BODY_LENGTH: u16 = 256;
/// The cap asked for a title or subtitle.
pub const MAX_TITLE_LENGTH: u16 = 128;

pub mod command {
    pub const GET_NOTIFICATION_ATTRIBUTES: u8 = 0;
    pub const GET_APP_ATTRIBUTES: u8 = 1;
    pub const PERFORM_NOTIFICATION_ACTION: u8 = 2;
}

pub mod attribute {
    pub const APP_IDENTIFIER: u8 = 0;
    pub const TITLE: u8 = 1;
    pub const SUBTITLE: u8 = 2;
    pub const MESSAGE: u8 = 3;
    pub const MESSAGE_SIZE: u8 = 4;
    pub const DATE: u8 = 5;
    pub const POSITIVE_ACTION_LABEL: u8 = 6;
    pub const NEGATIVE_ACTION_LABEL: u8 = 7;
    /// The only app attribute: the app's display name.
    pub const APP_DISPLAY_NAME: u8 = 0;
}

pub mod flag {
    pub const SILENT: u8 = 1;
    pub const IMPORTANT: u8 = 2;
    pub const PRE_EXISTING: u8 = 4;
    pub const POSITIVE_ACTION: u8 = 8;
    pub const NEGATIVE_ACTION: u8 = 16;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventId {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Category {
    #[default]
    Other,
    IncomingCall,
    MissedCall,
    Voicemail,
    Social,
    Schedule,
    Email,
    News,
    HealthAndFitness,
    BusinessAndFinance,
    Location,
    Entertainment,
}

impl Category {
    /// Unknown ids are `Other`, as the spec says to treat them.
    pub fn from_id(id: u8) -> Self {
        match id {
            1 => Self::IncomingCall,
            2 => Self::MissedCall,
            3 => Self::Voicemail,
            4 => Self::Social,
            5 => Self::Schedule,
            6 => Self::Email,
            7 => Self::News,
            8 => Self::HealthAndFitness,
            9 => Self::BusinessAndFinance,
            10 => Self::Location,
            11 => Self::Entertainment,
            _ => Self::Other,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Other => "other",
            Self::IncomingCall => "incomingCall",
            Self::MissedCall => "missedCall",
            Self::Voicemail => "voicemail",
            Self::Social => "social",
            Self::Schedule => "schedule",
            Self::Email => "email",
            Self::News => "news",
            Self::HealthAndFitness => "healthAndFitness",
            Self::BusinessAndFinance => "businessAndFinance",
            Self::Location => "location",
            Self::Entertainment => "entertainment",
        }
    }
}

/// One Notification Source packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceEvent {
    pub event: EventId,
    pub flags: u8,
    pub category: Category,
    pub category_count: u8,
    pub uid: u32,
}

impl SourceEvent {
    /// `None` unless the packet is exactly eight bytes with a known event id.
    pub fn parse(packet: &[u8]) -> Option<Self> {
        let [event, flags, category, category_count, a, b, c, d] = *packet else {
            return None;
        };
        let event = match event {
            0 => EventId::Added,
            1 => EventId::Modified,
            2 => EventId::Removed,
            _ => return None,
        };
        Some(Self {
            event,
            flags,
            category: Category::from_id(category),
            category_count,
            uid: u32::from_le_bytes([a, b, c, d]),
        })
    }

    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

/// The two actions a notification can offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Positive,
    Negative,
}

/// What a Control Point write asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    Notification { uid: u32 },
    App { app_id: String },
    Action { uid: u32, action: Action },
}

/// One Control Point write and the attributes its Data Source response
/// carries, in order. Actions have no response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub kind: RequestKind,
    pub payload: Vec<u8>,
    pub attribute_ids: Vec<u8>,
}

impl Request {
    pub fn command(&self) -> u8 {
        match self.kind {
            RequestKind::Notification { .. } => command::GET_NOTIFICATION_ATTRIBUTES,
            RequestKind::App { .. } => command::GET_APP_ATTRIBUTES,
            RequestKind::Action { .. } => command::PERFORM_NOTIFICATION_ACTION,
        }
    }

    /// The bytes its Data Source response starts with: the command and the
    /// uid or app id it echoes.
    pub fn response_header(&self) -> Vec<u8> {
        let mut header = vec![self.command()];
        match &self.kind {
            RequestKind::Notification { uid } | RequestKind::Action { uid, .. } => {
                header.extend_from_slice(&uid.to_le_bytes());
            }
            RequestKind::App { app_id } => {
                header.extend_from_slice(app_id.as_bytes());
                header.push(0);
            }
        }
        header
    }
}

fn cap(attribute_id: u8) -> Option<u16> {
    match attribute_id {
        attribute::TITLE | attribute::SUBTITLE => Some(MAX_TITLE_LENGTH),
        attribute::MESSAGE => Some(MAX_BODY_LENGTH),
        _ => None,
    }
}

/// GetNotificationAttributes. Title, Subtitle and Message carry the mandatory
/// length cap; the others take none.
pub fn notification_request(uid: u32, attribute_ids: &[u8]) -> Request {
    let mut payload = vec![command::GET_NOTIFICATION_ATTRIBUTES];
    payload.extend_from_slice(&uid.to_le_bytes());
    for &id in attribute_ids {
        payload.push(id);
        if let Some(max) = cap(id) {
            payload.extend_from_slice(&max.to_le_bytes());
        }
    }
    Request {
        kind: RequestKind::Notification { uid },
        payload,
        attribute_ids: attribute_ids.to_vec(),
    }
}

/// GetAppAttributes for the display name.
pub fn app_request(app_id: &str) -> Request {
    let mut payload = vec![command::GET_APP_ATTRIBUTES];
    payload.extend_from_slice(app_id.as_bytes());
    payload.push(0);
    payload.push(attribute::APP_DISPLAY_NAME);
    Request {
        kind: RequestKind::App {
            app_id: app_id.to_owned(),
        },
        payload,
        attribute_ids: vec![attribute::APP_DISPLAY_NAME],
    }
}

/// PerformNotificationAction.
pub fn action_request(uid: u32, action: Action) -> Request {
    let mut payload = vec![command::PERFORM_NOTIFICATION_ACTION];
    payload.extend_from_slice(&uid.to_le_bytes());
    payload.push(match action {
        Action::Positive => 0,
        Action::Negative => 1,
    });
    Request {
        kind: RequestKind::Action { uid, action },
        payload,
        attribute_ids: Vec::new(),
    }
}

/// A readable name from a bundle id until the phone supplies one:
/// `com.burbn.instagram` becomes `Instagram`.
pub fn derive_app_name(app_id: &str) -> String {
    let Some((_, tail)) = app_id.rsplit_once('.') else {
        return app_id.to_owned();
    };
    let mut chars = tail.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => app_id.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_source_event() {
        let event = SourceEvent::parse(&[0, 0x18, 4, 2, 0x04, 0x03, 0x02, 0x01]).expect("event");
        assert_eq!(event.event, EventId::Added);
        assert_eq!(event.category, Category::Social);
        assert_eq!(event.category_count, 2);
        assert_eq!(event.uid, 0x0102_0304);
        assert!(event.has(flag::POSITIVE_ACTION));
        assert!(event.has(flag::NEGATIVE_ACTION));
        assert!(!event.has(flag::SILENT));
    }

    #[test]
    fn rejects_source_packets_of_the_wrong_length() {
        assert!(SourceEvent::parse(&[0, 0, 0, 0, 1, 0, 0]).is_none());
        assert!(SourceEvent::parse(&[0, 0, 0, 0, 1, 0, 0, 0, 0]).is_none());
        assert!(SourceEvent::parse(&[]).is_none());
    }

    #[test]
    fn rejects_unknown_event_ids() {
        assert!(SourceEvent::parse(&[3, 0, 0, 0, 1, 0, 0, 0]).is_none());
    }

    #[test]
    fn treats_unknown_categories_as_other() {
        let event = SourceEvent::parse(&[1, 0, 200, 0, 1, 0, 0, 0]).expect("event");
        assert_eq!(event.category, Category::Other);
    }

    #[test]
    fn encodes_a_notification_request() {
        let request = notification_request(
            0x0102_0304,
            &[attribute::APP_IDENTIFIER, attribute::MESSAGE],
        );
        assert_eq!(request.payload[0], 0);
        assert_eq!(
            &request.payload[1..5],
            &[4, 3, 2, 1],
            "the uid is little-endian"
        );
        assert_eq!(request.payload[5], 0, "AppIdentifier takes no length");
        assert_eq!(request.payload[6], 3, "Message follows immediately");
        assert_eq!(
            u16::from_le_bytes([request.payload[7], request.payload[8]]),
            MAX_BODY_LENGTH
        );
        assert_eq!(request.payload.len(), 9);
        assert_eq!(request.attribute_ids, vec![0, 3]);
    }

    #[test]
    fn encodes_date_without_a_length() {
        let request = notification_request(
            1,
            &[attribute::APP_IDENTIFIER, attribute::DATE, attribute::TITLE],
        );
        assert_eq!(request.payload[5], 0);
        assert_eq!(request.payload[6], 5);
        assert_eq!(request.payload[7], 1, "Date takes no length");
        assert_eq!(
            u16::from_le_bytes([request.payload[8], request.payload[9]]),
            MAX_TITLE_LENGTH
        );
        assert_eq!(request.attribute_ids, vec![0, 5, 1]);
    }

    #[test]
    fn encodes_an_app_request() {
        let request = app_request("com.a");
        assert_eq!(request.payload, b"\x01com.a\x00\x00".to_vec());
        assert_eq!(request.attribute_ids, vec![0]);
        assert_eq!(request.command(), command::GET_APP_ATTRIBUTES);
    }

    #[test]
    fn encodes_an_action_request() {
        let request = action_request(0x0102_0304, Action::Negative);
        assert_eq!(request.payload, vec![2, 4, 3, 2, 1, 1]);
        assert!(request.attribute_ids.is_empty());
    }

    #[test]
    fn derives_app_names() {
        assert_eq!(derive_app_name("com.burbn.instagram"), "Instagram");
        assert_eq!(derive_app_name("com.apple.MobileSMS"), "MobileSMS");
        assert_eq!(derive_app_name("plain"), "plain");
        assert_eq!(derive_app_name("trailing."), "trailing.");
    }
}

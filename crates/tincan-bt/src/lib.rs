//! Tincan's Bluetooth layer: BlueZ discovery, OBEX MAP and PBAP sessions, the
//! MAP reconnect supervisor, the ANCS notification feed, and the bMessage and
//! vCard formats the phone speaks.

pub mod ancs;
pub mod bluez;
pub mod bmessage;
pub mod device;
pub mod error;
pub mod map;
pub mod notify;
pub mod obex;
pub mod pbap;
pub mod props;
pub mod redact;
pub mod supervisor;
pub mod system;
mod task;
pub mod vcard;

pub use bmessage::{
    BMessage, Party, Recipient, RecipientKind, build_bmessage, parse_bmessage, parse_bmessage_bytes,
};
pub use error::{Error, ErrorCode, Result, classify_dbus_error};
pub use vcard::{VCard, parse_vcards};

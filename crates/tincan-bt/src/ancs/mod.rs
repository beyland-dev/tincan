//! Apple Notification Center Service: the iPhone's notification feed over the
//! LE link BlueZ already holds.
//!
//! [`AncsSession`] subscribes to the Notification and Data Sources, resolves
//! each notification's attributes one Control Point request at a time, and
//! reports [`AncsEvent`]s. It never advertises, pairs or opens the LE link
//! itself: the phone must already be connected over LE.

pub mod parser;
pub mod protocol;
pub mod registry;
pub mod sequencer;
mod session;

pub use protocol::{Action, Category, EventId, SourceEvent, derive_app_name};
pub use registry::{Decision, Notification, NotificationRegistry};
pub use session::{AncsConfig, AncsEvent, AncsSession, AncsState, PERMISSION_HINT};

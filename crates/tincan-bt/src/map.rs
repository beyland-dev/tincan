//! OBEX MAP (Message Access Profile) client sessions through obexd
//! (`org.bluez.obex`) on the **session** bus.
//!
//! No test or CI job opens a MAP session: a live session competes with any
//! other MAP client for the phone. Only call [`MapSession::open`] from code
//! the user has explicitly asked to talk to their phone (see
//! `examples/map_spike.rs` and `docs/native.md`).
//!
//! obexd API used (BlueZ `doc/org.bluez.obex.*.rst`, `obexd/client/map.c`):
//! - `/org/bluez/obex` `Client1.CreateSession(s destination, a{sv} args) -> o`
//!   with `Target = "map"`, and `Client1.RemoveSession(o)`. Opening a session
//!   also registers for MNS event reports.
//! - The session's `MessageAccess1`: `SetFolder(s)`, `ListFolders(a{sv})`,
//!   `ListMessages(s folder, a{sv} filter) -> a{oa{sv}}`, `UpdateInbox()`,
//!   `PushMessage(s file, s folder, a{sv}) -> (o, a{sv})` and the
//!   `SupportedTypes` property.
//! - Each message object's `Message1.Get(s targetfile, b attachment) -> (o, a{sv})`
//!   and writable `Read` property.
//! - `Transfer1.Status`, watched through `PropertiesChanged` (obexd removes
//!   the transfer object once it settles).
//! - MNS reports surface as `InterfacesAdded` for a new message object plus a
//!   `PropertiesChanged` of its `Status` (`notification`, `sending-success`,
//!   `delivery-success`, ...) or `Folder`.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde::Serialize;

use crate::bmessage::{BMessage, map_handle_from_path, parse_bmessage_bytes, parse_map_timestamp};
use crate::error::{Error, ErrorCode, Result};
use crate::obex::{ObexSession, TransferEnd};
use crate::props::{PropValue, Props, get_bool, get_str, get_u64, props_from_zbus};

pub use crate::obex::{OBEX_CLIENT_PATH, OBEX_SERVICE, session_bus};

/// The default MAP root on an iPhone; the mailbox folders sit under it.
pub const MSG_ROOT: &str = "/telecom/msg";

const DEFAULT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

/// The largest bMessage download accepted. iOS sends text only, so a real
/// message is far smaller; a larger one fails with `INTERNAL`.
pub const MAX_MESSAGE_SIZE: u64 = 16 * 1024 * 1024;
/// The cap when attachments are requested.
pub const MAX_MESSAGE_WITH_ATTACHMENTS: u64 = 64 * 1024 * 1024;

#[zbus::proxy(
    interface = "org.bluez.obex.MessageAccess1",
    default_service = "org.bluez.obex"
)]
trait MessageAccess {
    fn set_folder(&self, name: &str) -> zbus::Result<()>;

    fn list_folders(
        &self,
        filter: HashMap<&str, zbus::Variant<'_>>,
    ) -> zbus::Result<Vec<HashMap<String, zbus::OwnedVariant>>>;

    fn list_messages(
        &self,
        folder: &str,
        filter: HashMap<&str, zbus::Variant<'_>>,
    ) -> zbus::Result<HashMap<zbus::OwnedObjectPath, HashMap<String, zbus::OwnedVariant>>>;

    fn update_inbox(&self) -> zbus::Result<()>;

    fn push_message(
        &self,
        file: &str,
        folder: &str,
        args: HashMap<&str, zbus::Variant<'_>>,
    ) -> zbus::Result<(zbus::OwnedObjectPath, HashMap<String, zbus::OwnedVariant>)>;

    #[zbus(property)]
    fn supported_types(&self) -> zbus::Result<Vec<String>>;
}

#[zbus::proxy(
    interface = "org.bluez.obex.Message1",
    default_service = "org.bluez.obex"
)]
trait ObexMessage {
    fn get(
        &self,
        targetfile: &str,
        attachment: bool,
    ) -> zbus::Result<(zbus::OwnedObjectPath, HashMap<String, zbus::OwnedVariant>)>;

    #[zbus(property)]
    fn set_read(&self, value: bool) -> zbus::Result<()>;
}

/// One entry of a `ListMessages` reply. Times are Unix seconds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapListing {
    /// The stable message handle (the tail of `path`).
    pub handle: String,
    /// The obexd object path; valid only for the session that listed it.
    pub path: String,
    pub folder: String,
    pub subject: String,
    pub timestamp: i64,
    pub sender: String,
    pub sender_address: String,
    pub reply_to: String,
    pub recipient: String,
    pub recipient_address: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub size: Option<u64>,
    pub attachment_size: Option<u64>,
    pub status: String,
    pub priority: bool,
    pub read: bool,
    pub sent: bool,
    pub protected: bool,
}

/// `ListMessages` filter. Unset fields are left out of the request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListFilter {
    pub offset: Option<u16>,
    pub max_count: Option<u16>,
    pub subject_length: Option<u8>,
    /// `YYYYMMDDTHHMMSS` in the phone's local time.
    pub period_begin: Option<String>,
    pub period_end: Option<String>,
    pub read: Option<bool>,
    /// e.g. `sms`, `email`, `mms`.
    pub types: Vec<String>,
    /// Extra listing fields to request (`sender-address`, ...).
    pub fields: Vec<String>,
}

impl ListFilter {
    fn to_dbus(&self) -> HashMap<&'static str, zbus::Variant<'_>> {
        let mut out = HashMap::new();
        if let Some(v) = self.offset {
            out.insert("Offset", zbus::Variant::U16(v));
        }
        if let Some(v) = self.max_count {
            out.insert("MaxCount", zbus::Variant::U16(v));
        }
        if let Some(v) = self.subject_length {
            out.insert("SubjectLength", zbus::Variant::U8(v));
        }
        if let Some(v) = &self.period_begin {
            out.insert("PeriodBegin", zbus::Variant::from(v.as_str()));
        }
        if let Some(v) = &self.period_end {
            out.insert("PeriodEnd", zbus::Variant::from(v.as_str()));
        }
        if let Some(v) = self.read {
            out.insert("Read", zbus::Variant::Bool(v));
        }
        if !self.types.is_empty() {
            let types: Vec<&str> = self.types.iter().map(String::as_str).collect();
            out.insert("Types", zbus::Variant::from(types));
        }
        if !self.fields.is_empty() {
            let fields: Vec<&str> = self.fields.iter().map(String::as_str).collect();
            out.insert("Fields", zbus::Variant::from(fields));
        }
        out
    }
}

/// Builds a [`MapListing`] from one `ListMessages` entry.
pub fn listing_from_props(path: &str, props: &Props) -> MapListing {
    MapListing {
        handle: map_handle_from_path(path),
        path: path.to_string(),
        folder: get_str(props, "Folder").unwrap_or_default(),
        subject: get_str(props, "Subject").unwrap_or_default(),
        timestamp: get_str(props, "Timestamp")
            .map(|t| parse_map_timestamp(&t))
            .unwrap_or_default(),
        sender: get_str(props, "Sender").unwrap_or_default(),
        sender_address: get_str(props, "SenderAddress").unwrap_or_default(),
        reply_to: get_str(props, "ReplyTo").unwrap_or_default(),
        recipient: get_str(props, "Recipient").unwrap_or_default(),
        recipient_address: get_str(props, "RecipientAddress").unwrap_or_default(),
        msg_type: get_str(props, "Type").unwrap_or_default(),
        size: get_u64(props, "Size"),
        attachment_size: get_u64(props, "AttachmentSize"),
        status: get_str(props, "Status").unwrap_or_default(),
        priority: get_bool(props, "Priority"),
        read: get_bool(props, "Read"),
        sent: get_bool(props, "Sent"),
        protected: get_bool(props, "Protected"),
    }
}

/// Listings sorted newest first, then by handle.
pub fn listings_from_reply(reply: &BTreeMap<String, Props>) -> Vec<MapListing> {
    let mut out: Vec<MapListing> = reply
        .iter()
        .map(|(path, props)| listing_from_props(path, props))
        .collect();
    out.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| a.handle.cmp(&b.handle))
    });
    out
}

/// A Bluetooth address in `XX:XX:XX:XX:XX:XX` form.
pub fn validate_address(address: &str) -> Result<()> {
    let parts: Vec<&str> = address.split(':').collect();
    let ok = parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()));
    if ok {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::InvalidInput,
            "Expected a Bluetooth address like AA:BB:CC:DD:EE:FF.",
        ))
    }
}

/// A folder name relative to the current folder: one path component, no
/// `..`, no separators.
pub fn validate_folder(folder: &str) -> Result<()> {
    let ok = !folder.is_empty()
        && folder != "."
        && folder != ".."
        && folder
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::InvalidInput,
            "Expected a MAP folder name such as inbox, sent or outbox.",
        ))
    }
}

/// Whether an error means the obexd session (or the link under it) is gone and
/// must be reopened, rather than one request having failed.
pub fn is_session_lost(err: &Error) -> bool {
    let text = err.message().to_ascii_lowercase();
    err.code() == ErrorCode::NotConnected
        || text.contains("unknownobject")
        || text.contains("transport got disconnected")
        || text.contains("transport is not connected")
}

/// Something obexd reported about this session's messages, from D-Bus signals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MapEvent {
    /// obexd registered a message object, from a listing **or** an MNS
    /// `NewMessage` report. Only `Folder` and `Type` are known for the latter.
    #[serde(rename_all = "camelCase")]
    MessageAdded {
        handle: String,
        path: String,
        folder: String,
        msg_type: String,
    },
    /// MNS report: `notification` (new message), `delivery-success`,
    /// `sending-success`, `delivery-failure` or `sending-failure`, or a
    /// listing's reception status.
    #[serde(rename_all = "camelCase")]
    StatusChanged {
        handle: String,
        path: String,
        status: String,
    },
    /// MNS `MessageShift`/`MessageDeleted` (`/telecom/msg/deleted`).
    #[serde(rename_all = "camelCase")]
    FolderChanged {
        handle: String,
        path: String,
        folder: String,
    },
    #[serde(rename_all = "camelCase")]
    ReadChanged {
        handle: String,
        path: String,
        read: bool,
    },
    #[serde(rename_all = "camelCase")]
    MessageRemoved { handle: String, path: String },
    /// The session object disappeared (link lost or `RemoveSession`).
    SessionClosed,
}

const MESSAGE_IFACE: &str = "org.bluez.obex.Message1";
const ACCESS_IFACE: &str = "org.bluez.obex.MessageAccess1";

fn is_message_of(session: &str, path: &str) -> bool {
    path.strip_prefix(session)
        .and_then(|rest| rest.strip_prefix("/message"))
        .is_some_and(|handle| !handle.is_empty())
}

/// Events for an `InterfacesAdded` signal.
pub fn events_from_interfaces_added(
    session: &str,
    path: &str,
    interfaces: &BTreeMap<String, Props>,
) -> Vec<MapEvent> {
    let Some(props) = interfaces.get(MESSAGE_IFACE) else {
        return Vec::new();
    };
    if !is_message_of(session, path) {
        return Vec::new();
    }
    let handle = map_handle_from_path(path);
    let mut out = vec![MapEvent::MessageAdded {
        handle: handle.clone(),
        path: path.to_string(),
        folder: get_str(props, "Folder").unwrap_or_default(),
        msg_type: get_str(props, "Type").unwrap_or_default(),
    }];
    if let Some(status) = get_str(props, "Status") {
        out.push(MapEvent::StatusChanged {
            handle,
            path: path.to_string(),
            status,
        });
    }
    out
}

/// Events for an `InterfacesRemoved` signal.
pub fn events_from_interfaces_removed(
    session: &str,
    path: &str,
    interfaces: &[String],
) -> Vec<MapEvent> {
    let has = |name: &str| interfaces.iter().any(|i| i == name);
    if path == session && has(ACCESS_IFACE) {
        return vec![MapEvent::SessionClosed];
    }
    if has(MESSAGE_IFACE) && is_message_of(session, path) {
        return vec![MapEvent::MessageRemoved {
            handle: map_handle_from_path(path),
            path: path.to_string(),
        }];
    }
    Vec::new()
}

/// Events for a `PropertiesChanged` signal on a message object.
pub fn events_from_properties_changed(
    session: &str,
    path: &str,
    interface: &str,
    changed: &Props,
) -> Vec<MapEvent> {
    if interface != MESSAGE_IFACE || !is_message_of(session, path) {
        return Vec::new();
    }
    let handle = map_handle_from_path(path);
    let mut out = Vec::new();
    if let Some(status) = get_str(changed, "Status") {
        out.push(MapEvent::StatusChanged {
            handle: handle.clone(),
            path: path.to_string(),
            status,
        });
    }
    if let Some(folder) = get_str(changed, "Folder") {
        out.push(MapEvent::FolderChanged {
            handle: handle.clone(),
            path: path.to_string(),
            folder,
        });
    }
    if let Some(PropValue::Bool(read)) = changed.get("Read") {
        out.push(MapEvent::ReadChanged {
            handle,
            path: path.to_string(),
            read: *read,
        });
    }
    out
}

fn interfaces_from_zbus(
    interfaces: &HashMap<String, HashMap<String, zbus::OwnedVariant>>,
) -> BTreeMap<String, Props> {
    interfaces
        .iter()
        .map(|(name, props)| (name.clone(), props_from_zbus(props)))
        .collect()
}

/// Two match-rule streams merged in the order obexd sent the signals. zbus
/// queues each rule's messages separately, so a plain `select` can hand out
/// a new message's `Status` change before its `InterfacesAdded`. zbus
/// dispatches incoming messages in order, so when one stream holds a signal,
/// every earlier one is already queued on the other: taking the lower serial
/// of the ready heads restores the order.
struct SignalStream {
    streams: [zbus::MessageStream; 2],
    heads: [Option<zbus::Result<zbus::Message>>; 2],
    ended: [bool; 2],
}

impl SignalStream {
    fn new(first: zbus::MessageStream, second: zbus::MessageStream) -> Self {
        Self {
            streams: [first, second],
            heads: [None, None],
            ended: [false, false],
        }
    }

    async fn next(&mut self) -> Option<zbus::Result<zbus::Message>> {
        use futures_util::{FutureExt, StreamExt};
        loop {
            for i in 0..2 {
                if self.heads[i].is_none()
                    && !self.ended[i]
                    && let Some(item) = self.streams[i].next().now_or_never()
                {
                    self.store(i, item);
                }
            }
            let serial = |head: &Option<zbus::Result<zbus::Message>>| match head {
                Some(Ok(message)) => Some(message.primary_header().serial_num().get()),
                Some(Err(_)) => Some(0),
                None => None,
            };
            let pick = match (serial(&self.heads[0]), serial(&self.heads[1])) {
                (Some(a), Some(b)) => Some(usize::from(b < a)),
                (Some(_), None) => Some(0),
                (None, Some(_)) => Some(1),
                (None, None) => None,
            };
            if let Some(i) = pick {
                return self.heads[i].take();
            }
            if self.ended == [true, true] {
                return None;
            }
            let [first, second] = &mut self.streams;
            let (i, item) = match (self.ended[0], self.ended[1]) {
                (false, true) => (0, first.next().await),
                (true, false) => (1, second.next().await),
                _ => tokio::select! {
                    item = first.next() => (0, item),
                    item = second.next() => (1, item),
                },
            };
            self.store(i, item);
        }
    }

    fn store(&mut self, i: usize, item: Option<zbus::Result<zbus::Message>>) {
        match item {
            Some(item) => self.heads[i] = Some(item),
            None => self.ended[i] = true,
        }
    }
}

/// A stream of [`MapEvent`]s for one session. Subscribe before listing so no
/// report falls between the two.
pub struct MapEvents {
    session: String,
    stream: SignalStream,
    pending: std::collections::VecDeque<MapEvent>,
    closed: bool,
}

impl MapEvents {
    /// The next event, or `None` once the session has closed.
    pub async fn next(&mut self) -> Option<MapEvent> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                if event == MapEvent::SessionClosed {
                    self.closed = true;
                }
                return Some(event);
            }
            if self.closed {
                return None;
            }
            let message = match self.stream.next().await? {
                Ok(message) => message,
                Err(err) => {
                    tracing::debug!(error = %err, "MAP signal stream error");
                    continue;
                }
            };
            self.pending.extend(self.decode(&message));
        }
    }

    fn decode(&self, message: &zbus::Message) -> Vec<MapEvent> {
        let header = message.header();
        let member = header.member().map(|m| m.as_str()).unwrap_or_default();
        let body = message.body();
        match member {
            "InterfacesAdded" => body
                .deserialize::<(
                    zbus::OwnedObjectPath,
                    HashMap<String, HashMap<String, zbus::OwnedVariant>>,
                )>()
                .map(|(path, ifaces)| {
                    events_from_interfaces_added(
                        &self.session,
                        path.as_str(),
                        &interfaces_from_zbus(&ifaces),
                    )
                })
                .unwrap_or_default(),
            "InterfacesRemoved" => body
                .deserialize::<(zbus::OwnedObjectPath, Vec<String>)>()
                .map(|(path, ifaces)| {
                    events_from_interfaces_removed(&self.session, path.as_str(), &ifaces)
                })
                .unwrap_or_default(),
            "PropertiesChanged" => {
                let path = header.path().map(|p| p.as_str()).unwrap_or_default();
                body.deserialize::<(String, HashMap<String, zbus::OwnedVariant>, Vec<String>)>()
                    .map(|(iface, changed, _)| {
                        events_from_properties_changed(
                            &self.session,
                            path,
                            &iface,
                            &props_from_zbus(&changed),
                        )
                    })
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }
}

/// How a push ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PushOutcome {
    /// The transfer completed: the phone accepted the message.
    Accepted,
    /// The transfer vanished without reporting a status; the phone may or may
    /// not have taken it.
    Unconfirmed,
    /// Still running at the timeout; the phone may still send it.
    Pending,
}

/// An open obexd MAP session. Call [`MapSession::close`] when done; dropping
/// it without closing leaves the session to obexd until the link drops.
pub struct MapSession {
    obex: ObexSession,
}

impl MapSession {
    /// Opens a MAP session to the phone at `address` and enters
    /// [`MSG_ROOT`]. **Talks to the phone.** obexd registers for MNS event
    /// reports as part of opening the session.
    ///
    /// Refuses (`PERMISSION_DENIED`) a phone BlueZ hasn't paired and bonded
    /// with ([`crate::bluez::require_bonded`]).
    pub async fn open(address: &str) -> Result<Self> {
        validate_address(address)?;
        crate::bluez::require_bonded(&crate::bluez::system_bus().await?, address).await?;
        Self::open_on(session_bus().await?, address).await
    }

    /// [`MapSession::open`] over an existing connection to obexd (tests use
    /// a peer-to-peer fake), without the bond check.
    pub async fn open_on(connection: zbus::Connection, address: &str) -> Result<Self> {
        let obex = ObexSession::create(connection, address, "map", "MAP", DEFAULT_TRANSFER_TIMEOUT)
            .await?;
        let this = Self { obex };
        if let Err(err) = this.set_folder(MSG_ROOT).await {
            this.obex.close().await.ok();
            return Err(err);
        }
        Ok(this)
    }

    pub fn session_path(&self) -> &str {
        self.obex.path().as_str()
    }

    pub fn set_transfer_timeout(&mut self, timeout: Duration) {
        self.obex.transfer_timeout = timeout;
    }

    async fn access(&self) -> Result<MessageAccessProxy<'_>> {
        Ok(MessageAccessProxy::builder(self.obex.connection())
            .path(self.obex.path().as_ref())
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?)
    }

    /// `SetFolder`: an absolute path (`/telecom/msg`), `..`, or a child name.
    pub async fn set_folder(&self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Err(Error::new(ErrorCode::InvalidInput, "Empty MAP folder."));
        }
        self.access().await?.set_folder(path).await?;
        Ok(())
    }

    /// `ListFolders`: the names of the current folder's children.
    pub async fn list_folders(&self) -> Result<Vec<String>> {
        let reply = self.access().await?.list_folders(HashMap::new()).await?;
        Ok(reply
            .iter()
            .filter_map(|entry| get_str(&props_from_zbus(entry), "Name"))
            .collect())
    }

    /// The session's `SupportedTypes` (e.g. `SMS_GSM`).
    pub async fn supported_types(&self) -> Result<Vec<String>> {
        Ok(self.access().await?.supported_types().await?)
    }

    /// `UpdateInbox`: asks the phone to refresh its inbox.
    pub async fn update_inbox(&self) -> Result<()> {
        self.access().await?.update_inbox().await?;
        Ok(())
    }

    /// Lists a mailbox folder (`inbox`, `sent`, `outbox`, ...) under the
    /// current folder, newest first.
    pub async fn list_messages(
        &self,
        folder: &str,
        filter: &ListFilter,
    ) -> Result<Vec<MapListing>> {
        validate_folder(folder)?;
        self.list(folder, filter).await
    }

    /// Lists the current folder itself (`ListMessages("")`), for stacks that
    /// only answer for the folder they are in.
    pub async fn list_current(&self, filter: &ListFilter) -> Result<Vec<MapListing>> {
        self.list("", filter).await
    }

    async fn list(&self, folder: &str, filter: &ListFilter) -> Result<Vec<MapListing>> {
        let reply = self
            .access()
            .await?
            .list_messages(folder, filter.to_dbus())
            .await?;
        let reply: BTreeMap<String, Props> = reply
            .iter()
            .map(|(path, props)| (path.as_str().to_string(), props_from_zbus(props)))
            .collect();
        Ok(listings_from_reply(&reply))
    }

    fn check_message_path(&self, message_path: &str) -> Result<()> {
        if is_message_of(self.session_path(), message_path) {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::InvalidInput,
                "The message does not belong to this MAP session.",
            ))
        }
    }

    async fn message(&self, message_path: &str) -> Result<ObexMessageProxy<'_>> {
        self.check_message_path(message_path)?;
        Ok(ObexMessageProxy::builder(self.obex.connection())
            .path(message_path.to_string())
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await?)
    }

    /// Downloads one message (by the `path` from a listing or event in this
    /// session) into a private temp file and parses it.
    pub async fn get_message(&self, message_path: &str) -> Result<BMessage> {
        Ok(parse_bmessage_bytes(
            &self.get_raw_bytes(message_path, false).await?,
        ))
    }

    /// Downloads one message's raw bMessage bytes. `attachment` is MAP's
    /// Attachment parameter.
    pub async fn get_raw_bytes(&self, message_path: &str, attachment: bool) -> Result<Vec<u8>> {
        let message = self.message(message_path).await?;
        let max_size = if attachment {
            MAX_MESSAGE_WITH_ATTACHMENTS
        } else {
            MAX_MESSAGE_SIZE
        };
        let bytes = self
            .obex
            .download("map-get", "bmsg", max_size, |target| async move {
                message.get(&target, attachment).await
            })
            .await?;
        if bytes.is_empty() {
            return Err(Error::new(
                ErrorCode::Internal,
                "The MAP download was empty.",
            ));
        }
        Ok(bytes)
    }

    /// Downloads one message's raw bMessage text. `attachment` is MAP's
    /// Attachment parameter.
    pub async fn get_raw(&self, message_path: &str, attachment: bool) -> Result<String> {
        let bytes = self.get_raw_bytes(message_path, attachment).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Marks a message read or unread on the phone.
    pub async fn set_read(&self, message_path: &str, read: bool) -> Result<()> {
        self.message(message_path).await?.set_read(read).await?;
        Ok(())
    }

    /// `PushMessage`: hands a bMessage to the phone to send. `folder` is
    /// relative to the current folder (normally `outbox` from [`MSG_ROOT`]).
    /// **Sends a real message.**
    pub async fn push_message(&self, folder: &str, bmessage: &str) -> Result<PushOutcome> {
        if bmessage.is_empty() {
            return Err(Error::new(ErrorCode::InvalidInput, "Empty bMessage."));
        }
        if folder.is_empty() || folder.contains("..") {
            return Err(Error::new(ErrorCode::InvalidInput, "Invalid MAP folder."));
        }
        tracing::debug!(folder, bytes = bmessage.len(), "pushing a message");
        let access = self.access().await?;
        let end = self
            .obex
            .upload("map-push", "bmsg", bmessage.as_bytes(), |file| async move {
                let args = HashMap::from([("Charset", zbus::Variant::from("utf8"))]);
                access.push_message(&file, folder, args).await
            })
            .await?;
        Ok(match end {
            TransferEnd::Complete => PushOutcome::Accepted,
            TransferEnd::Vanished => PushOutcome::Unconfirmed,
            TransferEnd::TimedOut => PushOutcome::Pending,
        })
    }

    /// Subscribes to this session's message events. obexd emits
    /// `InterfacesAdded` from its ObjectManager at `/` and `PropertiesChanged`
    /// from each message object.
    pub async fn events(&self) -> Result<MapEvents> {
        let manager = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .path("/")
            .interface("org.freedesktop.DBus.ObjectManager")
            .build()?;
        let props = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")
            .member("PropertiesChanged")
            .path_namespace(self.session_path())
            .arg(0, MESSAGE_IFACE)
            .build()?;
        let connection = self.obex.connection();
        let manager = zbus::MessageStream::for_match_rule(manager, connection, None).await?;
        let props = zbus::MessageStream::for_match_rule(props, connection, None).await?;
        Ok(MapEvents {
            session: self.session_path().to_string(),
            stream: SignalStream::new(manager, props),
            pending: Default::default(),
            closed: false,
        })
    }

    /// `RemoveSession`. Takes `&self` so a shared session can be closed; any
    /// later call on it fails. Closing twice is a no-op.
    pub async fn close(&self) -> Result<()> {
        self.obex.close().await
    }

    pub fn is_closed(&self) -> bool {
        self.obex.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::props::PropValue;

    fn s(v: &str) -> PropValue {
        PropValue::Str(v.to_string())
    }

    #[test]
    fn parses_listing_entries() {
        let props: Props = [
            ("Folder", s("/telecom/msg/inbox")),
            ("Subject", s("Running late")),
            ("Timestamp", s("20260102T030405Z")),
            ("Sender", s("Jane Doe")),
            ("SenderAddress", s("+15555550123")),
            ("Type", s("sms-gsm")),
            ("Size", PropValue::Int(12)),
            ("Status", s("complete")),
            ("Read", PropValue::Bool(true)),
            ("Sent", PropValue::Bool(false)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let listing = listing_from_props(
            "/org/bluez/obex/client/session3/message4000000000000007",
            &props,
        );
        assert_eq!(listing.handle, "4000000000000007");
        assert_eq!(listing.timestamp, 1_767_323_045);
        assert_eq!(listing.sender_address, "+15555550123");
        assert_eq!(listing.msg_type, "sms-gsm");
        assert_eq!(listing.size, Some(12));
        assert!(listing.read && !listing.sent);
        assert_eq!(listing.attachment_size, None);
    }

    #[test]
    fn sorts_listings_newest_first() {
        let entry =
            |ts: &str| -> Props { [("Timestamp".to_string(), s(ts))].into_iter().collect() };
        let reply: BTreeMap<String, Props> = [
            ("/s/message1".to_string(), entry("20260101T000000Z")),
            ("/s/message2".to_string(), entry("20260301T000000Z")),
            ("/s/message3".to_string(), entry("20260201T000000Z")),
        ]
        .into_iter()
        .collect();
        let handles: Vec<String> = listings_from_reply(&reply)
            .into_iter()
            .map(|l| l.handle)
            .collect();
        assert_eq!(handles, ["2", "3", "1"]);
    }

    #[test]
    fn builds_list_filters() {
        let filter = ListFilter {
            max_count: Some(50),
            read: Some(false),
            types: vec!["sms".into()],
            ..ListFilter::default()
        };
        let dbus = filter.to_dbus();
        assert_eq!(dbus.len(), 3);
        assert_eq!(dbus.get("MaxCount"), Some(&zbus::Variant::U16(50)));
        assert_eq!(dbus.get("Read"), Some(&zbus::Variant::Bool(false)));
        assert!(ListFilter::default().to_dbus().is_empty());
    }

    #[test]
    fn validates_inputs() {
        assert!(validate_address("AA:BB:CC:DD:EE:0f").is_ok());
        assert!(validate_address("AA:BB:CC:DD:EE").is_err());
        assert!(validate_address("AA:BB:CC:DD:EE:GG").is_err());
        assert!(validate_folder("inbox").is_ok());
        assert!(validate_folder("..").is_err());
        assert!(validate_folder("inbox/../x").is_err());
        assert!(validate_folder("").is_err());
    }

    const SESSION: &str = "/org/bluez/obex/client/session3";

    #[test]
    fn decodes_new_message_reports() {
        let path = format!("{SESSION}/message4000000000000007");
        let ifaces: BTreeMap<String, Props> = [(
            MESSAGE_IFACE.to_string(),
            [
                ("Folder".to_string(), s("telecom/msg/inbox")),
                ("Type".to_string(), s("sms-gsm")),
            ]
            .into_iter()
            .collect(),
        )]
        .into_iter()
        .collect();
        assert_eq!(
            events_from_interfaces_added(SESSION, &path, &ifaces),
            [MapEvent::MessageAdded {
                handle: "4000000000000007".into(),
                path: path.clone(),
                folder: "telecom/msg/inbox".into(),
                msg_type: "sms-gsm".into(),
            }]
        );
        let changed: Props = [("Status".to_string(), s("notification"))]
            .into_iter()
            .collect();
        assert_eq!(
            events_from_properties_changed(SESSION, &path, MESSAGE_IFACE, &changed),
            [MapEvent::StatusChanged {
                handle: "4000000000000007".into(),
                path: path.clone(),
                status: "notification".into(),
            }]
        );
        let read: Props = [("Read".to_string(), PropValue::Bool(true))]
            .into_iter()
            .collect();
        assert!(matches!(
            events_from_properties_changed(SESSION, &path, MESSAGE_IFACE, &read)[..],
            [MapEvent::ReadChanged { read: true, .. }]
        ));
    }

    #[test]
    fn ignores_other_sessions_and_interfaces() {
        let other = "/org/bluez/obex/client/session30/message1";
        let ifaces: BTreeMap<String, Props> = [(MESSAGE_IFACE.to_string(), Props::new())]
            .into_iter()
            .collect();
        assert!(events_from_interfaces_added(SESSION, other, &ifaces).is_empty());
        let transfer = format!("{SESSION}/transfer1");
        let changed: Props = [("Status".to_string(), s("complete"))]
            .into_iter()
            .collect();
        assert!(
            events_from_properties_changed(
                SESSION,
                &transfer,
                "org.bluez.obex.Transfer1",
                &changed
            )
            .is_empty()
        );
    }

    #[test]
    fn decodes_removals() {
        let removed = vec![ACCESS_IFACE.to_string(), "org.bluez.obex.Session1".into()];
        assert_eq!(
            events_from_interfaces_removed(SESSION, SESSION, &removed),
            [MapEvent::SessionClosed]
        );
        let path = format!("{SESSION}/message9");
        assert_eq!(
            events_from_interfaces_removed(SESSION, &path, &[MESSAGE_IFACE.to_string()]),
            [MapEvent::MessageRemoved {
                handle: "9".into(),
                path
            }]
        );
    }

    #[test]
    fn detects_lost_sessions() {
        let lost = Error::new(
            ErrorCode::Internal,
            "org.bluez.obex.Error.Failed: Transport got disconnected",
        );
        assert!(is_session_lost(&lost));
        assert!(is_session_lost(&Error::new(ErrorCode::NotConnected, "x")));
        assert!(!is_session_lost(&Error::new(ErrorCode::Timeout, "x")));
    }
}

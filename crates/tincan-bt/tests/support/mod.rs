//! An in-process fake of obexd's MAP client API, served over a peer-to-peer
//! zbus connection. It mirrors what an iPhone looked like through obexd in
//! the Phase 0.1 spike (`docs/native.md`): listing registers message objects
//! and announces them with `InterfacesAdded`, a new message is an
//! `InterfacesAdded` followed by `Status = "notification"`, and there are no
//! sending or delivery reports. It also answers PBAP sessions with a
//! synthetic phonebook. All data here is synthetic.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zbus::{Connection, OwnedObjectPath};
use zbus::{OwnedVariant as OwnedValue, Variant as Value};

pub const CLIENT_PATH: &str = "/org/bluez/obex";
pub const SESSION_PATH: &str = "/org/bluez/obex/client/session1";
pub const PBAP_SESSION_PATH: &str = "/org/bluez/obex/client/session2";
pub const ADDRESS: &str = "00:11:22:33:44:55";

const MANAGER_IFACE: &str = "org.freedesktop.DBus.ObjectManager";
const MESSAGE_IFACE: &str = "org.bluez.obex.Message1";
const ACCESS_IFACE: &str = "org.bluez.obex.MessageAccess1";
const PHONEBOOK_IFACE: &str = "org.bluez.obex.PhonebookAccess1";

/// How the next transfers settle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransferMode {
    /// `Status = "complete"` before the method returns.
    #[default]
    Immediate,
    /// `active`, then `complete` through `PropertiesChanged` a moment later.
    Signalled,
    /// `active`, then the object disappears without a final status.
    Vanish,
    /// `active`, then `error`.
    Fail,
    /// `active` forever.
    Stall,
}

#[derive(Debug, Clone)]
pub struct FakeMessage {
    pub handle: String,
    pub folder: String,
    pub subject: String,
    pub timestamp: String,
    pub sender_address: String,
    pub read: bool,
    pub body: String,
}

impl FakeMessage {
    pub fn inbox(handle: &str, timestamp: &str, body: &str) -> Self {
        Self {
            handle: handle.to_owned(),
            folder: "inbox".to_owned(),
            subject: body.chars().take(20).collect(),
            timestamp: timestamp.to_owned(),
            sender_address: "5550100".to_owned(),
            read: true,
            body: body.to_owned(),
        }
    }

    pub fn path(&self) -> String {
        format!("{SESSION_PATH}/message{}", self.handle)
    }

    pub fn bmessage(&self) -> String {
        let status = if self.read { "READ" } else { "UNREAD" };
        let msg = format!("BEGIN:MSG\r\n{}\r\nEND:MSG\r\n", self.body);
        [
            "BEGIN:BMSG\r\nVERSION:1.0\r\n".to_owned(),
            format!("STATUS:{status}\r\nTYPE:SMS_GSM\r\n"),
            format!("FOLDER:telecom/msg/{}\r\n", self.folder),
            "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Example;Alex\r\n".to_owned(),
            format!("TEL:{}\r\nEND:VCARD\r\n", self.sender_address),
            "BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\n".to_owned(),
            format!("LENGTH:{}\r\n{msg}", msg.len()),
            "END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n".to_owned(),
        ]
        .concat()
    }

    fn props(&self, status: Option<&str>) -> HashMap<String, OwnedValue> {
        let mut props = HashMap::from([
            (
                "Folder".to_owned(),
                owned(format!("/telecom/msg/{}", self.folder)),
            ),
            ("Subject".to_owned(), owned(self.subject.clone())),
            ("Timestamp".to_owned(), owned(self.timestamp.clone())),
            ("Sender".to_owned(), owned(self.sender_address.clone())),
            (
                "SenderAddress".to_owned(),
                owned(self.sender_address.clone()),
            ),
            ("Type".to_owned(), owned("sms-gsm".to_owned())),
            ("Size".to_owned(), owned(self.body.len() as u64)),
            ("Read".to_owned(), owned(self.read)),
            ("Sent".to_owned(), owned(false)),
            ("Priority".to_owned(), owned(false)),
            ("Protected".to_owned(), owned(false)),
        ]);
        if let Some(status) = status {
            props.insert("Status".to_owned(), owned(status.to_owned()));
        }
        props
    }
}

/// A synthetic phonebook entry.
#[derive(Debug, Clone, Default)]
pub struct FakeContact {
    pub given: String,
    pub family: String,
    pub tel: String,
    pub email: String,
    /// Base64 JPEG data, or empty.
    pub photo: String,
    /// Call history entries: `MISSED`, `RECEIVED` or `DIALED`.
    pub call: String,
}

impl FakeContact {
    pub fn new(given: &str, family: &str, tel: &str) -> Self {
        Self {
            given: given.to_owned(),
            family: family.to_owned(),
            tel: tel.to_owned(),
            ..Self::default()
        }
    }

    /// The card as obexd writes it for `format` (`vcard21`/`vcard30`),
    /// keeping only `fields` (all when empty).
    pub fn vcard(&self, format: &str, fields: &[String]) -> String {
        let want = |name: &str| fields.is_empty() || fields.iter().any(|f| f == name);
        let v30 = format == "vcard30";
        let mut card = String::from("BEGIN:VCARD\r\n");
        card.push_str(if v30 {
            "VERSION:3.0\r\n"
        } else {
            "VERSION:2.1\r\n"
        });
        if want("FN") {
            card.push_str(&format!("FN:{} {}\r\n", self.given, self.family));
        }
        // N is mandatory in both versions.
        card.push_str(&format!("N:{};{};;;\r\n", self.family, self.given));
        if want("TEL") && !self.tel.is_empty() {
            let ty = if v30 { "TYPE=CELL" } else { "CELL" };
            card.push_str(&format!("TEL;{ty}:{}\r\n", self.tel));
        }
        if want("EMAIL") && !self.email.is_empty() {
            let ty = if v30 { "TYPE=INTERNET" } else { "INTERNET" };
            card.push_str(&format!("EMAIL;{ty}:{}\r\n", self.email));
        }
        if want("PHOTO") && !self.photo.is_empty() {
            let params = if v30 {
                "ENCODING=b;TYPE=JPEG"
            } else {
                "ENCODING=BASE64;TYPE=JPEG"
            };
            card.push_str(&format!("PHOTO;{params}:{}\r\n", self.photo));
        }
        if want("X-IRMC-CALL-DATETIME") && !self.call.is_empty() {
            card.push_str(&format!(
                "X-IRMC-CALL-DATETIME;{}:20261005T122204\r\n",
                self.call
            ));
        }
        card.push_str("END:VCARD\r\n");
        card
    }
}

#[derive(Debug, Default)]
pub struct State {
    /// The next this many `CreateSession` calls fail like a phone that is
    /// still tearing down its previous session.
    pub fail_creates: u32,
    pub creates: u32,
    pub session_open: bool,
    pub folder: String,
    pub messages: Vec<FakeMessage>,
    /// (folder, bMessage text) of every push.
    pub pushed: Vec<(String, String)>,
    pub transfer_mode: TransferMode,
    pub next_transfer: u32,
    /// The keys of the last `ListMessages` filter.
    pub last_filter: Vec<String>,
    pub pbap_open: bool,
    /// `pb`: contacts, entry 0 the owner's card.
    pub contacts: Vec<FakeContact>,
    /// `cch`: call history.
    pub calls: Vec<FakeContact>,
    /// `fav`.
    pub favorites: Vec<FakeContact>,
    /// The phonebook last `Select`ed.
    pub selected: Option<String>,
    /// The filters of the last `PullAll`: (format, offset, max count, fields).
    pub last_pull: Option<(String, u16, u16, Vec<String>)>,
}

pub type Shared = Arc<Mutex<State>>;

fn owned<'a>(value: impl Into<Value<'a>>) -> OwnedValue {
    OwnedValue::try_from(value.into()).expect("owned value")
}

fn object_path(text: &str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(text.to_owned()).expect("object path")
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.obex.Error")]
enum ObexError {
    #[zbus(error)]
    ZBus(zbus::Error),
    Failed(String),
    InvalidArguments(String),
    Forbidden(String),
}

struct FakeClient(Shared);

#[zbus::interface(interface = "org.bluez.obex.Client1")]
impl FakeClient {
    async fn create_session(
        &self,
        destination: String,
        args: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<OwnedObjectPath, ObexError> {
        let target = args
            .get("Target")
            .and_then(|v| String::try_from(v.clone()).ok());
        if destination != ADDRESS {
            return Err(ObexError::InvalidArguments("Invalid arguments".to_owned()));
        }
        match target.as_deref() {
            Some("map") => {}
            Some("pbap") => {
                self.0.lock().expect("state").pbap_open = true;
                connection
                    .object_server()
                    .at(PBAP_SESSION_PATH, FakePhonebook(self.0.clone()))
                    .await?;
                return Ok(object_path(PBAP_SESSION_PATH));
            }
            _ => return Err(ObexError::InvalidArguments("Invalid arguments".to_owned())),
        }
        {
            let mut state = self.0.lock().expect("state");
            state.creates += 1;
            if state.fail_creates > 0 {
                state.fail_creates -= 1;
                return Err(ObexError::Failed("Internal Server Error".to_owned()));
            }
            state.session_open = true;
        }
        connection
            .object_server()
            .at(SESSION_PATH, FakeAccess(self.0.clone()))
            .await?;
        Ok(object_path(SESSION_PATH))
    }

    async fn remove_session(
        &self,
        session: OwnedObjectPath,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<(), ObexError> {
        if session.as_str() == PBAP_SESSION_PATH && self.0.lock().expect("state").pbap_open {
            close_pbap(connection, &self.0).await;
            return Ok(());
        }
        let open = self.0.lock().expect("state").session_open;
        if session.as_str() != SESSION_PATH || !open {
            return Err(ObexError::InvalidArguments("Invalid arguments".to_owned()));
        }
        close_session(connection, &self.0).await;
        Ok(())
    }
}

struct FakeAccess(Shared);

#[zbus::interface(interface = "org.bluez.obex.MessageAccess1")]
impl FakeAccess {
    fn set_folder(&self, name: String) -> Result<(), ObexError> {
        let mut state = self.0.lock().expect("state");
        if name == "/telecom/msg" {
            state.folder = name;
            Ok(())
        } else {
            Err(ObexError::Failed("Not Found".to_owned()))
        }
    }

    fn list_folders(
        &self,
        _filter: HashMap<String, OwnedValue>,
    ) -> Vec<HashMap<String, OwnedValue>> {
        ["inbox", "sent", "outbox", "deleted"]
            .iter()
            .map(|name| HashMap::from([("Name".to_owned(), owned(*name))]))
            .collect()
    }

    async fn list_messages(
        &self,
        folder: String,
        filter: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<HashMap<OwnedObjectPath, HashMap<String, OwnedValue>>, ObexError> {
        let listed: Vec<FakeMessage> = {
            let mut state = self.0.lock().expect("state");
            let mut keys: Vec<String> = filter.keys().cloned().collect();
            keys.sort();
            state.last_filter = keys;
            let max = filter
                .get("MaxCount")
                .and_then(|v| u16::try_from(v.clone()).ok())
                .map_or(usize::MAX, usize::from);
            let unread_only = filter
                .get("Read")
                .and_then(|v| bool::try_from(v.clone()).ok())
                == Some(false);
            let mut matching: Vec<FakeMessage> = state
                .messages
                .iter()
                .filter(|m| m.folder == folder && (!unread_only || !m.read))
                .cloned()
                .collect();
            matching.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            // iOS only ever exposes the ten newest messages.
            matching.truncate(max.min(10));
            matching
        };
        let mut reply = HashMap::new();
        for message in &listed {
            let path = message.path();
            register_message(connection, &self.0, message).await?;
            emit_interfaces_added(connection, &path, message.props(Some("complete"))).await?;
            reply.insert(object_path(&path), message.props(None));
        }
        Ok(reply)
    }

    fn update_inbox(&self) {}

    async fn push_message(
        &self,
        file: String,
        folder: String,
        args: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<(OwnedObjectPath, HashMap<String, OwnedValue>), ObexError> {
        let charset = args
            .get("Charset")
            .and_then(|v| String::try_from(v.clone()).ok());
        if charset.as_deref() != Some("utf8") {
            return Err(ObexError::InvalidArguments("Invalid arguments".to_owned()));
        }
        let text = std::fs::read_to_string(&file)
            .map_err(|e| ObexError::Failed(format!("read failed: {e}")))?;
        self.0.lock().expect("state").pushed.push((folder, text));
        let transfer = start_transfer(connection, &self.0, SESSION_PATH, None).await?;
        Ok((object_path(&transfer), HashMap::new()))
    }

    #[zbus(property)]
    fn supported_types(&self) -> Vec<String> {
        vec!["SMS_GSM".to_owned()]
    }
}

struct FakePhonebook(Shared);

impl FakePhonebook {
    fn entries(&self) -> Result<Vec<FakeContact>, ObexError> {
        let state = self.0.lock().expect("state");
        match state.selected.as_deref() {
            Some("pb") => Ok(state.contacts.clone()),
            Some("cch") => Ok(state.calls.clone()),
            Some("fav") => Ok(state.favorites.clone()),
            Some(_) => Ok(Vec::new()),
            None => Err(ObexError::Forbidden("Call Select first".to_owned())),
        }
    }

    fn selected(&self) -> Option<String> {
        self.0.lock().expect("state").selected.clone()
    }
}

#[zbus::interface(interface = "org.bluez.obex.PhonebookAccess1")]
impl FakePhonebook {
    fn select(&self, location: String, phonebook: String) -> Result<(), ObexError> {
        let known = ["pb", "ich", "och", "mch", "cch", "fav", "spd"];
        if !matches!(location.as_str(), "int" | "internal") || !known.contains(&phonebook.as_str())
        {
            return Err(ObexError::InvalidArguments("Invalid arguments".to_owned()));
        }
        self.0.lock().expect("state").selected = Some(phonebook);
        Ok(())
    }

    async fn pull_all(
        &self,
        targetfile: String,
        filters: HashMap<String, OwnedValue>,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<(OwnedObjectPath, HashMap<String, OwnedValue>), ObexError> {
        let entries = self.entries()?;
        let text = |key: &str| {
            filters
                .get(key)
                .and_then(|v| String::try_from(v.clone()).ok())
        };
        let number = |key: &str| filters.get(key).and_then(|v| u16::try_from(v.clone()).ok());
        let format = text("Format").unwrap_or_else(|| "vcard21".to_owned());
        if format != "vcard21" && format != "vcard30" {
            return Err(ObexError::InvalidArguments("Invalid arguments".to_owned()));
        }
        let offset = number("Offset").unwrap_or(0);
        let max = number("MaxCount").unwrap_or(u16::MAX);
        let fields = filters
            .get("Fields")
            .and_then(|v| Vec::<String>::try_from(v.clone()).ok())
            .unwrap_or_default();
        let body: String = entries
            .iter()
            .skip(usize::from(offset))
            .take(usize::from(max))
            .map(|c| c.vcard(&format, &fields))
            .collect();
        self.0.lock().expect("state").last_pull = Some((format, offset, max, fields));
        let transfer = start_transfer(
            connection,
            &self.0,
            PBAP_SESSION_PATH,
            Some((targetfile.clone(), body)),
        )
        .await?;
        Ok((
            object_path(&transfer),
            HashMap::from([("Filename".to_owned(), owned(targetfile))]),
        ))
    }

    fn get_size(&self) -> Result<u16, ObexError> {
        Ok(u16::try_from(self.entries()?.len()).unwrap_or(u16::MAX))
    }

    #[zbus(property)]
    fn folder(&self) -> String {
        self.selected()
            .map(|book| format!("/telecom/{book}"))
            .unwrap_or_default()
    }

    #[zbus(property)]
    fn database_identifier(&self) -> String {
        "0123456789abcdef0123456789abcdef".to_owned()
    }

    #[zbus(property)]
    fn primary_counter(&self) -> String {
        format!("{:032x}", self.0.lock().expect("state").contacts.len())
    }

    #[zbus(property)]
    fn secondary_counter(&self) -> String {
        format!("{:032x}", 0)
    }
}

struct FakeMessageObject {
    shared: Shared,
    handle: String,
    status: String,
}

impl FakeMessageObject {
    fn find<R>(&self, f: impl FnOnce(&mut FakeMessage) -> R) -> Option<R> {
        let mut state = self.shared.lock().expect("state");
        state
            .messages
            .iter_mut()
            .find(|m| m.handle == self.handle)
            .map(f)
    }
}

#[zbus::interface(interface = "org.bluez.obex.Message1")]
impl FakeMessageObject {
    async fn get(
        &self,
        targetfile: String,
        _attachment: bool,
        #[zbus(connection)] connection: &Connection,
    ) -> Result<(OwnedObjectPath, HashMap<String, OwnedValue>), ObexError> {
        let body = self
            .find(|m| m.bmessage())
            .ok_or_else(|| ObexError::Failed("Not Found".to_owned()))?;
        let transfer = start_transfer(
            connection,
            &self.shared,
            SESSION_PATH,
            Some((targetfile.clone(), body)),
        )
        .await?;
        Ok((
            object_path(&transfer),
            HashMap::from([("Filename".to_owned(), owned(targetfile))]),
        ))
    }

    #[zbus(property)]
    fn read(&self) -> bool {
        self.find(|m| m.read).unwrap_or_default()
    }

    #[zbus(property)]
    fn set_read(&mut self, value: bool) {
        self.find(|m| m.read = value);
    }

    #[zbus(property)]
    fn status(&self) -> String {
        self.status.clone()
    }
}

struct FakeTransfer {
    status: String,
}

#[zbus::interface(interface = "org.bluez.obex.Transfer1")]
impl FakeTransfer {
    #[zbus(property)]
    fn status(&self) -> String {
        self.status.clone()
    }
}

async fn register_message(
    connection: &Connection,
    shared: &Shared,
    message: &FakeMessage,
) -> zbus::Result<()> {
    let path = message.path();
    let server = connection.object_server();
    if server
        .interface::<_, FakeMessageObject>(path.as_str())
        .await
        .is_err()
    {
        server
            .at(
                path.as_str(),
                FakeMessageObject {
                    shared: shared.clone(),
                    handle: message.handle.clone(),
                    status: "complete".to_owned(),
                },
            )
            .await?;
    }
    Ok(())
}

async fn emit_interfaces_added(
    connection: &Connection,
    path: &str,
    props: HashMap<String, OwnedValue>,
) -> zbus::Result<()> {
    let interfaces = HashMap::from([(MESSAGE_IFACE.to_owned(), props)]);
    connection
        .emit_signal(
            None::<()>,
            "/",
            MANAGER_IFACE,
            "InterfacesAdded",
            &(object_path(path), interfaces),
        )
        .await
}

async fn emit_interfaces_removed(
    connection: &Connection,
    path: &str,
    interfaces: &[&str],
) -> zbus::Result<()> {
    let interfaces: Vec<String> = interfaces.iter().map(|s| (*s).to_owned()).collect();
    connection
        .emit_signal(
            None::<()>,
            "/",
            MANAGER_IFACE,
            "InterfacesRemoved",
            &(object_path(path), interfaces),
        )
        .await
}

/// Registers a transfer object and settles it per the current mode. For a
/// download, `file` (target, contents) is written before it completes.
async fn start_transfer(
    connection: &Connection,
    shared: &Shared,
    session: &str,
    file: Option<(String, String)>,
) -> zbus::Result<String> {
    let (mode, path) = {
        let mut state = shared.lock().expect("state");
        state.next_transfer += 1;
        (
            state.transfer_mode,
            format!("{session}/transfer{}", state.next_transfer),
        )
    };
    let initial = if mode == TransferMode::Immediate {
        if let Some((target, body)) = &file {
            std::fs::write(target, body).map_err(|e| zbus::Error::Failure(e.to_string()))?;
        }
        "complete"
    } else {
        "active"
    };
    connection
        .object_server()
        .at(
            path.as_str(),
            FakeTransfer {
                status: initial.to_owned(),
            },
        )
        .await?;
    if matches!(
        mode,
        TransferMode::Signalled | TransferMode::Vanish | TransferMode::Fail
    ) {
        let connection = connection.clone();
        let path = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let server = connection.object_server();
            if mode == TransferMode::Vanish {
                let _ = server.remove::<FakeTransfer, _>(path.as_str()).await;
                return;
            }
            if mode == TransferMode::Signalled
                && let Some((target, body)) = &file
            {
                let _ = std::fs::write(target, body);
            }
            if let Ok(iface) = server.interface::<_, FakeTransfer>(path.as_str()).await {
                iface.get_mut().await.status = if mode == TransferMode::Signalled {
                    "complete".to_owned()
                } else {
                    "error".to_owned()
                };
                let _ = iface
                    .get()
                    .await
                    .status_changed(iface.signal_emitter())
                    .await;
            }
        });
    }
    Ok(path)
}

async fn close_session(connection: &Connection, shared: &Shared) {
    let paths: Vec<String> = {
        let mut state = shared.lock().expect("state");
        state.session_open = false;
        state.messages.iter().map(FakeMessage::path).collect()
    };
    let server = connection.object_server();
    for path in paths {
        if server
            .remove::<FakeMessageObject, _>(path.as_str())
            .await
            .unwrap_or(false)
        {
            let _ = emit_interfaces_removed(connection, &path, &[MESSAGE_IFACE]).await;
        }
    }
    let _ = server.remove::<FakeAccess, _>(SESSION_PATH).await;
    let _ = emit_interfaces_removed(
        connection,
        SESSION_PATH,
        &[ACCESS_IFACE, "org.bluez.obex.Session1"],
    )
    .await;
}

async fn close_pbap(connection: &Connection, shared: &Shared) {
    {
        let mut state = shared.lock().expect("state");
        state.pbap_open = false;
        state.selected = None;
    }
    let _ = connection
        .object_server()
        .remove::<FakePhonebook, _>(PBAP_SESSION_PATH)
        .await;
    let _ = emit_interfaces_removed(
        connection,
        PBAP_SESSION_PATH,
        &[PHONEBOOK_IFACE, "org.bluez.obex.Session1"],
    )
    .await;
}

/// The fake obexd: the server end of the connection plus its state.
pub struct FakeObexd {
    pub state: Shared,
    pub server: Connection,
}

impl FakeObexd {
    /// Starts the fake and returns it with a client connection to it.
    pub async fn start(state: State) -> (Self, Connection) {
        let shared: Shared = Arc::new(Mutex::new(state));
        let (server_socket, client_socket) =
            std::os::unix::net::UnixStream::pair().expect("socket pair");
        let server = zbus::connection::Builder::unix_stream(server_socket)
            .server(zbus::Guid::generate())
            .p2p()
            .serve_at(CLIENT_PATH, FakeClient(shared.clone()))
            .build();
        let client = zbus::connection::Builder::unix_stream(client_socket)
            .p2p()
            .build();
        let (server, client) = tokio::join!(server, client);
        (
            Self {
                state: shared,
                server: server.expect("server connection"),
            },
            client.expect("client connection"),
        )
    }

    /// Serves the fake on `connection`, a bus connection; the caller owns
    /// `org.bluez.obex` on it.
    pub async fn serve(connection: Connection, state: State) -> zbus::Result<Self> {
        let shared: Shared = Arc::new(Mutex::new(state));
        connection
            .object_server()
            .at(CLIENT_PATH, FakeClient(shared.clone()))
            .await?;
        Ok(Self {
            state: shared,
            server: connection,
        })
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().expect("state"))
    }

    /// The phone reports a new message the way iOS did in the spike:
    /// `InterfacesAdded`, then `Status = "notification"`.
    pub async fn deliver(&self, message: FakeMessage) {
        let path = message.path();
        self.with(|s| s.messages.push(message.clone()));
        register_message(&self.server, &self.state, &message)
            .await
            .expect("register message");
        emit_interfaces_added(&self.server, &path, message.props(None))
            .await
            .expect("interfaces added");
        let iface = self
            .server
            .object_server()
            .interface::<_, FakeMessageObject>(path.as_str())
            .await
            .expect("message object");
        iface.get_mut().await.status = "notification".to_owned();
        iface
            .get()
            .await
            .status_changed(iface.signal_emitter())
            .await
            .expect("status changed");
    }

    /// The link drops: obexd tears the session down on its own.
    pub async fn drop_link(&self) {
        close_session(&self.server, &self.state).await;
        if self.with(|s| s.pbap_open) {
            close_pbap(&self.server, &self.state).await;
        }
    }
}

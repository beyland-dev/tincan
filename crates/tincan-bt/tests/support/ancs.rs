//! A fake iPhone as BlueZ shows it over LE: an ObjectManager at `/`, one
//! powered adapter, one connected device with the ANCS service (Control
//! Point, Notification Source, Data Source) and the GAP Device Name.
//!
//! Control Point writes are answered on the Data Source in [`FRAGMENT`]-byte
//! notifications, after the write returns, as a phone does. With sharing off
//! ([`State::sharing`]) every write is refused, the way iOS answers before the
//! user allows notifications. Subscribing to the Notification Source replays
//! the backlog with the PreExisting flag.
//!
//! The module is shared: `tests/ancs_session.rs` serves it over a
//! peer-to-peer connection, and `examples/fake_ancs.rs` serves it on a
//! private bus (for the Node tests). All data here is synthetic.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use zbus::{OwnedObjectPath, OwnedVariant, Variant as Value};

pub const ADDRESS: &str = "00:11:22:33:44:55";
pub const HCI0: &str = "/org/bluez/hci0";
pub const DEVICE: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55";
pub const SERVICE: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55/service0023";
pub const CONTROL_POINT: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55/service0023/char0024";
pub const NOTIFICATION_SOURCE: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55/service0023/char0027";
pub const DATA_SOURCE: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55/service0023/char002a";
pub const DEVICE_NAME: &str = "/org/bluez/hci0/dev_00_11_22_33_44_55/service0001/char0002";
/// Data Source notifications are split into pieces this long (an LE MTU of
/// 23 less the ATT header).
pub const FRAGMENT: usize = 20;

const ANCS_UUID: &str = "7905f431-b5ce-4e99-a40f-4b1e122d00d0";
const CONTROL_POINT_UUID: &str = "69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9";
const NOTIFICATION_SOURCE_UUID: &str = "9fbf120d-6301-42d9-8c58-25e699a21dbd";
const DATA_SOURCE_UUID: &str = "22eac6e9-24d6-4bb5-be44-b36ace7c7bfb";
const DEVICE_NAME_UUID: &str = "00002a00-0000-1000-8000-00805f9b34fb";
const CHARACTERISTIC: &str = "org.bluez.GattCharacteristic1";

pub const SILENT: u8 = 1;
pub const IMPORTANT: u8 = 2;
pub const PRE_EXISTING: u8 = 4;
pub const POSITIVE_ACTION: u8 = 8;
pub const NEGATIVE_ACTION: u8 = 16;

/// A notification on the fake phone.
#[derive(Debug, Clone, PartialEq)]
pub struct Posted {
    pub uid: u32,
    pub category: u8,
    pub flags: u8,
    pub app_id: String,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    /// `yyyyMMdd'T'HHmmSS`, local time.
    pub date: String,
}

impl Posted {
    pub fn message(uid: u32, title: &str, body: &str) -> Self {
        Self {
            uid,
            category: 4,
            flags: POSITIVE_ACTION | NEGATIVE_ACTION,
            app_id: "com.apple.MobileSMS".into(),
            title: title.into(),
            subtitle: String::new(),
            body: body.into(),
            date: "20261031T120000".into(),
        }
    }

    fn attribute(&self, id: u8) -> &str {
        match id {
            0 => &self.app_id,
            1 => &self.title,
            2 => &self.subtitle,
            3 => &self.body,
            5 => &self.date,
            _ => "",
        }
    }
}

#[derive(Debug)]
pub struct State {
    pub connected: bool,
    /// Whether BlueZ has the phone paired and bonded (stored keys).
    pub bonded: bool,
    /// Whether the user allows sharing notifications with this computer.
    pub sharing: bool,
    pub notifying: HashMap<String, bool>,
    /// Notifications already on the phone, replayed on subscribing.
    pub backlog: Vec<Posted>,
    /// Every notification the phone can describe, by uid.
    pub notifications: HashMap<u32, Posted>,
    /// App id → display name. Unknown apps get an empty name.
    pub apps: HashMap<String, String>,
    /// Control Point writes, raw.
    pub writes: Vec<Vec<u8>>,
    /// Actions performed: (uid, 0 positive / 1 negative).
    pub actions: Vec<(u32, u8)>,
    /// Characteristic methods called: `StartNotify char0027`, …
    pub calls: Vec<String>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            connected: true,
            bonded: true,
            sharing: true,
            notifying: HashMap::new(),
            backlog: Vec::new(),
            notifications: HashMap::new(),
            apps: HashMap::from([
                ("com.apple.MobileSMS".to_owned(), "Messages".to_owned()),
                ("com.example.chat".to_owned(), "Example Chat".to_owned()),
            ]),
            writes: Vec::new(),
            actions: Vec::new(),
            calls: Vec::new(),
        }
    }
}

#[derive(Clone, Default)]
pub struct FakePhone {
    pub state: Arc<Mutex<State>>,
}

fn variant(value: Value<'_>) -> OwnedVariant {
    OwnedVariant::try_from(value).expect("variant")
}

fn path(p: &str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(p).expect("path")
}

fn short(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

impl FakePhone {
    pub fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().expect("state"))
    }

    pub fn calls(&self) -> Vec<String> {
        self.with(|s| s.calls.clone())
    }

    /// Serves every object on `connection`.
    pub async fn serve(&self, connection: &zbus::Connection) -> zbus::Result<()> {
        let server = connection.object_server();
        server.at("/", ObjectManager(self.clone())).await?;
        for (p, role) in [
            (CONTROL_POINT, Role::ControlPoint),
            (NOTIFICATION_SOURCE, Role::NotificationSource),
            (DATA_SOURCE, Role::DataSource),
            (DEVICE_NAME, Role::DeviceName),
        ] {
            server
                .at(
                    p,
                    Characteristic {
                        phone: self.clone(),
                        path: p,
                        role,
                    },
                )
                .await?;
        }
        Ok(())
    }

    /// Posts a notification: the phone now knows it, and announces it on the
    /// Notification Source if someone is subscribed.
    pub async fn post(&self, connection: &zbus::Connection, posted: Posted) -> zbus::Result<()> {
        self.with(|s| s.notifications.insert(posted.uid, posted.clone()));
        self.source(connection, 0, posted.flags, posted.category, posted.uid)
            .await
    }

    /// Changes a known notification and announces it as Modified.
    pub async fn modify(&self, connection: &zbus::Connection, posted: Posted) -> zbus::Result<()> {
        self.with(|s| s.notifications.insert(posted.uid, posted.clone()));
        self.source(connection, 1, posted.flags, posted.category, posted.uid)
            .await
    }

    pub async fn remove(&self, connection: &zbus::Connection, uid: u32) -> zbus::Result<()> {
        let category = self.with(|s| s.notifications.remove(&uid).map_or(0, |n| n.category));
        self.source(connection, 2, 0, category, uid).await
    }

    /// Sends a raw Notification Source packet.
    pub async fn source(
        &self,
        connection: &zbus::Connection,
        event: u8,
        flags: u8,
        category: u8,
        uid: u32,
    ) -> zbus::Result<()> {
        if !self.notifying(NOTIFICATION_SOURCE) {
            return Ok(());
        }
        let mut packet = vec![event, flags, category, 1];
        packet.extend_from_slice(&uid.to_le_bytes());
        value_changed(connection, NOTIFICATION_SOURCE, packet).await
    }

    /// Drops the LE link: GATT reads fail and the device reports
    /// `Connected = false`.
    pub async fn disconnect(&self, connection: &zbus::Connection) -> zbus::Result<()> {
        self.with(|s| {
            s.connected = false;
            s.notifying.clear();
        });
        device_changed(connection, "Connected", false).await
    }

    pub async fn reconnect(&self, connection: &zbus::Connection) -> zbus::Result<()> {
        self.with(|s| s.connected = true);
        device_changed(connection, "Connected", true).await
    }

    fn notifying(&self, p: &str) -> bool {
        self.with(|s| s.notifying.get(p).copied().unwrap_or(false))
    }

    /// The Data Source response to a Control Point write, if it gets one.
    fn respond(&self, payload: &[u8]) -> Result<Option<Vec<u8>>, BluezError> {
        let invalid = || BluezError::Failed("Invalid parameter (0xa2)".into());
        let command = *payload.first().ok_or_else(invalid)?;
        match command {
            0 => {
                let uid = u32::from_le_bytes(
                    payload
                        .get(1..5)
                        .ok_or_else(invalid)?
                        .try_into()
                        .expect("uid"),
                );
                let posted = self
                    .with(|s| s.notifications.get(&uid).cloned())
                    .ok_or_else(invalid)?;
                let mut out = payload[..5].to_vec();
                let mut at = 5;
                while let Some(&id) = payload.get(at) {
                    at += 1;
                    let mut value = posted.attribute(id).as_bytes().to_vec();
                    if matches!(id, 1..=3) {
                        let cap = u16::from_le_bytes(
                            payload
                                .get(at..at + 2)
                                .ok_or_else(invalid)?
                                .try_into()
                                .expect("cap"),
                        );
                        at += 2;
                        value.truncate(usize::from(cap));
                    }
                    push(&mut out, id, &value);
                }
                Ok(Some(out))
            }
            1 => {
                let nul = payload[1..]
                    .iter()
                    .position(|&b| b == 0)
                    .ok_or_else(invalid)?;
                let app_id = String::from_utf8_lossy(&payload[1..1 + nul]).into_owned();
                let name = self.with(|s| s.apps.get(&app_id).cloned().unwrap_or_default());
                let mut out = payload[..2 + nul].to_vec();
                for &id in &payload[2 + nul..] {
                    push(&mut out, id, if id == 0 { name.as_bytes() } else { b"" });
                }
                Ok(Some(out))
            }
            2 => {
                let uid = u32::from_le_bytes(
                    payload
                        .get(1..5)
                        .ok_or_else(invalid)?
                        .try_into()
                        .expect("uid"),
                );
                let action = *payload.get(5).ok_or_else(invalid)?;
                self.with(|s| s.actions.push((uid, action)));
                Ok(None)
            }
            _ => Err(BluezError::Failed("Unknown command (0xa0)".into())),
        }
    }
}

fn push(out: &mut Vec<u8>, id: u8, value: &[u8]) {
    out.push(id);
    out.extend_from_slice(&(value.len() as u16).to_le_bytes());
    out.extend_from_slice(value);
}

async fn value_changed(connection: &zbus::Connection, p: &str, value: Vec<u8>) -> zbus::Result<()> {
    let changed = HashMap::from([("Value".to_owned(), variant(Value::from(value)))]);
    connection
        .emit_signal(
            None::<()>,
            p,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &(CHARACTERISTIC, changed, Vec::<String>::new()),
        )
        .await
}

async fn notifying_changed(connection: &zbus::Connection, p: &str, on: bool) -> zbus::Result<()> {
    let changed = HashMap::from([("Notifying".to_owned(), variant(Value::from(on)))]);
    connection
        .emit_signal(
            None::<()>,
            p,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &(CHARACTERISTIC, changed, Vec::<String>::new()),
        )
        .await
}

async fn device_changed(connection: &zbus::Connection, key: &str, on: bool) -> zbus::Result<()> {
    let changed = HashMap::from([(key.to_owned(), variant(Value::from(on)))]);
    connection
        .emit_signal(
            None::<()>,
            DEVICE,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &("org.bluez.Device1", changed, Vec::<String>::new()),
        )
        .await
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
pub enum BluezError {
    #[zbus(error)]
    ZBus(zbus::Error),
    Failed(String),
    InProgress(String),
    NotAuthorized(String),
    NotPermitted(String),
}

struct ObjectManager(FakePhone);

type Wire = HashMap<String, HashMap<String, OwnedVariant>>;

#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl ObjectManager {
    fn get_managed_objects(&self) -> HashMap<OwnedObjectPath, Wire> {
        let (connected, bonded, notifying) = self
            .0
            .with(|s| (s.connected, s.bonded, s.notifying.clone()));
        let props = |entries: Vec<(&str, Value<'static>)>| -> HashMap<String, OwnedVariant> {
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), variant(v)))
                .collect()
        };
        let mut objects = HashMap::new();
        objects.insert(
            path(HCI0),
            HashMap::from([(
                "org.bluez.Adapter1".to_owned(),
                props(vec![
                    ("Address", Value::from("AA:AA:AA:AA:AA:AA")),
                    ("Powered", Value::from(true)),
                ]),
            )]),
        );
        objects.insert(
            path(DEVICE),
            HashMap::from([(
                "org.bluez.Device1".to_owned(),
                props(vec![
                    ("Address", Value::from(ADDRESS)),
                    ("Alias", Value::from("Fake iPhone")),
                    ("Adapter", Value::from(path(HCI0))),
                    ("Paired", Value::from(bonded)),
                    ("Bonded", Value::from(bonded)),
                    ("Connected", Value::from(connected)),
                    ("UUIDs", Value::from(vec![ANCS_UUID.to_owned()])),
                ]),
            )]),
        );
        if !connected {
            return objects;
        }
        objects.insert(
            path(SERVICE),
            HashMap::from([(
                "org.bluez.GattService1".to_owned(),
                props(vec![("UUID", Value::from(ANCS_UUID))]),
            )]),
        );
        for (p, uuid) in [
            (CONTROL_POINT, CONTROL_POINT_UUID),
            (NOTIFICATION_SOURCE, NOTIFICATION_SOURCE_UUID),
            (DATA_SOURCE, DATA_SOURCE_UUID),
            (DEVICE_NAME, DEVICE_NAME_UUID),
        ] {
            objects.insert(
                path(p),
                HashMap::from([(
                    CHARACTERISTIC.to_owned(),
                    props(vec![
                        ("UUID", Value::from(uuid)),
                        (
                            "Notifying",
                            Value::from(notifying.get(p).copied().unwrap_or(false)),
                        ),
                    ]),
                )]),
            );
        }
        objects
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    ControlPoint,
    NotificationSource,
    DataSource,
    DeviceName,
}

struct Characteristic {
    phone: FakePhone,
    path: &'static str,
    role: Role,
}

impl Characteristic {
    fn record(&self, method: &str) {
        let call = format!("{method} {}", short(self.path));
        self.phone.with(|s| s.calls.push(call));
    }

    fn connected(&self) -> Result<(), BluezError> {
        if self.phone.with(|s| s.connected) {
            Ok(())
        } else {
            Err(BluezError::Failed("Not connected".into()))
        }
    }
}

#[zbus::interface(name = "org.bluez.GattCharacteristic1")]
impl Characteristic {
    fn read_value(&self, _options: HashMap<String, OwnedVariant>) -> Result<Vec<u8>, BluezError> {
        self.record("ReadValue");
        self.connected()?;
        match self.role {
            Role::DeviceName => Ok(b"Fake iPhone".to_vec()),
            _ => Err(BluezError::NotPermitted("Read not permitted".into())),
        }
    }

    async fn write_value(
        &self,
        value: Vec<u8>,
        _options: HashMap<String, OwnedVariant>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.record("WriteValue");
        self.connected()?;
        if self.role != Role::ControlPoint {
            return Err(BluezError::NotPermitted("Write not permitted".into()));
        }
        self.phone.with(|s| s.writes.push(value.clone()));
        if !self.phone.with(|s| s.sharing) {
            return Err(BluezError::NotAuthorized("Operation Not Authorized".into()));
        }
        if let Some(response) = self.phone.respond(&value)? {
            let connection = connection.clone();
            let phone = self.phone.clone();
            tokio::spawn(async move {
                // After the write's reply, as a phone answers.
                tokio::task::yield_now().await;
                for chunk in response.chunks(FRAGMENT) {
                    if !phone.notifying(DATA_SOURCE) {
                        return;
                    }
                    let _ = value_changed(&connection, DATA_SOURCE, chunk.to_vec()).await;
                }
            });
        }
        Ok(())
    }

    async fn start_notify(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.record("StartNotify");
        self.connected()?;
        if !matches!(self.role, Role::NotificationSource | Role::DataSource) {
            return Err(BluezError::NotPermitted("Notify not permitted".into()));
        }
        if self.phone.notifying(self.path) {
            return Err(BluezError::InProgress("In Progress".into()));
        }
        self.phone
            .with(|s| s.notifying.insert(self.path.to_owned(), true));
        let _ = notifying_changed(connection, self.path, true).await;
        if self.role == Role::NotificationSource {
            let backlog = self.phone.with(|s| s.backlog.clone());
            let connection = connection.clone();
            let phone = self.phone.clone();
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                for mut posted in backlog {
                    posted.flags |= PRE_EXISTING;
                    let _ = phone.post(&connection, posted).await;
                }
            });
        }
        Ok(())
    }

    async fn stop_notify(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.record("StopNotify");
        if !self.phone.notifying(self.path) {
            return Err(BluezError::Failed("No notify session started".into()));
        }
        self.phone
            .with(|s| s.notifying.insert(self.path.to_owned(), false));
        let _ = notifying_changed(connection, self.path, false).await;
        Ok(())
    }

    #[zbus(property)]
    fn notifying(&self) -> bool {
        self.phone.notifying(self.path)
    }

    #[zbus(property, name = "UUID")]
    fn uuid(&self) -> String {
        match self.role {
            Role::ControlPoint => CONTROL_POINT_UUID,
            Role::NotificationSource => NOTIFICATION_SOURCE_UUID,
            Role::DataSource => DATA_SOURCE_UUID,
            Role::DeviceName => DEVICE_NAME_UUID,
        }
        .to_owned()
    }
}

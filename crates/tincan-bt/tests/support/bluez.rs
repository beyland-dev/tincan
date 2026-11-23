//! A fake BlueZ: an ObjectManager at `/`, `AgentManager1` at `/org/bluez`,
//! one powered adapter and two devices. One device is known and unpaired;
//! the other only appears once discovery starts.
//!
//! `Device1.Pair` asks the registered agent to confirm [`PASSKEY`], then
//! marks the device paired. It returns `AuthenticationRejected` when the
//! agent declines, and `AuthenticationCanceled` after `CancelPairing`.
//!
//! The module is shared: `tests/device.rs` serves it over a peer-to-peer
//! connection, and `examples/fake_bluez.rs` serves it on a private bus
//! (for the Node tests).
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use zbus::{OwnedObjectPath, OwnedVariant, Variant as Value};

pub const HCI0: &str = "/org/bluez/hci0";
pub const KNOWN: &str = "00:11:22:33:44:55";
pub const DISCOVERED: &str = "66:77:88:99:AA:BB";
/// Shown zero-padded as `004242`.
pub const PASSKEY: u32 = 4242;
const MAP_MSE: &str = "00001132-0000-1000-8000-00805f9b34fb";

pub fn device_path(address: &str) -> String {
    format!("{HCI0}/dev_{}", address.replace(':', "_"))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Prop {
    Bool(bool),
    Str(String),
    List(Vec<String>),
}

impl Prop {
    fn variant(&self) -> OwnedVariant {
        let value = match self {
            Self::Bool(b) => Value::from(*b),
            Self::Str(s) => Value::from(s.clone()),
            Self::List(l) => Value::from(l.clone()),
        };
        OwnedVariant::try_from(value).expect("variant")
    }
}

type Props = BTreeMap<String, Prop>;
type Wire = HashMap<String, HashMap<String, OwnedVariant>>;

#[derive(Debug, Default)]
pub struct State {
    pub adapter: Props,
    /// Device path → Device1 properties.
    pub devices: BTreeMap<String, Props>,
    /// The agent registered with AgentManager1: (bus name, path).
    pub agent: Option<(Option<String>, String)>,
    /// Method names called, in order.
    pub calls: Vec<String>,
}

fn device_props(address: &str, alias: &str) -> Props {
    Props::from([
        ("Address".to_owned(), Prop::Str(address.to_owned())),
        ("Alias".to_owned(), Prop::Str(alias.to_owned())),
        ("Name".to_owned(), Prop::Str(alias.to_owned())),
        ("Icon".to_owned(), Prop::Str("phone".to_owned())),
        ("Adapter".to_owned(), Prop::Str(HCI0.to_owned())),
        ("Paired".to_owned(), Prop::Bool(false)),
        ("Bonded".to_owned(), Prop::Bool(false)),
        ("Trusted".to_owned(), Prop::Bool(false)),
        ("Connected".to_owned(), Prop::Bool(false)),
        ("UUIDs".to_owned(), Prop::List(vec![MAP_MSE.to_owned()])),
    ])
}

fn wire(props: &Props) -> HashMap<String, OwnedVariant> {
    props
        .iter()
        .map(|(k, v)| (k.clone(), v.variant()))
        .collect()
}

#[derive(Clone)]
pub struct FakeBluez {
    pub state: Arc<Mutex<State>>,
    cancel: Arc<Notify>,
}

impl Default for FakeBluez {
    fn default() -> Self {
        let state = State {
            adapter: Props::from([
                (
                    "Address".to_owned(),
                    Prop::Str("AA:AA:AA:AA:AA:AA".to_owned()),
                ),
                ("Name".to_owned(), Prop::Str("fake".to_owned())),
                ("Alias".to_owned(), Prop::Str("fake".to_owned())),
                ("Powered".to_owned(), Prop::Bool(true)),
                ("Pairable".to_owned(), Prop::Bool(true)),
                ("Discovering".to_owned(), Prop::Bool(false)),
            ]),
            devices: BTreeMap::from([(device_path(KNOWN), device_props(KNOWN, "Known Phone"))]),
            ..State::default()
        };
        Self {
            state: Arc::new(Mutex::new(state)),
            cancel: Arc::new(Notify::new()),
        }
    }
}

impl FakeBluez {
    pub fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().expect("state"))
    }

    pub fn device_prop(&self, address: &str, key: &str) -> Option<Prop> {
        self.with(|s| s.devices.get(&device_path(address))?.get(key).cloned())
    }

    fn record(&self, call: &str) {
        self.with(|s| s.calls.push(call.to_owned()));
    }

    /// Serves every object on `connection`.
    pub async fn serve(&self, connection: &zbus::Connection) -> zbus::Result<()> {
        let server = connection.object_server();
        server.at("/", ObjectManager(self.clone())).await?;
        server.at("/org/bluez", AgentManager(self.clone())).await?;
        server.at(HCI0, AdapterObject(self.clone())).await?;
        let paths: Vec<String> = self.with(|s| s.devices.keys().cloned().collect());
        for path in paths {
            server
                .at(path.clone(), DeviceObject::new(self.clone(), &path))
                .await?;
        }
        Ok(())
    }

    /// Sets a device property and emits PropertiesChanged for it.
    pub async fn set_device(
        &self,
        connection: &zbus::Connection,
        path: &str,
        key: &str,
        value: Prop,
    ) -> zbus::Result<()> {
        self.with(|s| {
            if let Some(props) = s.devices.get_mut(path) {
                props.insert(key.to_owned(), value.clone());
            }
        });
        changed(connection, path, "org.bluez.Device1", key, value).await
    }

    async fn set_adapter(
        &self,
        connection: &zbus::Connection,
        key: &str,
        value: Prop,
    ) -> zbus::Result<()> {
        self.with(|s| s.adapter.insert(key.to_owned(), value.clone()));
        changed(connection, HCI0, "org.bluez.Adapter1", key, value).await
    }

    async fn add_device(
        &self,
        connection: &zbus::Connection,
        address: &str,
        alias: &str,
    ) -> zbus::Result<()> {
        let path = device_path(address);
        let props = device_props(address, alias);
        let fresh = self.with(|s| {
            if s.devices.contains_key(&path) {
                return false;
            }
            s.devices.insert(path.clone(), props.clone());
            true
        });
        if !fresh {
            return Ok(());
        }
        connection
            .object_server()
            .at(path.clone(), DeviceObject::new(self.clone(), &path))
            .await?;
        let interfaces: Wire = HashMap::from([("org.bluez.Device1".to_owned(), wire(&props))]);
        connection
            .emit_signal(
                None::<()>,
                "/",
                "org.freedesktop.DBus.ObjectManager",
                "InterfacesAdded",
                &(OwnedObjectPath::try_from(path).expect("path"), interfaces),
            )
            .await
    }
}

async fn changed(
    connection: &zbus::Connection,
    path: &str,
    interface: &str,
    key: &str,
    value: Prop,
) -> zbus::Result<()> {
    let changed = HashMap::from([(key.to_owned(), value.variant())]);
    connection
        .emit_signal(
            None::<()>,
            path,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &(interface, changed, Vec::<String>::new()),
        )
        .await
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
pub enum BluezError {
    #[zbus(error)]
    ZBus(zbus::Error),
    DoesNotExist(String),
    AlreadyExists(String),
    AuthenticationRejected(String),
    AuthenticationCanceled(String),
    AuthenticationFailed(String),
    NotReady(String),
    Failed(String),
}

struct ObjectManager(FakeBluez);

#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl ObjectManager {
    fn get_managed_objects(&self) -> HashMap<OwnedObjectPath, Wire> {
        self.0.with(|s| {
            let mut objects = HashMap::new();
            objects.insert(
                OwnedObjectPath::try_from(HCI0).expect("path"),
                HashMap::from([("org.bluez.Adapter1".to_owned(), wire(&s.adapter))]),
            );
            for (path, props) in &s.devices {
                objects.insert(
                    OwnedObjectPath::try_from(path.as_str()).expect("path"),
                    HashMap::from([("org.bluez.Device1".to_owned(), wire(props))]),
                );
            }
            objects
        })
    }
}

struct AgentManager(FakeBluez);

#[zbus::interface(name = "org.bluez.AgentManager1")]
impl AgentManager {
    fn register_agent(
        &self,
        agent: OwnedObjectPath,
        capability: String,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> Result<(), BluezError> {
        let sender = header.sender().map(|s| s.to_string());
        self.0.record(&format!("RegisterAgent {capability}"));
        self.0.with(|s| {
            if s.agent.is_some() {
                return Err(BluezError::AlreadyExists("Already Exists".to_owned()));
            }
            s.agent = Some((sender, agent.as_str().to_owned()));
            Ok(())
        })
    }

    fn unregister_agent(&self, agent: OwnedObjectPath) -> Result<(), BluezError> {
        self.0.record("UnregisterAgent");
        self.0.with(|s| match &s.agent {
            Some((_, path)) if path == agent.as_str() => {
                s.agent = None;
                Ok(())
            }
            _ => Err(BluezError::DoesNotExist("Does Not Exist".to_owned())),
        })
    }
}

struct AdapterObject(FakeBluez);

#[zbus::interface(name = "org.bluez.Adapter1")]
impl AdapterObject {
    async fn start_discovery(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.0.record("StartDiscovery");
        self.0
            .set_adapter(connection, "Discovering", Prop::Bool(true))
            .await?;
        self.0
            .add_device(connection, DISCOVERED, "Discovered Phone")
            .await?;
        Ok(())
    }

    async fn stop_discovery(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.0.record("StopDiscovery");
        self.0
            .set_adapter(connection, "Discovering", Prop::Bool(false))
            .await?;
        Ok(())
    }

    async fn remove_device(
        &self,
        device: OwnedObjectPath,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.0.record("RemoveDevice");
        let path = device.as_str().to_owned();
        if self.0.with(|s| s.devices.remove(&path)).is_none() {
            return Err(BluezError::DoesNotExist("Does Not Exist".to_owned()));
        }
        let _ = connection
            .object_server()
            .remove::<DeviceObject, _>(path.as_str())
            .await;
        connection
            .emit_signal(
                None::<()>,
                "/",
                "org.freedesktop.DBus.ObjectManager",
                "InterfacesRemoved",
                &(device, vec!["org.bluez.Device1".to_owned()]),
            )
            .await?;
        Ok(())
    }
}

struct DeviceObject {
    fake: FakeBluez,
    path: String,
}

impl DeviceObject {
    fn new(fake: FakeBluez, path: &str) -> Self {
        Self {
            fake,
            path: path.to_owned(),
        }
    }

    fn get(&self, key: &str) -> Option<Prop> {
        self.fake
            .with(|s| s.devices.get(&self.path)?.get(key).cloned())
    }

    fn paired(&self) -> bool {
        self.get("Paired") == Some(Prop::Bool(true))
    }
}

#[zbus::interface(name = "org.bluez.Device1")]
impl DeviceObject {
    async fn pair(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.fake.record("Pair");
        if self.paired() {
            return Err(BluezError::AlreadyExists("Already Exists".to_owned()));
        }
        let Some((sender, agent)) = self.fake.with(|s| s.agent.clone()) else {
            return Err(BluezError::AuthenticationFailed("No agent".to_owned()));
        };
        let device = OwnedObjectPath::try_from(self.path.as_str()).expect("path");
        let destination = sender.clone();
        let body = (device, PASSKEY);
        let ask = connection.call_method(
            destination.as_deref(),
            agent.as_str(),
            Some("org.bluez.Agent1"),
            "RequestConfirmation",
            &body,
        );
        let answer = tokio::select! {
            answer = ask => answer,
            () = self.fake.cancel.notified() => {
                let _ = connection
                    .call_method(
                        sender.as_deref(),
                        agent.as_str(),
                        Some("org.bluez.Agent1"),
                        "Cancel",
                        &(),
                    )
                    .await;
                return Err(BluezError::AuthenticationCanceled(
                    "Authentication Canceled".to_owned(),
                ));
            }
        };
        if answer.is_err() {
            return Err(BluezError::AuthenticationRejected(
                "Authentication Rejected".to_owned(),
            ));
        }
        self.fake
            .set_device(connection, &self.path, "Paired", Prop::Bool(true))
            .await?;
        self.fake
            .set_device(connection, &self.path, "Bonded", Prop::Bool(true))
            .await?;
        Ok(())
    }

    fn cancel_pairing(&self) {
        self.fake.record("CancelPairing");
        self.fake.cancel.notify_waiters();
    }

    async fn connect(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.fake.record("Connect");
        if !self.paired() {
            return Err(BluezError::NotReady("Resource Not Ready".to_owned()));
        }
        self.fake
            .set_device(connection, &self.path, "Connected", Prop::Bool(true))
            .await?;
        Ok(())
    }

    async fn disconnect(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> Result<(), BluezError> {
        self.fake.record("Disconnect");
        self.fake
            .set_device(connection, &self.path, "Connected", Prop::Bool(false))
            .await?;
        Ok(())
    }

    #[zbus(property)]
    fn trusted(&self) -> bool {
        self.get("Trusted") == Some(Prop::Bool(true))
    }

    #[zbus(property)]
    async fn set_trusted(
        &mut self,
        trusted: bool,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::Result<()> {
        self.fake.record(&format!("Trusted={trusted}"));
        self.fake
            .set_device(connection, &self.path, "Trusted", Prop::Bool(trusted))
            .await
    }
}

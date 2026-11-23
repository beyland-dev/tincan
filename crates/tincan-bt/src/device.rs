//! Adapter and device operations over BlueZ: pairing (through an agent that
//! asks the caller to confirm the passkey), connect, disconnect, forget,
//! discovery, and adapter/device change events.
//!
//! Every function takes the system-bus connection, so tests can drive a fake
//! BlueZ over a peer-to-peer connection.

use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::Serialize;

use crate::bluez::{
    ADAPTER_INTERFACE, Adapter, BLUEZ_SERVICE, DEVICE_INTERFACE, Device, Interfaces,
    ManagedObjects, Snapshot, adapter_from, device_from, managed_objects_on, snapshot_on,
};
use crate::error::{Error, ErrorCode, Result};
use crate::map::validate_address;
use crate::system::{Signals, SystemSignal, bluez_rules, decode_signal};

pub const AGENT_MANAGER_PATH: &str = "/org/bluez";
/// Where the pairing agent is exported on Tincan's own connection.
pub const AGENT_PATH: &str = "/dev/beyland/tincan/agent";
/// Numeric comparison: the phone and Tincan show the same six digits and the
/// user confirms them.
pub const AGENT_CAPABILITY: &str = "DisplayYesNo";

#[zbus::proxy(
    interface = "org.bluez.AgentManager1",
    default_service = "org.bluez",
    default_path = "/org/bluez"
)]
trait AgentManager {
    fn register_agent(&self, agent: &zbus::ObjectPath<'_>, capability: &str) -> zbus::Result<()>;

    fn unregister_agent(&self, agent: &zbus::ObjectPath<'_>) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.bluez.Device1", default_service = "org.bluez")]
trait BluezDevice {
    fn pair(&self) -> zbus::Result<()>;

    fn cancel_pairing(&self) -> zbus::Result<()>;

    fn connect(&self) -> zbus::Result<()>;

    fn disconnect(&self) -> zbus::Result<()>;

    #[zbus(property)]
    fn set_trusted(&self, trusted: bool) -> zbus::Result<()>;
}

#[zbus::proxy(interface = "org.bluez.Adapter1", default_service = "org.bluez")]
trait BluezAdapter {
    fn remove_device(&self, device: &zbus::ObjectPath<'_>) -> zbus::Result<()>;

    fn start_discovery(&self) -> zbus::Result<()>;

    fn stop_discovery(&self) -> zbus::Result<()>;

    #[zbus(property)]
    fn set_discoverable(&self, discoverable: bool) -> zbus::Result<()>;
}

/// The adapter Tincan uses: the first powered one by object path, else the
/// first.
pub fn default_adapter(snapshot: &Snapshot) -> Option<&Adapter> {
    snapshot
        .adapters
        .iter()
        .find(|a| a.powered)
        .or_else(|| snapshot.adapters.first())
}

/// The device with `address` (any case). When several adapters know it, the
/// one on a powered adapter wins. `NOT_FOUND` when BlueZ doesn't know it.
pub fn find_device<'a>(snapshot: &'a Snapshot, address: &str) -> Result<&'a Device> {
    validate_address(address)?;
    let powered = |d: &&Device| {
        snapshot
            .adapters
            .iter()
            .any(|a| a.path == d.adapter && a.powered)
    };
    let mut matches = snapshot
        .devices
        .iter()
        .filter(|d| d.address.eq_ignore_ascii_case(address));
    let first = matches.next().ok_or_else(|| {
        Error::new(
            ErrorCode::NotFound,
            "BlueZ doesn't know this device; discover it first.",
        )
    })?;
    if powered(&first) {
        return Ok(first);
    }
    Ok(matches.find(powered).unwrap_or(first))
}

/// [`default_adapter`] read from BlueZ. `None` when there is no adapter.
pub async fn adapter(connection: &zbus::Connection) -> Result<Option<Adapter>> {
    Ok(default_adapter(&snapshot_on(connection).await?).cloned())
}

async fn device_proxy<'a>(
    connection: &'a zbus::Connection,
    address: &str,
) -> Result<(Device, BluezDeviceProxy<'a>)> {
    let device = find_device(&snapshot_on(connection).await?, address)?.clone();
    let proxy = BluezDeviceProxy::builder(connection)
        .path(device.path.clone())
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await?;
    Ok((device, proxy))
}

async fn adapter_proxy<'a>(
    connection: &'a zbus::Connection,
    path: &str,
) -> Result<BluezAdapterProxy<'a>> {
    Ok(BluezAdapterProxy::builder(connection)
        .path(path.to_owned())
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await?)
}

/// Connects the device's profiles (`Device1.Connect`). **Talks to the
/// device.**
pub async fn connect(connection: &zbus::Connection, address: &str) -> Result<()> {
    let (_, device) = device_proxy(connection, address).await?;
    Ok(device.connect().await?)
}

/// Drops every connection to the device (`Device1.Disconnect`).
pub async fn disconnect(connection: &zbus::Connection, address: &str) -> Result<()> {
    let (_, device) = device_proxy(connection, address).await?;
    Ok(device.disconnect().await?)
}

/// Removes the device and its bond from its adapter
/// (`Adapter1.RemoveDevice`). The phone must be paired again afterwards.
pub async fn forget(connection: &zbus::Connection, address: &str) -> Result<()> {
    let (device, _) = device_proxy(connection, address).await?;
    let adapter = adapter_proxy(connection, &device.adapter).await?;
    let path = zbus::ObjectPath::try_from(device.path.as_str())
        .map_err(|e| Error::new(ErrorCode::Internal, e.to_string()))?;
    Ok(adapter.remove_device(&path).await?)
}

/// Starts discovery on the default adapter, so an unpaired phone shows up
/// (as a `DeviceEvent::Added`). BlueZ stops it when this connection closes.
pub async fn start_discovery(connection: &zbus::Connection) -> Result<()> {
    let path = discovery_adapter(connection).await?;
    Ok(adapter_proxy(connection, &path)
        .await?
        .start_discovery()
        .await?)
}

/// Stops the discovery [`start_discovery`] started.
pub async fn stop_discovery(connection: &zbus::Connection) -> Result<()> {
    let path = discovery_adapter(connection).await?;
    Ok(adapter_proxy(connection, &path)
        .await?
        .stop_discovery()
        .await?)
}

/// Makes the default adapter visible to nearby devices (or hides it), so an
/// iPhone lists this computer under Settings › Bluetooth. BlueZ turns it off
/// again after `DiscoverableTimeout` (three minutes by default).
pub async fn set_discoverable(connection: &zbus::Connection, discoverable: bool) -> Result<()> {
    let path = discovery_adapter(connection).await?;
    Ok(adapter_proxy(connection, &path)
        .await?
        .set_discoverable(discoverable)
        .await?)
}

async fn discovery_adapter(connection: &zbus::Connection) -> Result<String> {
    match adapter(connection).await? {
        Some(adapter) if adapter.powered => Ok(adapter.path),
        Some(_) => Err(Error::new(
            ErrorCode::NotConnected,
            "The Bluetooth adapter is off.",
        )),
        None => Err(Error::new(ErrorCode::NotFound, "No Bluetooth adapter.")),
    }
}

/// What BlueZ asks the user during pairing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PairingRequest {
    /// Numeric comparison: accept when the phone shows the same `passkey`
    /// (six digits, zero-padded).
    Confirm { passkey: u32 },
    /// "Just Works" pairing: no passkey to compare.
    Authorize,
}

/// Answers a [`PairingRequest`]: `true` accepts.
pub type PairingResponder = Arc<dyn Fn(PairingRequest) -> BoxFuture<'static, bool> + Send + Sync>;

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
enum AgentError {
    #[zbus(error)]
    ZBus(zbus::Error),
    Rejected(String),
}

fn rejected(why: &str) -> AgentError {
    AgentError::Rejected(why.to_owned())
}

/// The `org.bluez.Agent1` object exported while one pairing runs. It only
/// answers for the device being paired.
struct PairingAgent {
    device: String,
    /// The unique bus name that owned `org.bluez` when the agent was
    /// registered; calls from any other sender are rejected. `None` on a
    /// peer-to-peer connection, where the peer is the only possible caller.
    bluez: Option<String>,
    respond: PairingResponder,
    /// Set when BlueZ cancels or the pairing ends: a question still waiting
    /// for the user is abandoned (and declined), so the responder is
    /// released even if it never answers.
    ended: Arc<tokio::sync::watch::Sender<bool>>,
}

/// Whether a call from `sender` may reach the agent: only BlueZ (by the
/// unique name that owned `org.bluez` at registration) may call it. The bus
/// policy in BlueZ's `bluetooth.conf` usually ensures this too, but not every
/// distribution ships it, and any session process could otherwise answer a
/// pairing question.
fn sender_allowed(expected: Option<&str>, sender: Option<&str>) -> bool {
    match expected {
        Some(expected) => sender == Some(expected),
        None => true,
    }
}

/// The unique name owning `org.bluez`, or `None` on a peer-to-peer
/// connection (which has no bus to ask).
async fn bluez_owner(connection: &zbus::Connection) -> Result<Option<String>> {
    if connection.unique_name().is_none() {
        return Ok(None);
    }
    let bus = zbus::fdo::DBusProxy::new(connection).await?;
    let name = zbus::names::BusName::from_static_str(BLUEZ_SERVICE)?;
    Ok(Some(bus.get_name_owner(name).await?.to_string()))
}

impl PairingAgent {
    fn caller(&self, header: &zbus::message::Header<'_>) -> Result<(), AgentError> {
        let sender = header.sender().map(|s| s.as_str());
        if sender_allowed(self.bluez.as_deref(), sender) {
            Ok(())
        } else {
            tracing::warn!("rejected a pairing agent call from a sender other than BlueZ");
            Err(rejected("Only BlueZ may call this agent."))
        }
    }

    fn check(&self, device: &zbus::ObjectPath<'_>) -> Result<(), AgentError> {
        if device.as_str() == self.device {
            Ok(())
        } else {
            Err(rejected("Not the device being paired."))
        }
    }

    async fn ask(&self, request: PairingRequest) -> Result<(), AgentError> {
        let mut ended = self.ended.subscribe();
        let accepted = tokio::select! {
            accepted = (self.respond)(request) => accepted,
            _ = ended.wait_for(|ended| *ended) => false,
        };
        if accepted {
            Ok(())
        } else {
            Err(rejected("The user declined."))
        }
    }
}

#[zbus::interface(name = "org.bluez.Agent1")]
impl PairingAgent {
    fn release(&self, #[zbus(header)] header: zbus::message::Header<'_>) -> Result<(), AgentError> {
        self.caller(&header)
    }

    fn request_pin_code(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        _device: zbus::ObjectPath<'_>,
    ) -> Result<String, AgentError> {
        self.caller(&header)?;
        Err(rejected("Legacy PIN pairing is not supported."))
    }

    fn display_pin_code(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        _device: zbus::ObjectPath<'_>,
        _pincode: String,
    ) -> Result<(), AgentError> {
        self.caller(&header)?;
        Err(rejected("Legacy PIN pairing is not supported."))
    }

    fn request_passkey(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        _device: zbus::ObjectPath<'_>,
    ) -> Result<u32, AgentError> {
        self.caller(&header)?;
        Err(rejected("Passkey entry is not supported."))
    }

    fn display_passkey(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        _device: zbus::ObjectPath<'_>,
        _passkey: u32,
        _entered: u16,
    ) -> Result<(), AgentError> {
        self.caller(&header)
    }

    async fn request_confirmation(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        device: zbus::ObjectPath<'_>,
        passkey: u32,
    ) -> Result<(), AgentError> {
        self.caller(&header)?;
        self.check(&device)?;
        self.ask(PairingRequest::Confirm { passkey }).await
    }

    async fn request_authorization(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        device: zbus::ObjectPath<'_>,
    ) -> Result<(), AgentError> {
        self.caller(&header)?;
        self.check(&device)?;
        self.ask(PairingRequest::Authorize).await
    }

    /// The phone connecting a profile mid-pairing; it is trusted right after.
    fn authorize_service(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
        device: zbus::ObjectPath<'_>,
        _uuid: String,
    ) -> Result<(), AgentError> {
        self.caller(&header)?;
        self.check(&device)
    }

    fn cancel(&self, #[zbus(header)] header: zbus::message::Header<'_>) -> Result<(), AgentError> {
        self.caller(&header)?;
        self.ended.send_replace(true);
        Ok(())
    }
}

/// Pairs with the device at `address` and trusts it, so it can reconnect
/// on its own. **Talks to the device.** Registers a `DisplayYesNo` agent
/// for the call; `respond` answers BlueZ's passkey confirmation. Already
/// paired: only trusts it. Rejects `NOT_FOUND` for an unknown device, `BUSY`
/// while another pairing on this connection runs, and `PERMISSION_DENIED`
/// when either side declines.
pub async fn pair(
    connection: &zbus::Connection,
    address: &str,
    respond: PairingResponder,
) -> Result<()> {
    let (device, proxy) = device_proxy(connection, address).await?;
    if !device.paired {
        let ended = Arc::new(tokio::sync::watch::Sender::new(false));
        let agent = PairingAgent {
            device: device.path.clone(),
            bluez: bluez_owner(connection).await?,
            respond,
            ended: Arc::clone(&ended),
        };
        let server = connection.object_server();
        if server.at(AGENT_PATH, agent).await?.is_some() {
            return Err(Error::new(
                ErrorCode::Busy,
                "Another pairing is in progress.",
            ));
        }
        let result = pair_with_agent(connection, &proxy).await;
        ended.send_replace(true);
        let _ = server.remove::<PairingAgent, _>(AGENT_PATH).await;
        result?;
    }
    if !device.trusted {
        proxy.set_trusted(true).await?;
    }
    Ok(())
}

async fn pair_with_agent(
    connection: &zbus::Connection,
    device: &BluezDeviceProxy<'_>,
) -> Result<()> {
    let manager = AgentManagerProxy::new(connection).await?;
    let path = zbus::ObjectPath::from_static_str_unchecked(AGENT_PATH);
    manager.register_agent(&path, AGENT_CAPABILITY).await?;
    let result = device.pair().await;
    let _ = manager.unregister_agent(&path).await;
    Ok(result?)
}

/// Asks BlueZ to abandon a pairing in progress; the pending [`pair`] then
/// rejects.
pub async fn cancel_pairing(connection: &zbus::Connection, address: &str) -> Result<()> {
    let (_, device) = device_proxy(connection, address).await?;
    Ok(device.cancel_pairing().await?)
}

/// A change to an adapter or device BlueZ knows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceEvent {
    DeviceAdded(Device),
    DeviceChanged(Device),
    DeviceRemoved {
        path: String,
        address: String,
    },
    /// An adapter appeared or one of its properties changed.
    AdapterChanged(Adapter),
    AdapterRemoved {
        path: String,
    },
}

/// Turns BlueZ signals into [`DeviceEvent`]s. Only changes that alter the
/// parsed [`Device`] or [`Adapter`] produce one (RSSI updates don't).
#[derive(Debug, Default)]
pub struct DeviceTracker {
    objects: ManagedObjects,
}

impl DeviceTracker {
    pub fn new(objects: &ManagedObjects) -> Self {
        let objects = objects
            .iter()
            .filter_map(|(path, interfaces)| {
                let kept: Interfaces = interfaces
                    .iter()
                    .filter(|(name, _)| is_tracked(name))
                    .map(|(name, props)| (name.clone(), props.clone()))
                    .collect();
                (!kept.is_empty()).then(|| (path.clone(), kept))
            })
            .collect();
        Self { objects }
    }

    pub fn apply(&mut self, signal: &SystemSignal) -> Vec<DeviceEvent> {
        match signal {
            SystemSignal::Added(path, interfaces) => {
                let mut events = Vec::new();
                for (name, props) in interfaces.iter().filter(|(name, _)| is_tracked(name)) {
                    let entry = self.objects.entry(path.clone()).or_default();
                    let known = entry.contains_key(name);
                    entry.insert(name.clone(), props.clone());
                    events.push(match (name.as_str(), known) {
                        (DEVICE_INTERFACE, false) => {
                            DeviceEvent::DeviceAdded(device_from(path, props))
                        }
                        (DEVICE_INTERFACE, true) => {
                            DeviceEvent::DeviceChanged(device_from(path, props))
                        }
                        _ => DeviceEvent::AdapterChanged(adapter_from(path, props)),
                    });
                }
                events
            }
            SystemSignal::Removed(path, interfaces) => {
                let mut events = Vec::new();
                for name in interfaces.iter().filter(|name| is_tracked(name)) {
                    let Some(entry) = self.objects.get_mut(path) else {
                        break;
                    };
                    let Some(props) = entry.remove(name) else {
                        continue;
                    };
                    events.push(if name == DEVICE_INTERFACE {
                        DeviceEvent::DeviceRemoved {
                            path: path.clone(),
                            address: device_from(path, &props).address,
                        }
                    } else {
                        DeviceEvent::AdapterRemoved { path: path.clone() }
                    });
                }
                if self.objects.get(path).is_some_and(BTreeMap::is_empty) {
                    self.objects.remove(path);
                }
                events
            }
            SystemSignal::Changed(path, interface, changed) => {
                let Some(props) = self
                    .objects
                    .get_mut(path)
                    .and_then(|entry| entry.get_mut(interface))
                else {
                    return Vec::new();
                };
                let mut updated = props.clone();
                updated.extend(changed.iter().map(|(k, v)| (k.clone(), v.clone())));
                let event = if interface == DEVICE_INTERFACE {
                    let (before, after) = (device_from(path, props), device_from(path, &updated));
                    (before != after).then_some(DeviceEvent::DeviceChanged(after))
                } else {
                    let (before, after) = (adapter_from(path, props), adapter_from(path, &updated));
                    (before != after).then_some(DeviceEvent::AdapterChanged(after))
                };
                *props = updated;
                event.into_iter().collect()
            }
            SystemSignal::PrepareForSleep(_) => Vec::new(),
        }
    }
}

fn is_tracked(interface: &str) -> bool {
    interface == DEVICE_INTERFACE || interface == ADAPTER_INTERFACE
}

/// A subscription to adapter and device changes. It is live once
/// [`DeviceEvents::subscribe`] returns: it subscribes before reading the
/// current objects, so nothing in between is missed. The current state
/// itself is not sent (read it with [`crate::bluez::snapshot_on`]).
pub struct DeviceEvents {
    signals: Signals,
    tracker: DeviceTracker,
    pending: std::collections::VecDeque<DeviceEvent>,
}

impl DeviceEvents {
    pub async fn subscribe(connection: &zbus::Connection) -> Result<Self> {
        let signals = Signals::subscribe(connection, bluez_rules()?).await?;
        let tracker = DeviceTracker::new(&managed_objects_on(connection).await?);
        Ok(Self {
            signals,
            tracker,
            pending: Default::default(),
        })
    }

    /// The next change; `None` once the connection closes.
    pub async fn next(&mut self) -> Option<DeviceEvent> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Some(event);
            }
            let message = self.signals.next().await?;
            if let Some(signal) = decode_signal(&message) {
                self.pending.extend(self.tracker.apply(&signal));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bluez::snapshot_from_objects;
    use crate::props::{PropValue, Props};

    #[test]
    fn only_bluez_may_call_the_agent() {
        assert!(sender_allowed(Some(":1.7"), Some(":1.7")));
        assert!(!sender_allowed(Some(":1.7"), Some(":1.8")));
        assert!(!sender_allowed(Some(":1.7"), None));
        // Peer-to-peer: the peer is the only possible caller.
        assert!(sender_allowed(None, None));
    }

    const HCI0: &str = "/org/bluez/hci0";
    const DEV: &str = "/org/bluez/hci0/dev_02_00_00_00_00_08";
    const PHONE: &str = "02:00:00:00:00:08";

    fn adapter_props(powered: bool) -> Props {
        Props::from([
            (
                "Address".to_owned(),
                PropValue::Str("AA:BB:CC:DD:EE:FF".to_owned()),
            ),
            ("Powered".to_owned(), PropValue::Bool(powered)),
        ])
    }

    fn device_props(paired: bool) -> Props {
        Props::from([
            ("Address".to_owned(), PropValue::Str(PHONE.to_owned())),
            ("Alias".to_owned(), PropValue::Str("Phone".to_owned())),
            ("Paired".to_owned(), PropValue::Bool(paired)),
        ])
    }

    fn objects() -> ManagedObjects {
        ManagedObjects::from([
            (
                HCI0.to_owned(),
                Interfaces::from([(ADAPTER_INTERFACE.to_owned(), adapter_props(true))]),
            ),
            (
                DEV.to_owned(),
                Interfaces::from([(DEVICE_INTERFACE.to_owned(), device_props(false))]),
            ),
        ])
    }

    #[test]
    fn finds_devices_by_address_preferring_a_powered_adapter() {
        let mut snapshot = snapshot_from_objects(&objects());
        assert_eq!(
            find_device(&snapshot, &PHONE.to_lowercase())
                .ok()
                .map(|d| d.path.as_str()),
            Some(DEV)
        );
        assert_eq!(
            find_device(&snapshot, "00:11:22:33:44:55")
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::NotFound)
        );
        assert_eq!(
            find_device(&snapshot, "nope").err().map(|e| e.code()),
            Some(ErrorCode::InvalidInput)
        );

        // hci0 off, hci1 on: the hci1 copy wins.
        snapshot.adapters[0].powered = false;
        let mut other = snapshot.devices[0].clone();
        other.adapter = "/org/bluez/hci1".to_owned();
        other.path = "/org/bluez/hci1/dev_02_00_00_00_00_08".to_owned();
        snapshot.devices.push(other);
        snapshot.adapters.push(Adapter {
            path: "/org/bluez/hci1".to_owned(),
            powered: true,
            ..Adapter::default()
        });
        assert_eq!(
            find_device(&snapshot, PHONE)
                .ok()
                .map(|d| d.adapter.as_str()),
            Some("/org/bluez/hci1")
        );
        assert_eq!(
            default_adapter(&snapshot).map(|a| a.path.as_str()),
            Some("/org/bluez/hci1")
        );
    }

    #[test]
    fn default_adapter_falls_back_to_the_first() {
        let mut snapshot = snapshot_from_objects(&objects());
        snapshot.adapters[0].powered = false;
        assert_eq!(
            default_adapter(&snapshot).map(|a| a.path.as_str()),
            Some(HCI0)
        );
        assert_eq!(default_adapter(&Snapshot::default()), None);
    }

    #[test]
    fn tracks_device_lifecycle() {
        let mut tracker = DeviceTracker::new(&ManagedObjects::new());
        let added = SystemSignal::Added(
            DEV.to_owned(),
            Interfaces::from([
                (DEVICE_INTERFACE.to_owned(), device_props(false)),
                ("org.bluez.MediaControl1".to_owned(), Props::new()),
            ]),
        );
        let events = tracker.apply(&added);
        assert!(matches!(&events[..], [DeviceEvent::DeviceAdded(d)] if !d.paired));

        let paired = SystemSignal::Changed(
            DEV.to_owned(),
            DEVICE_INTERFACE.to_owned(),
            Props::from([("Paired".to_owned(), PropValue::Bool(true))]),
        );
        let events = tracker.apply(&paired);
        assert!(matches!(&events[..], [DeviceEvent::DeviceChanged(d)] if d.paired));
        // The same value again, or a property Device doesn't carry: nothing.
        assert_eq!(tracker.apply(&paired), Vec::new());
        let rssi = SystemSignal::Changed(
            DEV.to_owned(),
            DEVICE_INTERFACE.to_owned(),
            Props::from([("RSSI".to_owned(), PropValue::Int(-60))]),
        );
        assert_eq!(tracker.apply(&rssi), Vec::new());

        let removed = SystemSignal::Removed(
            DEV.to_owned(),
            vec![
                DEVICE_INTERFACE.to_owned(),
                "org.bluez.MediaControl1".to_owned(),
            ],
        );
        assert_eq!(
            tracker.apply(&removed),
            vec![DeviceEvent::DeviceRemoved {
                path: DEV.to_owned(),
                address: PHONE.to_owned()
            }]
        );
        assert_eq!(tracker.apply(&removed), Vec::new());
        // A change to an object it never saw: ignored.
        assert_eq!(tracker.apply(&paired), Vec::new());
    }

    #[test]
    fn tracks_adapters() {
        let mut tracker = DeviceTracker::new(&objects());
        let off = SystemSignal::Changed(
            HCI0.to_owned(),
            ADAPTER_INTERFACE.to_owned(),
            Props::from([("Powered".to_owned(), PropValue::Bool(false))]),
        );
        assert!(matches!(
            &tracker.apply(&off)[..],
            [DeviceEvent::AdapterChanged(a)] if !a.powered
        ));
        assert_eq!(
            tracker.apply(&SystemSignal::PrepareForSleep(true)),
            Vec::new()
        );
        let removed = SystemSignal::Removed(HCI0.to_owned(), vec![ADAPTER_INTERFACE.to_owned()]);
        assert_eq!(
            tracker.apply(&removed),
            vec![DeviceEvent::AdapterRemoved {
                path: HCI0.to_owned()
            }]
        );
        let again = SystemSignal::Added(
            HCI0.to_owned(),
            Interfaces::from([(ADAPTER_INTERFACE.to_owned(), adapter_props(true))]),
        );
        assert!(matches!(
            &tracker.apply(&again)[..],
            [DeviceEvent::AdapterChanged(a)] if a.powered
        ));
    }

    #[test]
    fn events_serialize_with_a_kind() {
        let event = DeviceEvent::DeviceRemoved {
            path: DEV.to_owned(),
            address: PHONE.to_owned(),
        };
        let json = serde_json::to_value(&event).expect("json");
        assert_eq!(json["kind"], "deviceRemoved");
        let request = serde_json::to_value(PairingRequest::Confirm { passkey: 42 }).expect("json");
        assert_eq!(
            request,
            serde_json::json!({ "kind": "confirm", "passkey": 42 })
        );
    }
}

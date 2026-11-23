//! Read-only BlueZ discovery over the **system** bus.
//!
//! One `org.freedesktop.DBus.ObjectManager.GetManagedObjects` call on
//! `org.bluez` returns every adapter and device with its properties. The call
//! is the only bus access here; the parsing ([`snapshot_from_objects`]) works
//! on plain data so it can be tested with synthetic objects and no bus.
//!
//! Nothing in this module changes Bluetooth state: no pairing, connecting,
//! discovery or property writes.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::{Error, ErrorCode, Result, bus_unavailable};
pub use crate::props::PropValue;
use crate::props::{Props, get_bool, get_list, get_str, get_u32, prop_from_variant};

pub const BLUEZ_SERVICE: &str = "org.bluez";
pub const ADAPTER_INTERFACE: &str = "org.bluez.Adapter1";
pub const DEVICE_INTERFACE: &str = "org.bluez.Device1";

/// MAP Message Server Equipment: the phone serves its messages.
pub const MAP_MSE_UUID: &str = "00001132-0000-1000-8000-00805f9b34fb";
/// MAP Message Notification Server (the role Tincan plays for MNS events).
pub const MAP_MNS_UUID: &str = "00001133-0000-1000-8000-00805f9b34fb";
/// PBAP Phonebook Server Equipment: the phone serves its contacts.
pub const PBAP_PSE_UUID: &str = "0000112f-0000-1000-8000-00805f9b34fb";
/// Apple Notification Center Service (GATT, over LE).
pub const ANCS_UUID: &str = "7905f431-b5ce-4e99-a40f-4b1e122d00d0";

/// Interface name → property name → value.
pub type Interfaces = BTreeMap<String, Props>;
/// Object path → interfaces, as returned by `GetManagedObjects`.
pub type ManagedObjects = BTreeMap<String, Interfaces>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub path: String,
    pub address: String,
    pub name: String,
    pub alias: String,
    pub powered: bool,
    pub discoverable: bool,
    pub pairable: bool,
    pub discovering: bool,
    /// The Class of Device, when BlueZ reports one.
    pub class: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub path: String,
    /// The adapter object path the device belongs to.
    pub adapter: String,
    pub address: String,
    pub name: Option<String>,
    pub alias: String,
    pub icon: Option<String>,
    pub class: Option<u32>,
    pub modalias: Option<String>,
    pub paired: bool,
    pub bonded: bool,
    pub trusted: bool,
    pub blocked: bool,
    pub connected: bool,
    /// Lowercased service UUIDs.
    pub uuids: Vec<String>,
    pub is_iphone: bool,
    pub supports_map: bool,
    pub supports_pbap: bool,
    pub supports_ancs: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub adapters: Vec<Adapter>,
    pub devices: Vec<Device>,
}

fn has_uuid(uuids: &[String], uuid: &str) -> bool {
    uuids.iter().any(|u| u.eq_ignore_ascii_case(uuid))
}

/// The phone serves messages over MAP (it advertises the MAP MSE record).
pub fn supports_map(uuids: &[String]) -> bool {
    has_uuid(uuids, MAP_MSE_UUID)
}

/// The phone serves contacts over PBAP (it advertises the PBAP PSE record).
pub fn supports_pbap(uuids: &[String]) -> bool {
    has_uuid(uuids, PBAP_PSE_UUID)
}

pub fn supports_ancs(uuids: &[String]) -> bool {
    has_uuid(uuids, ANCS_UUID)
}

/// Apple's Bluetooth SIG company id (`bluetooth:v004C…`) or USB vendor id
/// (`usb:v05AC…`) in a BlueZ Modalias.
fn is_apple_modalias(modalias: &str) -> bool {
    let m = modalias.to_ascii_lowercase();
    m.starts_with("bluetooth:v004c") || m.starts_with("usb:v05ac")
}

/// Class of Device major class 0x02 (Phone).
fn is_phone_class(class: u32) -> bool {
    (class >> 8) & 0x1f == 0x02
}

/// Whether a device looks like an iPhone: its name says so, or it is an Apple
/// device (by Modalias) that presents itself as a phone.
pub fn is_iphone(device: &Device) -> bool {
    let named = |s: &str| s.to_ascii_lowercase().contains("iphone");
    if device.name.as_deref().is_some_and(named) || named(&device.alias) {
        return true;
    }
    let apple = device.modalias.as_deref().is_some_and(is_apple_modalias);
    let phone = device.icon.as_deref() == Some("phone") || device.class.is_some_and(is_phone_class);
    apple && phone
}

pub fn adapter_from(path: &str, props: &Props) -> Adapter {
    Adapter {
        path: path.to_string(),
        address: get_str(props, "Address").unwrap_or_default(),
        name: get_str(props, "Name").unwrap_or_default(),
        alias: get_str(props, "Alias").unwrap_or_default(),
        powered: get_bool(props, "Powered"),
        discoverable: get_bool(props, "Discoverable"),
        pairable: get_bool(props, "Pairable"),
        discovering: get_bool(props, "Discovering"),
        class: get_u32(props, "Class"),
    }
}

pub fn device_from(path: &str, props: &Props) -> Device {
    let uuids: Vec<String> = get_list(props, "UUIDs")
        .into_iter()
        .map(|u| u.to_ascii_lowercase())
        .collect();
    let adapter = match get_str(props, "Adapter") {
        Some(adapter) => adapter,
        None => path
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default(),
    };
    let mut device = Device {
        path: path.to_string(),
        adapter,
        address: get_str(props, "Address").unwrap_or_default(),
        name: get_str(props, "Name"),
        alias: get_str(props, "Alias").unwrap_or_default(),
        icon: get_str(props, "Icon"),
        class: get_u32(props, "Class"),
        modalias: get_str(props, "Modalias"),
        paired: get_bool(props, "Paired"),
        bonded: get_bool(props, "Bonded"),
        trusted: get_bool(props, "Trusted"),
        blocked: get_bool(props, "Blocked"),
        connected: get_bool(props, "Connected"),
        supports_map: supports_map(&uuids),
        supports_pbap: supports_pbap(&uuids),
        supports_ancs: supports_ancs(&uuids),
        uuids,
        is_iphone: false,
    };
    device.is_iphone = is_iphone(&device);
    device
}

/// Builds the adapter and device lists from `GetManagedObjects` data, sorted
/// by object path.
pub fn snapshot_from_objects(objects: &ManagedObjects) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for (path, interfaces) in objects {
        if let Some(props) = interfaces.get(ADAPTER_INTERFACE) {
            snapshot.adapters.push(adapter_from(path, props));
        }
        if let Some(props) = interfaces.get(DEVICE_INTERFACE) {
            snapshot.devices.push(device_from(path, props));
        }
    }
    snapshot
}

/// Converts zbus's `GetManagedObjects` reply into [`ManagedObjects`].
pub fn objects_from_zbus(objects: &zbus::fdo::ManagedObjects) -> ManagedObjects {
    objects
        .iter()
        .map(|(path, interfaces)| {
            let interfaces = interfaces
                .iter()
                .map(|(name, props)| {
                    let props = props
                        .iter()
                        .map(|(key, value)| (key.clone(), prop_from_variant(value)))
                        .collect();
                    (name.as_str().to_string(), props)
                })
                .collect();
            (path.as_str().to_string(), interfaces)
        })
        .collect()
}

/// Refuses a profile session (MAP, PBAP, ANCS) with a device BlueZ hasn't
/// paired and bonded with, so a device that merely claims the phone's
/// address can't serve Tincan data without the stored keys being involved.
/// `Bonded` is required where BlueZ reports it (5.68 and later); older BlueZ
/// only has `Paired`. Neither proves the link is encrypted: BlueZ's D-Bus API
/// exposes no link security level, and obexd connects at its own level.
pub fn check_bonded(objects: &ManagedObjects, address: &str) -> Result<()> {
    let snapshot = snapshot_from_objects(objects);
    let device = crate::device::find_device(&snapshot, address)?;
    let reports_bonded = objects
        .get(&device.path)
        .and_then(|interfaces| interfaces.get(DEVICE_INTERFACE))
        .is_some_and(|props| props.contains_key("Bonded"));
    if device.paired && (device.bonded || !reports_bonded) {
        return Ok(());
    }
    Err(Error::new(
        ErrorCode::PermissionDenied,
        "The phone isn't paired and bonded with this computer; pair it again before syncing.",
    ))
}

/// [`check_bonded`] against BlueZ over `connection` (the system bus).
pub async fn require_bonded(connection: &zbus::Connection, address: &str) -> Result<()> {
    check_bonded(&managed_objects_on(connection).await?, address)
}

/// Connects to the system bus (BlueZ, logind). `NOT_CONNECTED` when it is
/// unavailable.
pub async fn system_bus() -> Result<zbus::Connection> {
    zbus::Connection::system()
        .await
        .map_err(|e| bus_unavailable("system", &e))
}

/// Reads every BlueZ object from the system bus (one read-only call).
pub async fn managed_objects() -> Result<ManagedObjects> {
    managed_objects_on(&system_bus().await?).await
}

/// [`managed_objects`] over an existing system bus connection.
pub async fn managed_objects_on(connection: &zbus::Connection) -> Result<ManagedObjects> {
    let proxy = zbus::fdo::ObjectManagerProxy::builder(connection)
        .destination(BLUEZ_SERVICE)
        .path("/")
        .build()
        .await?;
    let objects = proxy.get_managed_objects().await?;
    Ok(objects_from_zbus(&objects))
}

/// The adapters and devices BlueZ knows, with iPhone/MAP/PBAP flags.
pub async fn snapshot() -> Result<Snapshot> {
    Ok(snapshot_from_objects(&managed_objects().await?))
}

/// [`snapshot`] over an existing system bus connection.
pub async fn snapshot_on(connection: &zbus::Connection) -> Result<Snapshot> {
    Ok(snapshot_from_objects(
        &managed_objects_on(connection).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(entries: &[(&str, PropValue)]) -> Props {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn s(v: &str) -> PropValue {
        PropValue::Str(v.to_string())
    }

    fn list(v: &[&str]) -> PropValue {
        PropValue::StrList(v.iter().map(|s| s.to_string()).collect())
    }

    fn synthetic() -> ManagedObjects {
        let mut objects = ManagedObjects::new();
        objects.insert("/".into(), Interfaces::new());
        objects.insert(
            "/org/bluez/hci0".into(),
            Interfaces::from([(
                ADAPTER_INTERFACE.to_string(),
                props(&[
                    ("Address", s("00:11:22:33:44:55")),
                    ("Name", s("tincan-test")),
                    ("Alias", s("tincan-test")),
                    ("Powered", PropValue::Bool(true)),
                    ("Discoverable", PropValue::Bool(false)),
                    ("Pairable", PropValue::Bool(true)),
                    ("Class", PropValue::Int(0x6c010c)),
                ]),
            )]),
        );
        objects.insert(
            "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01".into(),
            Interfaces::from([(
                DEVICE_INTERFACE.to_string(),
                props(&[
                    ("Address", s("AA:BB:CC:DD:EE:01")),
                    ("Name", s("Test iPhone")),
                    ("Alias", s("Test iPhone")),
                    ("Adapter", s("/org/bluez/hci0")),
                    ("Icon", s("phone")),
                    ("Class", PropValue::Int(0x7a020c)),
                    ("Paired", PropValue::Bool(true)),
                    ("Trusted", PropValue::Bool(true)),
                    ("Connected", PropValue::Bool(true)),
                    (
                        "UUIDs",
                        list(&[
                            "00001132-0000-1000-8000-00805F9B34FB",
                            PBAP_PSE_UUID,
                            "0000110a-0000-1000-8000-00805f9b34fb",
                        ]),
                    ),
                    ("ManufacturerData", PropValue::Other),
                ]),
            )]),
        );
        objects.insert(
            "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_02".into(),
            Interfaces::from([(
                DEVICE_INTERFACE.to_string(),
                props(&[
                    ("Address", s("AA:BB:CC:DD:EE:02")),
                    ("Alias", s("Headphones")),
                    ("Icon", s("audio-headset")),
                    ("Paired", PropValue::Bool(true)),
                    ("UUIDs", list(&["0000110b-0000-1000-8000-00805f9b34fb"])),
                ]),
            )]),
        );
        objects
    }

    #[test]
    fn parses_adapters_and_devices() {
        let snapshot = snapshot_from_objects(&synthetic());
        assert_eq!(snapshot.adapters.len(), 1);
        let adapter = &snapshot.adapters[0];
        assert_eq!(adapter.path, "/org/bluez/hci0");
        assert_eq!(adapter.address, "00:11:22:33:44:55");
        assert!(adapter.powered);
        assert!(!adapter.discoverable);
        assert_eq!(adapter.class, Some(0x6c010c));

        assert_eq!(snapshot.devices.len(), 2);
        let phone = &snapshot.devices[0];
        assert_eq!(phone.address, "AA:BB:CC:DD:EE:01");
        assert_eq!(phone.adapter, "/org/bluez/hci0");
        assert!(phone.paired && phone.trusted && phone.connected);
        assert!(phone.is_iphone);
        assert!(phone.supports_map);
        assert!(phone.supports_pbap);
        assert!(!phone.supports_ancs);
        assert!(phone.uuids.contains(&MAP_MSE_UUID.to_string()));

        let headset = &snapshot.devices[1];
        assert_eq!(headset.name, None);
        assert_eq!(headset.adapter, "/org/bluez/hci0");
        assert!(!headset.is_iphone);
        assert!(!headset.supports_map && !headset.supports_pbap);
        assert!(!headset.connected);
    }

    #[test]
    fn recognises_an_apple_phone_without_iphone_in_its_name() {
        let device = Device {
            alias: "Sam's phone".into(),
            icon: Some("phone".into()),
            modalias: Some("bluetooth:v004Cp7A05d1234".into()),
            ..Device::default()
        };
        assert!(is_iphone(&device));

        let android = Device {
            alias: "Pixel".into(),
            icon: Some("phone".into()),
            modalias: Some("bluetooth:v00E0p1200d1436".into()),
            ..Device::default()
        };
        assert!(!is_iphone(&android));

        let mac = Device {
            alias: "MacBook".into(),
            icon: Some("computer".into()),
            class: Some(0x3a010c),
            modalias: Some("bluetooth:v004Cp0001d0001".into()),
            ..Device::default()
        };
        assert!(!is_iphone(&mac));
    }

    #[test]
    fn uuid_helpers_ignore_case() {
        let uuids = vec![MAP_MSE_UUID.to_uppercase(), ANCS_UUID.to_uppercase()];
        assert!(supports_map(&uuids));
        assert!(supports_ancs(&uuids));
        assert!(!supports_pbap(&uuids));
    }

    #[test]
    fn requires_a_paired_and_bonded_device() {
        let mut objects = synthetic();
        let device = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01";
        let address = "AA:BB:CC:DD:EE:01";
        let set = |objects: &mut ManagedObjects, key: &str, value: Option<bool>| {
            let props = objects
                .get_mut(device)
                .and_then(|i| i.get_mut(DEVICE_INTERFACE))
                .expect("device");
            match value {
                Some(v) => props.insert(key.to_string(), PropValue::Bool(v)),
                None => props.remove(key),
            };
        };
        set(&mut objects, "Paired", Some(true));
        set(&mut objects, "Bonded", Some(true));
        assert!(check_bonded(&objects, address).is_ok());
        assert!(check_bonded(&objects, &address.to_lowercase()).is_ok());

        // Paired without stored keys is not enough.
        set(&mut objects, "Bonded", Some(false));
        let err = check_bonded(&objects, address).expect_err("not bonded");
        assert_eq!(err.code(), ErrorCode::PermissionDenied);

        // Older BlueZ has no Bonded property: Paired decides.
        set(&mut objects, "Bonded", None);
        assert!(check_bonded(&objects, address).is_ok());
        set(&mut objects, "Paired", Some(false));
        assert_eq!(
            check_bonded(&objects, address)
                .expect_err("unpaired")
                .code(),
            ErrorCode::PermissionDenied
        );

        assert_eq!(
            check_bonded(&objects, "AA:BB:CC:DD:EE:99")
                .expect_err("unknown")
                .code(),
            ErrorCode::NotFound
        );
    }
}

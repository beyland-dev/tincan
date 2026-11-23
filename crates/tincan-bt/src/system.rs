//! Turns system bus signals into supervisor [`Trigger`]s: logind
//! `PrepareForSleep`, BlueZ adapters appearing, disappearing or changing
//! power, and the phone's link going up or down. Read-only: it never calls a
//! method that changes anything.

use std::collections::{BTreeMap, HashMap, VecDeque};

use futures_util::{FutureExt, StreamExt};

use crate::bluez::{ADAPTER_INTERFACE, DEVICE_INTERFACE, ManagedObjects, managed_objects_on};
use crate::error::Result;
use crate::map::validate_address;
use crate::props::PropValue;
use crate::props::{Props, get, props_from_zbus};
use crate::supervisor::{Trigger, TriggerSender};

pub const LOGIND_PATH: &str = "/org/freedesktop/login1";
pub const LOGIND_MANAGER: &str = "org.freedesktop.login1.Manager";

/// A system bus signal the watcher cares about, decoded.
#[derive(Debug, Clone, PartialEq)]
pub enum SystemSignal {
    PrepareForSleep(bool),
    /// An object gained interfaces (path, interface → properties).
    Added(String, BTreeMap<String, Props>),
    /// An object lost interfaces.
    Removed(String, Vec<String>),
    /// `PropertiesChanged` (path, interface, changed).
    Changed(String, String, Props),
}

/// What the watcher knows: which adapters are powered, and the phone's
/// object path suffix.
#[derive(Debug, Clone)]
pub struct SystemState {
    device_suffix: String,
    adapters: BTreeMap<String, bool>,
}

impl SystemState {
    pub fn new(address: &str) -> Self {
        Self {
            device_suffix: format!("/dev_{}", address.to_ascii_uppercase().replace(':', "_")),
            adapters: BTreeMap::new(),
        }
    }

    /// Loads the adapters from `GetManagedObjects`. Returns
    /// [`Trigger::AdapterDown`] when none is powered.
    pub fn load(&mut self, objects: &ManagedObjects) -> Option<Trigger> {
        self.adapters = objects
            .iter()
            .filter_map(|(path, interfaces)| {
                let props = interfaces.get(ADAPTER_INTERFACE)?;
                Some((path.clone(), powered(props).unwrap_or(false)))
            })
            .collect();
        (!self.any_powered()).then_some(Trigger::AdapterDown)
    }

    fn any_powered(&self) -> bool {
        self.adapters.values().any(|powered| *powered)
    }

    fn set_adapter(&mut self, path: &str, powered: Option<bool>) -> Option<Trigger> {
        let before = self.any_powered();
        match powered {
            Some(powered) => {
                self.adapters.insert(path.to_owned(), powered);
            }
            None => {
                self.adapters.remove(path);
            }
        }
        match (before, self.any_powered()) {
            (true, false) => Some(Trigger::AdapterDown),
            (false, true) => Some(Trigger::AdapterUp),
            _ => None,
        }
    }

    fn is_phone(&self, path: &str) -> bool {
        path.ends_with(&self.device_suffix)
    }

    /// The trigger a signal implies, if any.
    pub fn apply(&mut self, signal: &SystemSignal) -> Option<Trigger> {
        match signal {
            SystemSignal::PrepareForSleep(true) => Some(Trigger::Sleep),
            SystemSignal::PrepareForSleep(false) => Some(Trigger::Resume),
            SystemSignal::Added(path, interfaces) => {
                let props = interfaces.get(ADAPTER_INTERFACE)?;
                self.set_adapter(path, Some(powered(props).unwrap_or(false)))
            }
            SystemSignal::Removed(path, interfaces) => {
                if interfaces.iter().any(|i| i == ADAPTER_INTERFACE) {
                    self.set_adapter(path, None)
                } else if interfaces.iter().any(|i| i == DEVICE_INTERFACE) && self.is_phone(path) {
                    Some(Trigger::DeviceDisconnected)
                } else {
                    None
                }
            }
            SystemSignal::Changed(path, interface, props) if interface == ADAPTER_INTERFACE => {
                let powered = powered(props)?;
                if !self.adapters.contains_key(path) && !powered {
                    return None;
                }
                self.set_adapter(path, Some(powered))
            }
            SystemSignal::Changed(path, interface, props)
                if interface == DEVICE_INTERFACE && self.is_phone(path) =>
            {
                match get(props, "Connected")? {
                    PropValue::Bool(true) => Some(Trigger::DeviceConnected),
                    PropValue::Bool(false) => Some(Trigger::DeviceDisconnected),
                    _ => None,
                }
            }
            SystemSignal::Changed(..) => None,
        }
    }
}

fn powered(props: &Props) -> Option<bool> {
    match get(props, "Powered")? {
        PropValue::Bool(powered) => Some(*powered),
        _ => None,
    }
}

type InterfacesAdded = (
    zbus::OwnedObjectPath,
    HashMap<String, HashMap<String, zbus::OwnedVariant>>,
);

/// Decodes a signal from one of [`watch_system`]'s match rules.
pub fn decode_signal(message: &zbus::Message) -> Option<SystemSignal> {
    let header = message.header();
    let member = header.member()?.as_str();
    let body = message.body();
    match member {
        "PrepareForSleep" => body
            .deserialize::<bool>()
            .ok()
            .map(SystemSignal::PrepareForSleep),
        "InterfacesAdded" => {
            let (path, interfaces) = body.deserialize::<InterfacesAdded>().ok()?;
            let interfaces = interfaces
                .iter()
                .map(|(name, props)| (name.clone(), props_from_zbus(props)))
                .collect();
            Some(SystemSignal::Added(path.as_str().to_owned(), interfaces))
        }
        "InterfacesRemoved" => {
            let (path, interfaces) = body
                .deserialize::<(zbus::OwnedObjectPath, Vec<String>)>()
                .ok()?;
            Some(SystemSignal::Removed(path.as_str().to_owned(), interfaces))
        }
        "PropertiesChanged" => {
            let path = header.path()?.as_str().to_owned();
            let (interface, changed, _) = body
                .deserialize::<(String, HashMap<String, zbus::OwnedVariant>, Vec<String>)>()
                .ok()?;
            Some(SystemSignal::Changed(
                path,
                interface,
                props_from_zbus(&changed),
            ))
        }
        _ => None,
    }
}

fn rules() -> Result<Vec<zbus::MatchRule<'static>>> {
    let mut rules = vec![
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .path(LOGIND_PATH)
            .interface(LOGIND_MANAGER)
            .member("PrepareForSleep")
            .build()?,
    ];
    rules.extend(bluez_rules()?);
    Ok(rules)
}

/// BlueZ objects appearing and going, and adapter or device property
/// changes.
pub(crate) fn bluez_rules() -> Result<Vec<zbus::MatchRule<'static>>> {
    let signal = || zbus::MatchRule::builder().msg_type(zbus::message::Type::Signal);
    Ok(vec![
        signal()
            .path("/")
            .interface("org.freedesktop.DBus.ObjectManager")
            .build()?,
        signal()
            .interface("org.freedesktop.DBus.Properties")
            .member("PropertiesChanged")
            .path_namespace("/org/bluez")
            .arg(0, ADAPTER_INTERFACE)
            .build()?,
        signal()
            .interface("org.freedesktop.DBus.Properties")
            .member("PropertiesChanged")
            .path_namespace("/org/bluez")
            .arg(0, DEVICE_INTERFACE)
            .build()?,
    ])
}

/// Signals matching several rules, in the order the connection received
/// them. zbus queues each rule separately, so merging the queues naively can
/// deliver a device's PropertiesChanged before its InterfacesAdded.
pub(crate) struct Signals {
    streams: Vec<zbus::MessageStream>,
    ready: VecDeque<zbus::Message>,
    closed: bool,
}

impl Signals {
    /// Subscribes to every rule before returning, so nothing sent afterwards
    /// is missed.
    pub(crate) async fn subscribe(
        connection: &zbus::Connection,
        rules: Vec<zbus::MatchRule<'static>>,
    ) -> Result<Self> {
        let mut streams = Vec::new();
        for rule in rules {
            streams.push(zbus::MessageStream::for_match_rule(rule, connection, None).await?);
        }
        Ok(Self {
            streams,
            ready: VecDeque::new(),
            closed: false,
        })
    }

    /// The next signal; `None` once the connection closes.
    pub(crate) async fn next(&mut self) -> Option<zbus::Message> {
        loop {
            if let Some(message) = self.ready.pop_front() {
                return Some(message);
            }
            if self.closed || self.streams.is_empty() {
                return None;
            }
            let (first, ..) =
                futures_util::future::select_all(self.streams.iter_mut().map(StreamExt::next))
                    .await;
            let mut batch = Vec::new();
            self.take(first, &mut batch);
            // The connection routes each message to every queue before reading
            // the next, so once one has arrived, all earlier ones are queued:
            // drain everything, then sort.
            for i in 0..self.streams.len() {
                while let Some(item) = self.streams[i].next().now_or_never() {
                    if !self.take(item, &mut batch) {
                        break;
                    }
                }
            }
            batch.sort_by_key(zbus::Message::recv_position);
            self.ready.extend(batch);
        }
    }

    fn take(
        &mut self,
        item: Option<zbus::Result<zbus::Message>>,
        batch: &mut Vec<zbus::Message>,
    ) -> bool {
        match item {
            Some(Ok(message)) => batch.push(message),
            Some(Err(_)) => {}
            None => {
                self.closed = true;
                return false;
            }
        }
        true
    }
}

/// Feeds `triggers` from the system bus until the supervisor stops or the
/// connection closes. Subscribes before reading the adapters, so a change in
/// between isn't missed; sends [`Trigger::AdapterDown`] first if no adapter
/// is powered.
pub async fn watch_system(
    connection: zbus::Connection,
    address: &str,
    triggers: TriggerSender,
) -> Result<()> {
    validate_address(address)?;
    let mut signals = Signals::subscribe(&connection, rules()?).await?;
    let mut state = SystemState::new(address);
    if let Some(trigger) = state.load(&managed_objects_on(&connection).await?)
        && !triggers.send(trigger)
    {
        return Ok(());
    }
    loop {
        tokio::select! {
            () = triggers.closed() => return Ok(()),
            message = signals.next() => {
                let Some(message) = message else { return Ok(()) };
                let Some(signal) = decode_signal(&message) else { continue };
                if let Some(trigger) = state.apply(&signal) {
                    tracing::debug!(?trigger, "system trigger");
                    if !triggers.send(trigger) {
                        return Ok(());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHONE: &str = "02:00:00:00:00:08";
    const HCI0: &str = "/org/bluez/hci0";
    const DEV: &str = "/org/bluez/hci0/dev_02_00_00_00_00_08";

    fn adapter(powered: bool) -> BTreeMap<String, Props> {
        BTreeMap::from([(
            ADAPTER_INTERFACE.to_owned(),
            Props::from([("Powered".to_owned(), PropValue::Bool(powered))]),
        )])
    }

    fn changed(path: &str, interface: &str, key: &str, value: bool) -> SystemSignal {
        SystemSignal::Changed(
            path.to_owned(),
            interface.to_owned(),
            Props::from([(key.to_owned(), PropValue::Bool(value))]),
        )
    }

    #[test]
    fn sleep_and_resume() {
        let mut state = SystemState::new(PHONE);
        assert_eq!(
            state.apply(&SystemSignal::PrepareForSleep(true)),
            Some(Trigger::Sleep)
        );
        assert_eq!(
            state.apply(&SystemSignal::PrepareForSleep(false)),
            Some(Trigger::Resume)
        );
    }

    #[test]
    fn load_reports_no_powered_adapter() {
        let mut state = SystemState::new(PHONE);
        assert_eq!(
            state.load(&ManagedObjects::new()),
            Some(Trigger::AdapterDown)
        );
        let objects = ManagedObjects::from([(HCI0.to_owned(), adapter(false))]);
        assert_eq!(state.load(&objects), Some(Trigger::AdapterDown));
        let objects = ManagedObjects::from([(HCI0.to_owned(), adapter(true))]);
        assert_eq!(state.load(&objects), None);
    }

    #[test]
    fn adapter_power_and_presence_flip_the_trigger_once() {
        let mut state = SystemState::new(PHONE);
        state.load(&ManagedObjects::from([(HCI0.to_owned(), adapter(true))]));
        let off = changed(HCI0, ADAPTER_INTERFACE, "Powered", false);
        let on = changed(HCI0, ADAPTER_INTERFACE, "Powered", true);
        assert_eq!(state.apply(&off), Some(Trigger::AdapterDown));
        assert_eq!(state.apply(&off), None);
        assert_eq!(state.apply(&on), Some(Trigger::AdapterUp));
        let removed = SystemSignal::Removed(HCI0.to_owned(), vec![ADAPTER_INTERFACE.to_owned()]);
        assert_eq!(state.apply(&removed), Some(Trigger::AdapterDown));
        let added = SystemSignal::Added("/org/bluez/hci1".to_owned(), adapter(true));
        assert_eq!(state.apply(&added), Some(Trigger::AdapterUp));
        // A second powered adapter changes nothing; losing one of two neither.
        assert_eq!(
            state.apply(&SystemSignal::Added(HCI0.to_owned(), adapter(true))),
            None
        );
        assert_eq!(state.apply(&removed), None);
        // Other properties are ignored.
        let discoverable = changed(HCI0, ADAPTER_INTERFACE, "Discoverable", true);
        assert_eq!(state.apply(&discoverable), None);
    }

    #[test]
    fn only_the_phones_link_counts() {
        let mut state = SystemState::new(PHONE);
        assert_eq!(
            state.apply(&changed(DEV, DEVICE_INTERFACE, "Connected", true)),
            Some(Trigger::DeviceConnected)
        );
        assert_eq!(
            state.apply(&changed(DEV, DEVICE_INTERFACE, "Connected", false)),
            Some(Trigger::DeviceDisconnected)
        );
        let other = "/org/bluez/hci0/dev_00_11_22_33_44_55";
        assert_eq!(
            state.apply(&changed(other, DEVICE_INTERFACE, "Connected", true)),
            None
        );
        assert_eq!(
            state.apply(&changed(DEV, DEVICE_INTERFACE, "RSSI", true)),
            None
        );
        let removed = SystemSignal::Removed(DEV.to_owned(), vec![DEVICE_INTERFACE.to_owned()]);
        assert_eq!(state.apply(&removed), Some(Trigger::DeviceDisconnected));
    }

    #[test]
    fn lowercase_addresses_match_bluez_paths() {
        let mut state = SystemState::new("02:00:00:00:00:0a");
        let path = "/org/bluez/hci0/dev_02_00_00_00_00_0A";
        assert_eq!(
            state.apply(&changed(path, DEVICE_INTERFACE, "Connected", true)),
            Some(Trigger::DeviceConnected)
        );
    }
}

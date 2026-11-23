//! The `Bluetooth` class: adapter state, discovery, pairing and device
//! changes over BlueZ on the system bus.

use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use napi::bindgen_prelude::{Either, Promise, PromiseRaw};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use napi_derive::napi;
use tincan_bt::bluez;
use tincan_bt::device::{self, DeviceEvent, DeviceEvents, PairingRequest, PairingResponder};

use crate::{AdapterInfo, BtDevice, spawn_js};

/// What BlueZ asks while pairing. Answer `true` to accept.
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum BtPairingRequest {
    /// Numeric comparison: accept only if the phone shows the same six-digit
    /// `passkey`.
    Confirm { address: String, passkey: String },
    /// "Just Works" pairing: there is no passkey to compare.
    Authorize { address: String },
}

/// A change to an adapter or device.
#[napi(discriminant = "kind", discriminant_case = "camelCase")]
pub enum BtDeviceEvent {
    DeviceAdded { device: BtDevice },
    DeviceChanged { device: BtDevice },
    DeviceRemoved { path: String, address: String },
    AdapterChanged { adapter: AdapterInfo },
    AdapterRemoved { path: String },
}

impl From<DeviceEvent> for BtDeviceEvent {
    fn from(event: DeviceEvent) -> Self {
        match event {
            DeviceEvent::DeviceAdded(d) => Self::DeviceAdded { device: d.into() },
            DeviceEvent::DeviceChanged(d) => Self::DeviceChanged { device: d.into() },
            DeviceEvent::DeviceRemoved { path, address } => Self::DeviceRemoved { path, address },
            DeviceEvent::AdapterChanged(a) => Self::AdapterChanged { adapter: a.into() },
            DeviceEvent::AdapterRemoved { path } => Self::AdapterRemoved { path },
        }
    }
}

type PairingCallback = ThreadsafeFunction<
    BtPairingRequest,
    Either<bool, Promise<bool>>,
    BtPairingRequest,
    Status,
    false,
>;

/// Asks `callback` and waits for its answer, a boolean or a promise of one.
/// A throw, a rejection or anything else declines.
fn responder(address: String, callback: PairingCallback) -> PairingResponder {
    let callback = Arc::new(callback);
    Arc::new(move |request| {
        let callback = Arc::clone(&callback);
        let address = address.clone();
        async move {
            let request = match request {
                PairingRequest::Confirm { passkey } => BtPairingRequest::Confirm {
                    address,
                    passkey: format!("{passkey:06}"),
                },
                PairingRequest::Authorize => BtPairingRequest::Authorize { address },
            };
            let answer = callback.call_async_catch(request).await.ok();
            match answer {
                Some(Either::A(accept)) => accept,
                Some(Either::B(promise)) => promise.await.unwrap_or(false),
                None => false,
            }
        }
        .boxed()
    })
}

/// Bluetooth over BlueZ on the system bus. Keeps one bus connection; it
/// does not keep Node running.
#[napi]
pub struct Bluetooth {
    connection: zbus::Connection,
}

#[napi]
impl Bluetooth {
    /// Connects to the system bus. Rejects `NOT_CONNECTED` when it is
    /// unavailable.
    #[napi(ts_return_type = "Promise<Bluetooth>")]
    pub fn open(env: &Env) -> napi::Result<PromiseRaw<'_, Bluetooth>> {
        spawn_js(env, bluez::system_bus(), |connection| Bluetooth {
            connection,
        })
    }

    /// The first powered adapter, else the first one; `null` if there is
    /// none.
    #[napi(ts_return_type = "Promise<AdapterInfo | null>")]
    pub fn adapter<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<PromiseRaw<'env, Option<AdapterInfo>>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::adapter(&connection).await },
            |adapter| adapter.map(Into::into),
        )
    }

    /// Every device BlueZ knows.
    #[napi(ts_return_type = "Promise<Array<BtDevice>>")]
    pub fn devices<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, Vec<BtDevice>>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { bluez::snapshot_on(&connection).await },
            |snapshot| snapshot.devices.into_iter().map(Into::into).collect(),
        )
    }

    /// Starts discovery on the default adapter; found devices arrive as
    /// `deviceAdded` events. Rejects `NOT_CONNECTED` when the adapter is
    /// off and `NOT_FOUND` when there is none.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn start_discovery<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::start_discovery(&connection).await },
            |()| (),
        )
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn stop_discovery<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::stop_discovery(&connection).await },
            |()| (),
        )
    }

    /// Makes the default adapter discoverable, so an iPhone lists this
    /// computer and can start pairing itself; BlueZ hides it again after its
    /// discoverable timeout. Rejects like `startDiscovery`.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn set_discoverable<'env>(
        &self,
        env: &'env Env,
        discoverable: bool,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::set_discoverable(&connection, discoverable).await },
            |()| (),
        )
    }

    /// Pairs with `address` and trusts it. **Talks to the device.** BlueZ's
    /// questions go to `onRequest`; return (or resolve) `true` to accept. A
    /// throw or anything but a boolean declines. Already paired: only
    /// trusts it. Rejects `NOT_FOUND` for an unknown device, `BUSY` while
    /// another pairing runs on this connection, and `PERMISSION_DENIED`
    /// when either side declines or the pairing is cancelled.
    #[napi(
        ts_args_type = "address: string, onRequest: (request: BtPairingRequest) => boolean | Promise<boolean>",
        ts_return_type = "Promise<void>"
    )]
    pub fn pair<'env>(
        &self,
        env: &'env Env,
        address: String,
        on_request: PairingCallback,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        let respond = responder(address.clone(), on_request);
        spawn_js(
            env,
            async move { device::pair(&connection, &address, respond).await },
            |()| (),
        )
    }

    /// Abandons a pairing in progress; its `pair()` rejects.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn cancel_pairing<'env>(
        &self,
        env: &'env Env,
        address: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::cancel_pairing(&connection, &address).await },
            |()| (),
        )
    }

    /// Connects the device's profiles. **Talks to the device.** Rejects
    /// `NOT_CONNECTED` when it is unpaired or out of range.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn connect<'env>(
        &self,
        env: &'env Env,
        address: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::connect(&connection, &address).await },
            |()| (),
        )
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn disconnect<'env>(
        &self,
        env: &'env Env,
        address: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::disconnect(&connection, &address).await },
            |()| (),
        )
    }

    /// Removes the device and its pairing from BlueZ.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn forget<'env>(
        &self,
        env: &'env Env,
        address: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move { device::forget(&connection, &address).await },
            |()| (),
        )
    }

    /// Reports every later adapter and device change to `onEvent` (read the
    /// current state with `adapter()` and `devices()` after this resolves).
    /// Keeps Node running until `close()`.
    #[napi(ts_return_type = "Promise<DeviceWatch>")]
    pub fn watch_devices<'env>(
        &self,
        env: &'env Env,
        on_event: ThreadsafeFunction<BtDeviceEvent, (), BtDeviceEvent, Status, false>,
    ) -> napi::Result<PromiseRaw<'env, DeviceWatch>> {
        let connection = self.connection.clone();
        spawn_js(
            env,
            async move {
                let mut events = DeviceEvents::subscribe(&connection).await?;
                let task = crate::spawn_logged("Bluetooth device events", async move {
                    while let Some(event) = events.next().await {
                        on_event.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                });
                Ok::<_, tincan_bt::Error>(task.abort_handle())
            },
            |task| DeviceWatch {
                task: Mutex::new(Some(task)),
            },
        )
    }
}

/// A running `watchDevices()` subscription.
#[napi]
pub struct DeviceWatch {
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

#[napi]
impl DeviceWatch {
    /// Stops the events and releases the callback. Safe to call twice.
    #[napi]
    pub fn close(&self) {
        let task = self
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            task.abort();
        }
    }
}

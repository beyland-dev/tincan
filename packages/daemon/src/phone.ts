import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  AncsWatcher,
  ContactSync,
  DesktopNotifier,
  isHandsFree,
  Outbox,
  Pairing,
  SyncEngine,
  type AdapterInfo,
  type BluetoothHandle,
  type BtDevice,
  type Core,
  type DeviceWatchHandle,
  type PhoneDevice,
  type PhoneControl,
  type PhonePort,
} from "@beyland/tincan-core";
import { errorCodeOf, TincanError } from "@beyland/tincan-protocol";
import { copyToClipboard } from "./clipboard.ts";

/** The store setting that remembers which phone Tincan talks to. */
export const PHONE_SETTING = "phone";

export interface StartPhoneOptions {
  core: Core;
  port: PhonePort;
  /**
   * Tincan's private runtime folder in RAM, where contact photos are written briefly as
   * notification icons (`runtimeIconDir()`). Null: notifications show no photos.
   */
  iconDir?: string | null;
  log: (message: string) => void;
  /** Puts a one-time code from a notification on the clipboard (default: `copyToClipboard`). */
  copyToClipboard?: (text: string) => Promise<void>;
  /** Opens/focuses the desktop app when a notification is clicked (default: spawns `tincan-desktop`). */
  onActivate?: (threadKey: string, activationToken: string | undefined) => void;
}

export interface PhoneRuntime extends PhoneControl {
  /** The phone's address, once one is chosen. */
  readonly address: string | null;
  /** Resolves once the phone's services are running (or there is no phone to start them for). */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

interface Services {
  sync: SyncEngine;
  outbox: Outbox;
  contacts: ContactSync;
  ancs: AncsWatcher | null;
}

/**
 * Starts desktop notifications and, once a paired iPhone is known, its MAP, PBAP and ANCS services,
 * attaching them to the core. The phone is the one remembered in the store, else the only paired
 * iPhone (a connected one if several are paired); it is remembered once chosen. Failures are logged
 * and leave Tincan running with whatever did start.
 */
export async function startPhone(options: StartPhoneOptions): Promise<PhoneRuntime> {
  const { core, port, log } = options;
  const store = core.requireStore();
  const onError = (context: string, error: unknown) => log(`${context}: ${errorCodeOf(error)}`);

  let notifier: DesktopNotifier | null = null;
  try {
    notifier = await DesktopNotifier.start({
      store,
      events: core.events,
      port,
      settings: () => core.settings,
      iconDir: options.iconDir ?? null,
      onActivate: options.onActivate ?? activateDesktop,
      onCopyCode: (code) => (options.copyToClipboard ?? copyToClipboard)(code),
      // The Cancel button on an agent's send in its delay is the user's own action.
      onCancelSend: async (id) => {
        await core.run("message.cancel", { id }, { kind: "desktop", name: "Tincan notification" });
      },
      onError,
    });
  } catch (error) {
    log(`desktop notifications unavailable (${errorCodeOf(error)})`);
  }

  const remembered = storedPhone(core);
  let address = remembered.address;
  /** The user disconnected the phone: show it, but don't start its services. */
  let paused = remembered.paused;
  /** A forget is under way: don't adopt the phone again while it unpairs. */
  let forgetting = false;
  let services: Services | null = null;
  let starting: Promise<void> = Promise.resolve();
  let started = false;
  let stopped = false;
  let bluetooth: BluetoothHandle | null = null;
  let watch: DeviceWatchHandle | null = null;
  let choosing = false;

  const show = (device: BtDevice) => core.setPhone({ ...phoneDevice(device), paused });
  const remember = () =>
    store.setSetting(PHONE_SETTING, address ? (paused ? { address, paused } : { address }) : null);

  const adopt = (device: BtDevice) => {
    if (forgetting) return;
    show(device);
    if (started || stopped || paused || !device.paired) return;
    started = true;
    address = device.address.toUpperCase();
    remember();
    starting = startServices(address).then(
      async (running) => {
        if (stopped) await stopServices(running);
        else services = running;
      },
      (error: unknown) => log(`phone services failed to start (${errorCodeOf(error)})`),
    );
  };

  const choose = async () => {
    if (address || choosing || forgetting || !bluetooth) return;
    choosing = true;
    try {
      const device = pickIphone(await bluetooth.devices());
      if (device && !address) adopt(device);
    } catch (error) {
      onError("bluetooth.devices", error);
    } finally {
      choosing = false;
    }
  };

  const startServices = async (phone: string): Promise<Services> => {
    const events = core.events;
    const defaultRegion = () => core.settings.defaultRegion;
    let contacts: ContactSync | undefined;
    const sync = await SyncEngine.start({
      store,
      port,
      address: phone,
      events,
      defaultRegion,
      ownHandles: () => contacts?.ownHandles ?? [],
      onError,
    });
    const outbox = new Outbox({ store, events, link: () => sync.mapLink, defaultRegion, onError });
    contacts = new ContactSync({
      store,
      port,
      address: phone,
      events,
      defaultRegion,
      onError,
    });
    let ancs: AncsWatcher | null = null;
    try {
      ancs = await AncsWatcher.start({
        port,
        address: phone,
        events,
        onError,
      });
    } catch (error) {
      log(`phone notifications unavailable (${errorCodeOf(error)})`);
    }
    core.attach({ sync, outbox, contacts, ancs: ancs ?? undefined });
    return { sync, outbox, contacts, ancs };
  };

  // What Settings shows about the adapter, to tell the app when it changes.
  let adapterSeen: { name: string; powered: boolean; handsFree: boolean | null } | null = null;
  const adapterChanged = (adapter: AdapterInfo) => {
    const next = {
      name: adapter.alias || adapter.name,
      powered: adapter.powered,
      handsFree: isHandsFree(adapter.class),
    };
    const before = adapterSeen;
    adapterSeen = next;
    // At startup only what's wrong is worth a line in the history.
    if (before ? before.powered !== next.powered : !next.powered) {
      core.history.record("adapter", next.powered ? "on" : "off", adapter.address);
    }
    if (
      next.handsFree !== null &&
      (before ? before.handsFree !== next.handsFree : !next.handsFree)
    ) {
      core.history.record(
        "adapter",
        next.handsFree ? "hands-free" : "not-hands-free",
        adapter.address,
      );
    }
    if (before && next.handsFree === false && before.handsFree !== false) {
      // BlueZ's hostname plugin resets the class to Computer; iPhones then won't pair for messages.
      log(`the adapter's device class changed to 0x${(adapter.class ?? 0).toString(16)}`);
    }
    if (
      before &&
      (before.name !== next.name ||
        before.powered !== next.powered ||
        before.handsFree !== next.handsFree)
    ) {
      core.events.emit("device.changed", { address: adapter.address });
    }
  };

  try {
    bluetooth = await port.Bluetooth.open();
    watch = await bluetooth.watchDevices((event) => {
      switch (event.kind) {
        case "deviceAdded":
        case "deviceChanged":
          if (!address) void choose();
          else if (sameAddress(event.device.address, address)) adopt(event.device);
          return;
        case "deviceRemoved":
          if (address && sameAddress(event.address, address)) {
            const current = core.phone.device;
            if (current) core.setPhone({ ...phoneView(current), paired: false, connected: false });
          }
          return;
        case "adapterChanged":
          adapterChanged(event.adapter);
          return;
        default:
          return;
      }
    });
    const [devices, adapter] = await Promise.all([bluetooth.devices(), bluetooth.adapter()]);
    if (adapter) adapterChanged(adapter);
    const known = address
      ? devices.find((d) => sameAddress(d.address, address!))
      : pickIphone(devices);
    if (known) adopt(known);
    else if (address) log("the remembered phone is not paired with this computer");
  } catch (error) {
    log(`Bluetooth unavailable (${errorCodeOf(error)})`);
  }

  const pairing = new Pairing({
    bluetooth: () => bluetooth,
    events: core.events,
    onError,
    // A newly paired iPhone becomes the phone, replacing a remembered one that's gone.
    onPaired: async (device) => {
      if (stopped) return;
      const next = device.address.toUpperCase();
      if (address && !sameAddress(address, next)) {
        await halt();
        address = null;
      }
      paused = false;
      remember();
      adopt(device);
    },
  });

  /** Stops the phone's services, if they're running, so a later `adopt` starts them afresh. */
  const halt = async () => {
    await starting;
    core.attach({ sync: undefined, outbox: undefined, contacts: undefined, ancs: undefined });
    const running = services;
    services = null;
    started = false;
    if (running) await stopServices(running);
  };

  const requireBluetooth = (): BluetoothHandle => {
    if (!bluetooth) throw new TincanError("NOT_CONNECTED", "Bluetooth isn't available");
    return bluetooth;
  };

  const lookup = async (bt: BluetoothHandle): Promise<BtDevice | null> =>
    address ? ((await bt.devices()).find((d) => sameAddress(d.address, address!)) ?? null) : null;

  let stopping: Promise<void> | undefined;
  return {
    get address() {
      return address;
    },
    ready: () => starting,
    pairing,
    async details() {
      if (!bluetooth) return { device: null, adapter: null, paused };
      const [device, adapter] = await Promise.all([lookup(bluetooth), bluetooth.adapter()]);
      return { device, adapter, paused };
    },
    async connect() {
      const bt = requireBluetooth();
      if (!address) await choose();
      if (!address) throw new TincanError("NOT_FOUND", "No paired iPhone");
      paused = false;
      remember();
      let failure: unknown = null;
      try {
        await bt.connect(address);
      } catch (error) {
        // Messages and contacts open their own connections, so still start the services.
        failure = error;
      }
      const device = await lookup(bt);
      if (device) adopt(device);
      if (failure) throw failure;
    },
    async disconnect() {
      const bt = requireBluetooth();
      if (!address) throw new TincanError("NOT_FOUND", "No paired iPhone");
      paused = true;
      remember();
      await halt();
      await bt.disconnect(address);
      const device = await lookup(bt);
      if (device) show(device);
      else if (core.phone.device) core.setPhone({ ...phoneView(core.phone.device), paused });
    },
    async forget() {
      const bt = requireBluetooth();
      if (!address) throw new TincanError("NOT_FOUND", "No paired iPhone");
      const forgotten = address;
      forgetting = true;
      try {
        await halt();
        address = null;
        paused = false;
        remember();
        core.setPhone(null);
        await bt.forget(forgotten);
      } finally {
        forgetting = false;
      }
    },
    stop() {
      stopping ??= (async () => {
        stopped = true;
        await pairing.close();
        watch?.close();
        await starting;
        core.attach({ sync: undefined, outbox: undefined, contacts: undefined, ancs: undefined });
        if (services) await stopServices(services);
        services = null;
        await notifier?.stop();
      })();
      return stopping;
    },
  };
}

async function stopServices(services: Services): Promise<void> {
  await services.ancs?.stop();
  services.contacts.stop();
  services.outbox.stop();
  await services.sync.stop();
}

function storedPhone(core: Core): { address: string | null; paused: boolean } {
  const value = core.requireStore().getSetting(PHONE_SETTING) as {
    address?: unknown;
    paused?: unknown;
  } | null;
  const address = typeof value?.address === "string" ? value.address.toUpperCase() : null;
  return { address, paused: address !== null && value?.paused === true };
}

/** The only paired iPhone, or the only connected one when several are paired. */
export function pickIphone(devices: readonly BtDevice[]): BtDevice | null {
  const paired = devices.filter((d) => d.paired && d.isIphone);
  if (paired.length === 1) return paired[0]!;
  const connected = paired.filter((d) => d.connected);
  return connected.length === 1 ? connected[0]! : null;
}

function phoneDevice(device: BtDevice): PhoneDevice {
  return {
    address: device.address,
    name: device.alias || device.name || device.address,
    paired: device.paired,
    connected: device.connected,
  };
}

function phoneView(device: PhoneDevice): PhoneDevice {
  const { address, name, paired, connected, paused } = device;
  return { address, name, paired, connected, paused };
}

function sameAddress(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Focuses or launches the desktop app when the user clicks a notification. */
function activateDesktop(threadKey: string, activationToken: string | undefined): void {
  const command = desktopBinary();
  if (!command) return;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Pass via environment rather than argv so handles never appear in world-readable /proc/<pid>/cmdline.
  env.TINCAN_OPEN_THREAD = threadKey;
  if (activationToken) env.XDG_ACTIVATION_TOKEN = activationToken;
  // Inside `tincan.service` (ProtectHome + PrivateTmp), launch via systemd-run so the desktop app
  // can reach `~/.config/Tincan` and its Chromium `SingletonSocket` in `/tmp`.
  if (insideSystemdService()) {
    const runArgs = ["--user", "--collect", "--quiet"];
    if (env.TINCAN_OPEN_THREAD)
      runArgs.push(`--setenv=TINCAN_OPEN_THREAD=${env.TINCAN_OPEN_THREAD}`);
    if (env.XDG_ACTIVATION_TOKEN)
      runArgs.push(`--setenv=XDG_ACTIVATION_TOKEN=${env.XDG_ACTIVATION_TOKEN}`);
    runArgs.push("--", command);
    const child = spawn("systemd-run", runArgs, { detached: true, stdio: "ignore", env });
    child.on("error", () => {});
    child.unref();
    return;
  }
  const child = spawn(command, [], { detached: true, stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
}

function insideSystemdService(): boolean {
  try {
    return readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .some((line) => line.endsWith("/tincan.service"));
  } catch {
    return false;
  }
}

function desktopBinary(): string | null {
  if (process.env.TINCAN_DESKTOP_COMMAND) return process.env.TINCAN_DESKTOP_COMMAND;
  if (process.env.APPIMAGE && existsSync(process.env.APPIMAGE)) return process.env.APPIMAGE;
  if (existsSync("/opt/Tincan/tincan-desktop")) return "/opt/Tincan/tincan-desktop";
  return "tincan-desktop";
}

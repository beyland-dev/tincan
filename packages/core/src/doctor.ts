import type { DoctorCheck } from "@beyland/tincan-protocol";
import type { ConnectionEvent } from "./history.ts";
import type { NativeInfo } from "./core.ts";
import type { AncsSessionState } from "./phone.ts";
import type { SyncStatus } from "./sync.ts";

/**
 * What the daemon (or the CLI, with no daemon) found out about the computer. `null` means it couldn't
 * tell, and the check is skipped.
 */
export interface SystemFacts {
  native: NativeInfo;
  /** `bluetoothctl --version`, or `"missing"` when it isn't installed. */
  bluezVersion: string | null;
  bluetoothd: { running: boolean; experimental: boolean } | null;
  /** `bluetooth.disable_ertm`, which breaks obexd. */
  ertmDisabled: boolean | null;
  bluetooth: { adapters: AdapterFacts[]; phones: PhoneFacts[] } | { error: string } | null;
  obexd: "running" | "activatable" | "missing" | null;
  service: ServiceFacts | null;
  keyStorage: "keyring" | "file" | "memory" | null;
}

export interface AdapterFacts {
  address: string;
  name: string;
  powered: boolean;
  /** Class of Device, when BlueZ reports one. */
  class: number | null;
}

/** A paired (or known) iPhone. */
export interface PhoneFacts {
  address: string;
  name: string;
  paired: boolean;
  bonded: boolean;
  connected: boolean;
}

export interface ServiceFacts {
  installed: boolean;
  enabled: boolean | null;
  active: boolean | null;
}

/** What the running daemon knows about the phone. Null when there is no daemon. */
export interface RuntimeFacts {
  version: string;
  /** The phone Tincan is set up with, if any. */
  phoneAddress: string | null;
  map: (Pick<SyncStatus, "link" | "lastError"> & { failures?: number }) | null;
  contacts: { lastSyncAt: number | null; lastError: { code: string } | null } | null;
  ancs: AncsSessionState | null;
  /** The connection log, for spotting a phone that keeps dropping. */
  history?: { now: number; events: ConnectionEvent[] };
}

/** Facts for a computer nothing could be probed on. */
export function unknownFacts(native: NativeInfo): SystemFacts {
  return {
    native,
    bluezVersion: null,
    bluetoothd: null,
    ertmDisabled: null,
    bluetooth: null,
    obexd: null,
    service: null,
    keyStorage: null,
  };
}

/** Untested below this; it's what Ubuntu 22.04, the oldest distro we aim at, ships. */
export const MIN_BLUEZ: readonly [number, number] = [5, 64];

/** Audio/Video Hands-Free; iOS only offers its message and contact toggles to this class. */
const HANDS_FREE_CLASS = 0x0408;
const CLASS_MASK = 0x1ffc;

/** Whether a Class of Device is hands-free; null when BlueZ doesn't report one. */
export function isHandsFree(cls: number | null | undefined): boolean | null {
  return cls == null ? null : (cls & CLASS_MASK) === HANDS_FREE_CLASS;
}

const EXPERIMENTAL_HINT =
  "Run `tincan setup` (or set `Experimental = true` under [General] in /etc/bluetooth/main.conf and restart bluetooth), then pair the iPhone again.";
const CLASS_HINT =
  "Run `tincan setup` (or `sudo btmgmt class 4 8` with a systemd unit so bluetoothd doesn't reset it on restart).";

/** Turns facts into the checks `doctor` reports, in a fixed order. */
export function diagnose(facts: SystemFacts, runtime: RuntimeFacts | null): DoctorCheck[] {
  const bluetooth = facts.bluetooth && "adapters" in facts.bluetooth ? facts.bluetooth : null;
  const phones = bluetooth?.phones.filter((p) => p.paired) ?? [];
  const phone =
    phones.find((p) => sameAddress(p.address, runtime?.phoneAddress)) ?? phones[0] ?? null;
  return [
    daemonCheck(runtime),
    nativeCheck(facts.native),
    bluezCheck(facts.bluezVersion),
    bluetoothdCheck(facts.bluetoothd),
    ertmCheck(facts.ertmDisabled),
    adapterCheck(facts.bluetooth),
    classCheck(bluetooth?.adapters[0] ?? null, phone !== null),
    obexdCheck(facts.obexd),
    phoneCheck(bluetooth, phone),
    mapCheck(runtime),
    contactsCheck(runtime),
    ancsCheck(runtime),
    historyCheck(runtime),
    keyCheck(facts.keyStorage),
    serviceCheck(facts.service),
  ];
}

type Check = DoctorCheck;

function check(
  id: string,
  title: string,
  status: Check["status"],
  detail: string,
  extra: { hint?: string; autoFix?: string } = {},
): Check {
  return { id, title, status, detail, ...extra };
}

function daemonCheck(runtime: RuntimeFacts | null): Check {
  return runtime
    ? check("daemon", "Tincan daemon", "ok", `Running ${runtime.version}`)
    : check("daemon", "Tincan daemon", "fail", "Not running", {
        hint: "Run `tincan service install` to start it in the background, or `tincan daemon` in a terminal.",
        autoFix: "service.install",
      });
}

function nativeCheck(native: NativeInfo): Check {
  return native.loaded
    ? check("native", "Bluetooth addon", "ok", `Loaded ${native.version ?? ""}`.trim())
    : check("native", "Bluetooth addon", "fail", native.error ?? "Not loaded", {
        hint: "Reinstall Tincan, or run `pnpm build:native` in a checkout.",
      });
}

function bluezCheck(version: string | null): Check {
  if (version === null) return check("bluez", "BlueZ", "skip", "Couldn't run bluetoothctl");
  if (version === "missing") {
    return check("bluez", "BlueZ", "fail", "bluetoothctl isn't installed", {
      hint: "Install your distribution's bluez package.",
    });
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const old = major < MIN_BLUEZ[0] || (major === MIN_BLUEZ[0] && minor < MIN_BLUEZ[1]);
  return old
    ? check("bluez", "BlueZ", "warn", `${version} is older than Tincan is tested with`, {
        hint: `Update BlueZ to ${MIN_BLUEZ.join(".")} or newer.`,
      })
    : check("bluez", "BlueZ", "ok", version);
}

function bluetoothdCheck(facts: SystemFacts["bluetoothd"]): Check {
  const title = "Bluetooth service";
  if (!facts) return check("bluetoothd", title, "skip", "Couldn't inspect bluetoothd");
  if (!facts.running) {
    return check("bluetoothd", title, "fail", "bluetoothd isn't running", {
      hint: "Run `systemctl enable --now bluetooth`.",
    });
  }
  return facts.experimental
    ? check("bluetoothd", title, "ok", "Running with experimental features")
    : check(
        "bluetoothd",
        title,
        "warn",
        "Experimental features are off, so notifications (ANCS) won't work. Turn them on before pairing.",
        { hint: EXPERIMENTAL_HINT, autoFix: "system.setup" },
      );
}

function ertmCheck(disabled: boolean | null): Check {
  const title = "Kernel Bluetooth options";
  if (disabled === null)
    return check("kernel", title, "skip", "Couldn't read bluetooth.disable_ertm");
  return disabled
    ? check(
        "kernel",
        title,
        "fail",
        "bluetooth.disable_ertm=1 breaks message and contact transfers",
        {
          hint: "Remove bluetooth.disable_ertm=1 from the kernel command line or /etc/modprobe.d, then reboot.",
        },
      )
    : check("kernel", title, "ok", "ERTM is enabled");
}

function adapterCheck(bluetooth: SystemFacts["bluetooth"]): Check {
  const title = "Bluetooth adapter";
  if (!bluetooth) return check("adapter", title, "skip", "Couldn't read BlueZ");
  if ("error" in bluetooth) {
    return check("adapter", title, "fail", bluetooth.error, {
      hint: "Check that bluetoothd is running and the system bus is reachable.",
    });
  }
  const adapter = bluetooth.adapters[0];
  if (!adapter) {
    return check("adapter", title, "fail", "No Bluetooth adapter found", {
      hint: "Plug in an adapter, or check `rfkill list` for a blocked one.",
    });
  }
  const label = `${adapter.name} (${adapter.address})`;
  return adapter.powered
    ? check("adapter", title, "ok", label)
    : check("adapter", title, "fail", `${label} is off`, {
        hint: "Run `bluetoothctl power on`, and `rfkill unblock bluetooth` if it's blocked.",
      });
}

function classCheck(adapter: AdapterFacts | null, paired: boolean): Check {
  const title = "Device class";
  if (!adapter) return check("class", title, "skip", "No adapter");
  if (adapter.class === null)
    return check("class", title, "skip", "BlueZ doesn't report the class");
  const hex = `0x${adapter.class.toString(16).padStart(6, "0")}`;
  if (isHandsFree(adapter.class)) {
    return check("class", title, "ok", `Hands-free (${hex})`);
  }
  // Permissions already granted survive a class change; only pairing again needs it.
  return paired
    ? check(
        "class",
        title,
        "warn",
        `${hex} isn't hands-free. The paired phone keeps working, but pairing again needs it.`,
        { hint: CLASS_HINT, autoFix: "system.setup" },
      )
    : check(
        "class",
        title,
        "fail",
        `${hex} isn't hands-free, so the iPhone won't offer to share messages or contacts`,
        { hint: CLASS_HINT, autoFix: "system.setup" },
      );
}

function obexdCheck(obexd: SystemFacts["obexd"]): Check {
  const title = "OBEX service";
  if (obexd === null) return check("obexd", title, "skip", "Couldn't read the session bus");
  return obexd === "missing"
    ? check("obexd", title, "fail", "obexd isn't available on the session bus", {
        hint: "Install your distribution's bluez-obexd (or bluez) package.",
      })
    : check("obexd", title, "ok", obexd === "running" ? "Running" : "Starts on demand");
}

function phoneCheck(bluetooth: { phones: PhoneFacts[] } | null, phone: PhoneFacts | null): Check {
  const title = "iPhone";
  if (!bluetooth) return check("phone", title, "skip", "Couldn't read BlueZ");
  if (!phone) {
    return check("phone", title, "fail", "No iPhone is paired", {
      hint: "Run `tincan pair`, or on the iPhone open Settings › Bluetooth and tap this computer.",
    });
  }
  const label = `${phone.name} (${phone.address})`;
  if (!phone.bonded) {
    return check("phone", title, "warn", `${label} is paired without a bond`, {
      hint: "Forget the computer on the iPhone and run `tincan pair` again.",
    });
  }
  return phone.connected
    ? check("phone", title, "ok", `${label} is connected`)
    : check("phone", title, "warn", `${label} isn't connected`, {
        hint: "Keep the iPhone nearby and unlocked; Tincan reconnects on its own.",
      });
}

const NO_DAEMON = "The daemon isn't running";
const NO_PHONE = "No phone is set up";

const MESSAGES_TOGGLE =
  "On the iPhone, open Settings › Bluetooth, tap (i) next to this computer and turn on Show Message Notifications.";
const CONTACTS_TOGGLE =
  "On the iPhone, open Settings › Bluetooth, tap (i) next to this computer and turn on Sync Contacts.";

/** Tincan also refuses (PERMISSION_DENIED) a phone BlueZ doesn't report as paired and bonded. */
const NOT_BONDED_HINT =
  "If it's already on, pair the iPhone again (`tincan pair`): Tincan only syncs with a phone that is paired and bonded.";

const NOT_OFFERED_HINT =
  "If the toggle is missing or already on, forget this computer on the iPhone, restart the iPhone and pair again (`tincan pair`).";

function mapCheck(runtime: RuntimeFacts | null): Check {
  const title = "Messages (MAP)";
  if (!runtime) return check("map", title, "skip", NO_DAEMON);
  const map = runtime.map;
  if (!map) return check("map", title, "skip", NO_PHONE);
  if (map.link.kind === "connected") return check("map", title, "ok", "Connected");
  switch (map.lastError?.code) {
    case "BUSY":
      return check(
        "map",
        title,
        "fail",
        "Another computer or app holds the phone's message connection",
        {
          hint: "Quit other Bluetooth messaging apps, or turn off Bluetooth on other computers connected to this iPhone.",
        },
      );
    case "PERMISSION_DENIED":
      return check("map", title, "fail", "The iPhone refused access to messages", {
        hint: `${MESSAGES_TOGGLE} ${NOT_BONDED_HINT}`,
      });
    case "NOT_FOUND":
      return check(
        "map",
        title,
        "fail",
        `The iPhone isn't offering messages to this computer${map.failures && map.failures > 1 ? ` (${map.failures} tries in a row)` : ""}`,
        { hint: `${MESSAGES_TOGGLE} ${NOT_OFFERED_HINT}` },
      );
  }
  switch (map.link.kind) {
    case "paused":
      return check("map", title, "warn", `Paused (${map.link.reason})`);
    case "stopped":
      return check("map", title, "warn", "Stopped");
    case "waiting":
      return check("map", title, "warn", `Reconnecting (attempt ${map.link.attempt})`, {
        hint: map.lastError ? `Last error: ${map.lastError.code}` : undefined,
      });
    default:
      return check("map", title, "warn", "Connecting");
  }
}

function contactsCheck(runtime: RuntimeFacts | null): Check {
  const title = "Contacts (PBAP)";
  if (!runtime) return check("contacts", title, "skip", NO_DAEMON);
  const contacts = runtime.contacts;
  if (!contacts) return check("contacts", title, "skip", NO_PHONE);
  if (contacts.lastError?.code === "PERMISSION_DENIED") {
    return check("contacts", title, "fail", "The iPhone refused access to contacts", {
      hint: `${CONTACTS_TOGGLE} ${NOT_BONDED_HINT}`,
    });
  }
  if (contacts.lastError) {
    return check("contacts", title, "warn", `The last sync failed (${contacts.lastError.code})`);
  }
  return contacts.lastSyncAt === null
    ? check("contacts", title, "warn", "Not synced yet")
    : check("contacts", title, "ok", `Synced ${new Date(contacts.lastSyncAt).toISOString()}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Drops in a day before the history check warns. */
export const DROPS_WARN = 3;

function historyCheck(runtime: RuntimeFacts | null): Check {
  const title = "Connection history";
  if (!runtime) return check("history", title, "skip", NO_DAEMON);
  const { now, events } = runtime.history ?? { now: 0, events: [] };
  if (events.length === 0) return check("history", title, "skip", "Nothing recorded yet");
  const since = now - DAY_MS;
  let drops = 0;
  let lastConnected: number | null = null;
  let previous: string | null = null;
  for (const e of events) {
    if (e.kind !== "phone") continue;
    if (
      previous === "connected" &&
      e.state !== "connected" &&
      e.state !== "paused" &&
      e.at >= since
    ) {
      drops++;
    }
    if (e.state === "connected") lastConnected = e.at;
    previous = e.state;
  }
  const recent = events.filter((e) => e.at >= since);
  const refused = recent.some(
    (e) => e.kind === "messages" && (e.state === "refused" || e.state === "denied"),
  );
  const resets = recent.some((e) => e.kind === "adapter" && e.state === "not-hands-free");
  const parts = [
    lastConnected === null
      ? "Not connected since the log began"
      : `Last connected ${new Date(lastConnected).toISOString()}`,
  ];
  if (drops > 0) parts.push(`dropped ${drops} time${drops === 1 ? "" : "s"} in the last day`);
  if (refused) parts.push("the iPhone refused messages in the last day");
  if (resets) parts.push("the adapter stopped being hands-free in the last day");
  const detail = parts.join("; ");
  if (drops < DROPS_WARN && !refused && !resets) return check("history", title, "ok", detail);
  return check("history", title, "warn", detail, {
    hint:
      drops >= DROPS_WARN
        ? "Keep the iPhone close and unlocked for a while; if it keeps dropping, restart Bluetooth on both sides. `tincan device history` shows when each drop happened."
        : "`tincan device history` shows when it happened.",
  });
}

function ancsCheck(runtime: RuntimeFacts | null): Check {
  const title = "Notifications (ANCS)";
  if (!runtime) return check("ancs", title, "skip", NO_DAEMON);
  const state = runtime.ancs;
  if (!state) return check("ancs", title, "skip", NO_PHONE);
  switch (state.kind) {
    case "ready":
      return check("ancs", title, "ok", "Subscribed");
    case "waiting":
      return check("ancs", title, "warn", state.hint);
    case "unavailable":
      return check("ancs", title, "fail", state.reason, {
        hint:
          state.code === "PERMISSION_DENIED"
            ? "On the iPhone, open Settings › Bluetooth, tap (i) next to this computer and turn on Share System Notifications."
            : EXPERIMENTAL_HINT,
      });
    case "closed":
      return check("ancs", title, "warn", "Closed");
  }
}

function keyCheck(storage: SystemFacts["keyStorage"]): Check {
  const title = "Database key";
  switch (storage) {
    case "keyring":
      return check("keyring", title, "ok", "In the keyring");
    case "file":
      return check("keyring", title, "warn", "In a file, because no keyring was available", {
        hint: "Install and unlock a Secret Service keyring (GNOME Keyring or KWallet).",
      });
    default:
      return check("keyring", title, "skip", "The message store isn't open");
  }
}

function serviceCheck(service: ServiceFacts | null): Check {
  const title = "Background service";
  if (!service) return check("service", title, "skip", "Couldn't ask systemd");
  const fix = { hint: "Run `tincan service install`.", autoFix: "service.install" };
  if (!service.installed) {
    return check(
      "service",
      title,
      "warn",
      "Not installed, so Tincan only runs while `tincan daemon` does",
      fix,
    );
  }
  if (service.enabled === false)
    return check("service", title, "warn", "Installed but not enabled", fix);
  if (service.active === false) {
    return check("service", title, "warn", "Installed but not running", {
      hint: "Run `systemctl --user status tincan` to see why.",
    });
  }
  return check("service", title, "ok", "Installed and running");
}

function sameAddress(a: string, b: string | null | undefined): boolean {
  return !!b && a.toUpperCase() === b.toUpperCase();
}

import { z } from "zod";
import { defineContract } from "../contract.ts";
import { BluetoothAddress, ConnectionState, ProfileState, Timestamp } from "../entities.ts";

export const DeviceInfo = z.object({
  state: ConnectionState,
  /** The phone Tincan talks to; null when none is set up. */
  phone: z
    .object({
      address: BluetoothAddress,
      name: z.string(),
      /** The name the phone gives itself, when it differs from `name` (a local alias). */
      deviceName: z.string().nullable(),
      paired: z.boolean(),
      bonded: z.boolean(),
      trusted: z.boolean(),
      connected: z.boolean(),
      /** The user disconnected it from Tincan; Tincan won't reconnect until asked to. */
      paused: z.boolean(),
      /** What the phone offers: Messages (MAP), Contacts (PBAP), Notifications (ANCS). */
      supports: z.object({ map: z.boolean(), pbap: z.boolean(), ancs: z.boolean() }),
      profiles: z.object({ map: ProfileState, pbap: ProfileState, ancs: ProfileState }),
    })
    .nullable(),
  /** This computer's Bluetooth adapter; null when there is none. */
  adapter: z
    .object({
      address: BluetoothAddress,
      name: z.string(),
      powered: z.boolean(),
      /**
       * Whether its Class of Device is hands-free, which iOS needs at pairing time to offer messages
       * and contacts; null when BlueZ doesn't report the class.
       */
      handsFree: z.boolean().nullable(),
    })
    .nullable(),
  lastSync: z.object({
    messages: Timestamp.nullable(),
    contacts: Timestamp.nullable(),
  }),
  stored: z.object({
    threads: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    contacts: z.number().int().nonnegative(),
  }),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

const Changed = z.object({ address: BluetoothAddress.nullable() });

export const info = defineContract({
  name: "device.info",
  title: "Phone details",
  description:
    "The phone Tincan talks to and this computer's Bluetooth adapter: names, addresses, pairing, what the phone supports and how much Tincan has kept.",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: DeviceInfo,
});

export const connect = defineContract({
  name: "device.connect",
  title: "Connect the phone",
  description:
    "Connect to the phone and start syncing again, after a disconnect or when it didn't reconnect by itself. Also retries messages straight away, for instance after allowing them on the iPhone.",
  kind: "mutation",
  internal: true,
  input: z.object({}),
  output: Changed,
});

export const disconnect = defineContract({
  name: "device.disconnect",
  title: "Disconnect the phone",
  description:
    "Disconnect the phone and stop syncing until `device.connect`. The phone stays paired and Tincan keeps its messages.",
  kind: "mutation",
  internal: true,
  input: z.object({}),
  output: Changed,
});

export const forget = defineContract({
  name: "device.forget",
  title: "Forget the phone",
  description:
    "Unpair the phone from this computer and stop using it. Tincan keeps its messages; pairing again needs the phone.",
  kind: "mutation",
  internal: true,
  destructive: true,
  input: z.object({}),
  output: Changed,
});

export const PairingState = z.enum(["idle", "searching", "pairing", "confirm", "paired", "failed"]);
export type PairingState = z.infer<typeof PairingState>;

export const PairingStatus = z.object({
  /**
   * `searching`: looking for iPhones (and visible to them); `pairing`: asking one to pair;
   * `confirm`: both screens show `passkey` and wait for the user; `paired` and `failed` stay
   * until the next start or cancel.
   */
  state: PairingState,
  /** iPhones in range that aren't paired with this computer yet. */
  candidates: z.array(z.object({ address: BluetoothAddress, name: z.string() })),
  /** The iPhone being (or just) paired. */
  address: BluetoothAddress.nullable(),
  name: z.string().nullable(),
  /** The six-digit code to compare with the iPhone's, while `confirm`. */
  passkey: z.string().nullable(),
  /** This computer as the iPhone lists it under Settings › Bluetooth. */
  adapterName: z.string().nullable(),
  /** Whether iPhones can see this computer right now. */
  discoverable: z.boolean(),
  /** Whether this computer looks hands-free to iPhones (see `device.info`); null when unknown. */
  handsFree: z.boolean().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PairingStatus = z.infer<typeof PairingStatus>;

export const pairStart = defineContract({
  name: "device.pair.start",
  title: "Pair an iPhone",
  description:
    "Look for iPhones and make this computer visible to them for a couple of minutes, or, with `address`, ask that iPhone to pair. Watch `pairing.changed` and read `device.pair.status`; confirm the code with `device.pair.confirm`. Pairing from the iPhone's Settings › Bluetooth while searching works too.",
  kind: "mutation",
  internal: true,
  positional: ["address"],
  input: z.object({ address: BluetoothAddress.optional() }),
  output: PairingStatus,
});

export const pairConfirm = defineContract({
  name: "device.pair.confirm",
  title: "Confirm the pairing code",
  description: "Accept (or reject) the pairing code shown on both screens.",
  kind: "mutation",
  internal: true,
  input: z.object({ accept: z.boolean() }),
  output: PairingStatus,
});

export const pairCancel = defineContract({
  name: "device.pair.cancel",
  title: "Stop pairing",
  description:
    "Stop looking for iPhones, hide this computer again and abandon a pairing under way.",
  kind: "mutation",
  internal: true,
  input: z.object({}),
  output: PairingStatus,
});

export const pairStatus = defineContract({
  name: "device.pair.status",
  title: "Pairing status",
  description: "Where pairing a new iPhone has got to.",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: PairingStatus,
});

export const ConnectionEventKind = z.enum(["phone", "messages", "pairing", "adapter"]);
export type ConnectionEventKind = z.infer<typeof ConnectionEventKind>;

export const ConnectionEvent = z.object({
  at: Timestamp,
  kind: ConnectionEventKind,
  /**
   * `phone`: the connection state, `paused` after the user disconnected it, or `none` once no phone
   * is set up; `messages`: the MAP profile
   * state; `pairing`: the pairing state; `adapter`: `on`, `off`, `hands-free` or `not-hands-free`.
   */
  state: z.string(),
  address: BluetoothAddress.nullable(),
  /** The error code behind a failure, when there is one. */
  code: z.string().nullable(),
});
export type ConnectionEvent = z.infer<typeof ConnectionEvent>;

export const history = defineContract({
  name: "device.history",
  title: "Connection history",
  description:
    "Recent changes to the phone's connection, messages access, pairing and this computer's adapter, oldest first. Useful for working out why the phone keeps dropping or stopped syncing.",
  kind: "query",
  internal: true,
  input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  output: z.array(ConnectionEvent),
});

# Native layer (`tincan-bt`, `tincan-napi`, `@beyland/tincan-native`)

The Rust side of Tincan: Bluetooth access over BlueZ D-Bus, plus the bMessage and vCard parsers,
exposed to Node through a napi-rs v3 addon. The original target API is in
[history/plan.md §5.3](history/plan.md). This document describes what exists today.

## Layout

| Path                                  | What it is                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `crates/tincan-bt`                    | Pure Rust library, with no Node dependency                                             |
| `├─ src/error.rs`                     | `ErrorCode`, `Error`, `classify_dbus_error`, `bus_unavailable`                         |
| `├─ src/props.rs`                     | Owned D-Bus property values (`PropValue`, `Props`), so parsing is testable             |
| `├─ src/bluez.rs`                     | Read-only system-bus client: `GetManagedObjects` → adapters and devices                |
| `├─ src/device.rs`                    | Pairing agent, discovery, pair/connect/disconnect/forget, `DeviceEvents`               |
| `├─ src/map.rs`                       | OBEX MAP session client (session bus), tried on an iPhone in Phase 0.1                 |
| `├─ src/obex.rs`                      | Shared obexd client plumbing: sessions, transfers, private temp files (MAP and PBAP)   |
| `├─ src/pbap.rs`                      | OBEX PBAP session client: select, pull and count phonebooks, version counters          |
| `├─ src/ancs/`                        | ANCS client: protocol, parser, sequencer, registry, session                            |
| `├─ src/supervisor.rs`                | `MapSupervisor`: keeps one MAP session open across link loss, sleep and adapters       |
| `├─ src/system.rs`                    | `watch_system`: logind and BlueZ signals → supervisor `Trigger`s                       |
| `├─ src/bmessage.rs`                  | bMessage parser/builder, phone normalisation, `thread_key_for`, MAP timestamps         |
| `├─ src/vcard.rs`                     | vCard 2.1/3.0 parser (quoted-printable, charsets, photos, call history)                |
| `├─ examples/probe.rs`                | Read-only probe: prints adapters, devices and iPhones as JSON                          |
| `├─ examples/pbap_spike.rs`           | Live read-only PBAP spike: phonebook sizes, pulls and timings, counts only             |
| `├─ examples/fake_bluez.rs`           | Serves the fake BlueZ on a private bus, for the node tests                             |
| `├─ examples/fake_notifications.rs`   | Serves the fake notification server on a private bus, for the node tests               |
| `├─ examples/fake_obexd.rs`           | Serves the fake obexd (synthetic phonebook) on a private bus, for the node tests       |
| `├─ examples/fake_ancs.rs`            | Serves the fake iPhone (ANCS over fake BlueZ GATT) on a private bus, for node tests    |
| `├─ tests/fixtures.rs`                | Parser tests over `fixtures/`                                                          |
| `├─ tests/support/mod.rs`             | Fake obexd MAP and PBAP client API, peer-to-peer or on a private bus                   |
| `├─ tests/support/bluez.rs`           | Fake BlueZ: one adapter, a known and a discoverable device, agent round trips          |
| `├─ tests/support/ancs.rs`            | Fake iPhone: BlueZ GATT objects for ANCS, fragmented replies, link loss, sharing off   |
| `├─ tests/support/notifications.rs`   | Fake freedesktop notification server: records calls, emits clicks and closes           |
| `├─ tests/device.rs`                  | Pairing, device operations and `DeviceEvents` against the fake BlueZ                   |
| `├─ tests/notify.rs`                  | `notify`, `close`, `NotificationSignals` and the tracker against the fake server       |
| `├─ tests/map_session.rs`             | `MapSession` against the fake obexd                                                    |
| `├─ tests/pbap_session.rs`            | `PbapSession` against the fake obexd                                                   |
| `├─ tests/ancs_session.rs`            | `AncsSession` against the fake iPhone                                                  |
| `├─ src/redact.rs`                    | `Redacted` log wrappers for text, numbers, names and addresses; `TINCAN_LOG_SENSITIVE` |
| `├─ src/task.rs`                      | Spawns background tasks and turns a panic into a state change instead of silence       |
| `└─ tests/supervisor.rs`              | `MapSupervisor` and `watch_system` against the fake obexd and a fake system bus        |
| `crates/tincan-vault`                 | SQLCipher vault (`Vault`) and vault-key storage (Secret Service or a key file)         |
| `├─ src/secret_service.rs`            | Minimal Secret Service client on zbus 6 (`plain` session, unlock prompts)              |
| `├─ src/key.rs`                       | `VaultKey`, `load_or_create` key policy                                                |
| `├─ src/vault.rs`                     | `Vault`: open/verify key, `exec`, `query`, transactions                                |
| `├─ examples/vault_spike.rs`          | Live keyring + SQLCipher round trip with a throwaway id (no phone)                     |
| `└─ tests/secret_service.rs`          | Client and key policy against a fake keyring over a peer-to-peer connection            |
| `crates/tincan-napi`                  | Thin napi-rs bindings over `tincan-bt` and `tincan-vault` (`cdylib`)                   |
| `├─ src/lib.rs`                       | Parsers, `bluetoothSnapshot`, panic guard, error objects with `code`                   |
| `├─ src/bluetooth.rs`                 | `Bluetooth`: devices, pairing with a JS callback, `watchDevices`                       |
| `├─ src/map.rs`                       | `MapLink`: `MapSupervisor` + `watch_system`, events through a threadsafe function      |
| `├─ src/log.rs`                       | `setLogger`: a `tracing` subscriber that forwards native events to JS                  |
| `├─ src/notifier.rs`                  | `Notifier`: desktop notifications, clicks and closes through a callback                |
| `├─ src/pbap.rs`                      | `PbapSession`: one-shot phonebook pulls (contacts, favourites, call history)           |
| `├─ src/ancs.rs`                      | `AncsSession`: the phone's notification feed and actions through a callback            |
| `└─ src/vault.rs`                     | `Vault`: key lookup + SQLCipher open, synchronous statements and transactions          |
| `packages/native`                     | npm package `@beyland/tincan-native`: the generated loader, `.d.ts`, and node tests    |
| `fixtures/bmessage`, `fixtures/vcard` | Synthetic samples (fake names, 555 numbers), shared by Rust and node tests             |
| `fuzz/`                               | cargo-fuzz targets for the parsers (own workspace, not built by default)               |
| `deny.toml`                           | cargo-deny policy: advisories, licence allowlist, crates.io-only sources               |

The `bluez`, `map` and `system` modules keep D-Bus I/O in thin async functions and do all parsing in
pure functions (`snapshot_from_objects`, `listings_from_reply`, `SystemState::apply`, …). Unit tests
feed those pure functions synthetic data. The integration tests in `tests/` serve fakes over
peer-to-peer zbus connections, so no test needs a system or session bus, obexd or a phone.

## Building

```sh
pnpm build:native                     # release addon → packages/native/tincan-native.<triple>.node
pnpm --filter @beyland/tincan-native build:native:debug
pnpm --filter @beyland/tincan-native test  # node:test; skips when the addon isn't built
cargo test --workspace
cargo run -p tincan-bt --example probe  # read-only BlueZ snapshot as JSON
```

`napi build` regenerates `packages/native/index.js` (the ESM loader) and `index.d.ts`. Both are
committed, so TypeScript consumers type-check without Rust. The root `vite.config.ts` excludes them
from fmt and lint. `*.node` is gitignored. The napi targets are `x86_64-unknown-linux-gnu` and
`aarch64-unknown-linux-gnu`.

### Script naming

The package deliberately has **no plain `build` script**: its build is `build:native`, and the root
`pnpm build:native` filters to it.

The reason is that root `pnpm build` (`vp run -r build`) runs every package's `build`. Requiring
cargo there would break the TypeScript-only CI job and contributors without Rust. The CI native job
runs `pnpm build:native` and then `pnpm --filter @beyland/tincan-native test`.

`test` does run in `vp run -r test`, and it skips cleanly when the addon hasn't been built.

The daemon lists `@beyland/tincan-native` as an `optionalDependency` and loads it at runtime. If the
addon isn't built, `tincan status` shows `Native` as unavailable.

## Exported API

From the generated `index.d.ts` (the interface bodies are abbreviated):

```ts
export declare function nativeVersion(): string;
export declare function parseBMessage(text: string): ParsedBMessage;
export declare function parseVCards(text: string): Array<ParsedVCard>;
export declare function buildBMessage(recipients: Array<string>, body: string): string;
export declare function threadKeyFor(address: string): string;
export declare function bluetoothSnapshot(): Promise<BluetoothSnapshot>;

export declare class Bluetooth {
  static open(): Promise<Bluetooth>;
  adapter(): Promise<AdapterInfo | null>;
  devices(): Promise<Array<BtDevice>>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  pair(
    address: string,
    onRequest: (request: BtPairingRequest) => boolean | Promise<boolean>,
  ): Promise<void>;
  cancelPairing(address: string): Promise<void>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  forget(address: string): Promise<void>;
  watchDevices(onEvent: (arg: BtDeviceEvent) => void): Promise<DeviceWatch>;
}
export declare class DeviceWatch {
  close(): void;
}
type BtPairingRequest =
  | { kind: "confirm"; address: string; passkey: string } // six digits, zero-padded
  | { kind: "authorize"; address: string };
type BtDeviceEvent =
  | { kind: "deviceAdded"; device: BtDevice }
  | { kind: "deviceChanged"; device: BtDevice }
  | { kind: "deviceRemoved"; path: string; address: string }
  | { kind: "adapterChanged"; adapter: AdapterInfo }
  | { kind: "adapterRemoved"; path: string };

export declare class MapLink {
  static start(
    address: string,
    options: MapLinkOptions | undefined | null,
    onEvent: (arg: MapLinkEvent) => void,
  ): Promise<MapLink>;
  state(): MapLinkState;
  trigger(
    trigger:
      | "sleep"
      | "resume"
      | "adapterDown"
      | "adapterUp"
      | "deviceConnected"
      | "deviceDisconnected"
      | "reconnect",
  ): void;
  listMessages(
    folder: string,
    filter?: MapListFilter | undefined | null,
  ): Promise<Array<MapListing>>;
  getMessage(path: string): Promise<ParsedBMessage>;
  setRead(path: string, read: boolean): Promise<void>;
  pushMessage(
    recipients: Array<string>,
    body: string,
  ): Promise<"accepted" | "unconfirmed" | "pending">;
  shutdown(): Promise<void>;
}
interface MapLinkOptions {
  backoffMinMs?: number; // default 1000
  backoffMaxMs?: number; // default 300000
  openTimeoutMs?: number; // default 45000
  transferTimeoutMs?: number; // default 30000
}
type MapLinkEvent =
  | { kind: "state"; state: MapLinkState }
  | { kind: "openFailed"; attempt: number; code: string; message: string }
  | { kind: "map"; event: MapEvent }
  | { kind: "systemWatchFailed"; code: string; message: string };
type MapLinkState =
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; session: string }
  | { kind: "waiting"; attempt: number; delayMs: number }
  | { kind: "paused"; reason: "sleep" | "adapterDown" }
  | { kind: "stopped" };
type MapEvent =
  | { kind: "messageAdded"; handle: string; path: string; folder: string; type: string }
  | { kind: "statusChanged"; handle: string; path: string; status: string }
  | { kind: "folderChanged"; handle: string; path: string; folder: string }
  | { kind: "readChanged"; handle: string; path: string; read: boolean }
  | { kind: "messageRemoved"; handle: string; path: string }
  | { kind: "sessionClosed" };
interface MapListFilter {
  offset?: number;
  maxCount?: number;
  subjectLength?: number;
  periodBegin?: string;
  periodEnd?: string;
  read?: boolean;
  types?: Array<string>;
  fields?: Array<string>;
}
interface MapListing {
  handle: string;
  path: string;
  folder: string;
  subject: string;
  timestamp: number;
  sender: string;
  senderAddress: string;
  type: string;
  status: string;
  read: boolean;
  sent: boolean;
  // … replyTo, recipient, recipientAddress, size, attachmentSize, priority, protected
}

interface ParsedBMessage {
  valid: boolean;
  version: string;
  read: boolean;
  type: string;
  folder: string;
  originator: Party;
  recipients: Array<Party>;
  body: string;
  parts: Array<string>;
  charset: string;
  encoding: string;
  language: string;
  length?: number;
  threadKey: string;
}
export declare class Notifier {
  static open(
    onEvent: (event: NotifierEvent) => void,
    options?: NotifierOptions,
  ): Promise<Notifier>;
  capabilities(): Promise<Array<string>>; // "actions", "body-markup", "persistence", …
  notify(notification: DesktopNotification): Promise<number>; // the notification id
  dismiss(id: number): Promise<void>;
  close(): void;
}
interface NotifierOptions {
  appName?: string; // default "Tincan"
  desktopEntry?: string; // .desktop id without the suffix
}
interface DesktopNotification {
  title: string; // usually the sender; must not be empty
  body: string; // plain text
  threadKey: string; // carried back in events
  icon?: string; // icon name or file:// URI
  replaces?: number; // update a shown notification in place
}
export declare class PbapSession {
  static open(address: string, options?: { transferTimeoutMs?: number }): Promise<PbapSession>;
  get sessionPath(): string;
  get closed(): boolean;
  pullContacts(options?: PbapPullOptions): Promise<Array<ParsedVCard>>;
  pull(phonebook: Phonebook, options?: PbapPullOptions): Promise<Array<ParsedVCard>>;
  size(phonebook?: Phonebook): Promise<number>; // default 'pb'
  version(phonebook?: Phonebook): Promise<PhonebookVersion>;
  close(): Promise<void>;
}
type Phonebook = "pb" | "fav" | "ich" | "och" | "mch" | "cch"; // inlined in the .d.ts
interface PbapPullOptions {
  format?: "vcard21" | "vcard30"; // default "vcard30"
  offset?: number; // entries to skip
  maxCount?: number; // default all
  photos?: boolean; // default false
}
interface PhonebookVersion {
  folder?: string; // e.g. "/telecom/pb"
  databaseIdentifier?: string;
  primaryCounter?: string;
  secondaryCounter?: string;
}
export declare class AncsSession {
  static start(
    address: string,
    options: { content?: boolean; retryMs?: number; verifyMs?: number } | undefined | null,
    onEvent: (event: AncsSessionEvent) => void,
  ): Promise<AncsSession>;
  state(): AncsSessionState;
  recent(limit?: number): Promise<Array<AncsNotification>>; // default 50, newest first
  performAction(uid: number, action: "positive" | "negative"): Promise<void>;
  close(): Promise<void>;
}
type AncsSessionState =
  | { kind: "unavailable"; code: string; reason: string }
  | { kind: "waiting"; hint: string }
  | { kind: "ready" }
  | { kind: "closed" };
type AncsSessionEvent =
  | { kind: "state"; state: AncsSessionState }
  | { kind: "notification"; notification: AncsNotification } // added or changed (same uid)
  | { kind: "removed"; uid: number };
interface AncsNotification {
  uid: number;
  appId: string; // "com.apple.MobileSMS"
  appName: string; // "Messages"; derived from appId when the phone gives none
  title: string; // empty without `content`
  subtitle: string;
  body: string;
  category:
    | "other"
    | "incomingCall"
    | "missedCall"
    | "voicemail"
    | "social"
    | "schedule"
    | "email"
    | "news"
    | "healthAndFitness"
    | "businessAndFinance"
    | "location"
    | "entertainment";
  received: number; // Unix seconds
  silent: boolean;
  important: boolean;
  hasPositiveAction: boolean;
  hasNegativeAction: boolean;
  preExisting: boolean; // on the phone before this subscription
}
export declare function setLogger(
  onLog: ((record: LogRecord) => void) | null,
  level?: "error" | "warn" | "info" | "debug" | "trace", // default "info"
): void;
interface LogRecord {
  level: "error" | "warn" | "info" | "debug" | "trace";
  target: string; // Rust module path, e.g. "tincan_bt::supervisor"
  message: string;
  fields: Record<string, string>; // structured fields, already redacted
}
type NotifierEvent =
  | { kind: "action"; id: number; threadKey: string; action: string; activationToken?: string }
  | {
      kind: "closed";
      id: number;
      threadKey: string;
      reason: "expired" | "dismissed" | "closed" | "undefined";
    };

interface Party {
  name: string;
  tel: string;
  email: string;
}
interface ParsedVCard {
  version: string;
  name: string;
  family: string;
  given: string;
  tels: Array<TypedValue>;
  emails: Array<TypedValue>;
  photo?: Photo;
  callType: string;
  callTime: string;
  favorite: boolean;
}
interface BluetoothSnapshot {
  adapters: Array<AdapterInfo>;
  devices: Array<BtDevice>;
}
interface AdapterInfo {
  path: string;
  address: string;
  name: string;
  alias: string;
  powered: boolean;
  discoverable: boolean;
  pairable: boolean;
  discovering: boolean;
  class?: number;
}
interface BtDevice {
  path: string;
  adapter: string;
  address: string;
  name?: string;
  alias: string;
  icon?: string;
  class?: number;
  modalias?: string;
  paired: boolean;
  bonded: boolean;
  trusted: boolean;
  blocked: boolean;
  connected: boolean;
  uuids: Array<string>;
  isIphone: boolean;
  supportsMap: boolean;
  supportsPbap: boolean;
  supportsAncs: boolean;
}
export declare class Vault {
  static open(path: string, options?: { id?: string } | null): Promise<Vault>;
  static openInMemory(): Vault;
  get keyStorage(): "keyring" | "file" | "memory";
  get keyFile(): string | null;
  get path(): string | null;
  get isOpen(): boolean;
  get inTransaction(): boolean;
  cipherVersion(): string;
  exec(sql: string, params?: Array<SqlParam>): { changes: number; lastInsertRowid: number };
  execBatch(sql: string): void;
  query<T = Record<string, null | number | bigint | string | Buffer>>(
    sql: string,
    params?: Array<SqlParam>,
  ): Array<T>;
  transaction<T>(body: () => T): T;
  close(): void;
}
type SqlParam = null | undefined | number | bigint | boolean | string | Uint8Array; // inlined in the .d.ts
```

Notes on behaviour:

- `parseBMessage` never throws; check `valid`. `threadKey` is the originator's conversation key, or
  `""` when there's no originator (a sent message).
- `buildBMessage` writes recipient addresses as given. A recipient containing `@` is treated as an
  email address; anything else as a phone number. Use `threadKeyFor` for normalised keys
  (`tel:+15555550142`, `email:riley.sample@example.com`).
- `MapLink` wraps the [reconnect supervisor](#reconnect-supervisor) and `watch_system` for one phone.
  `start` connects the session and system buses (`NOT_CONNECTED` if either is missing) and returns
  at once; the first event is `connecting` attempt 1. Every `SupervisorEvent` reaches `onEvent` in
  order. If the system watcher fails (no BlueZ), `systemWatchFailed` is sent once and the link keeps
  running without sleep or adapter triggers.
- The operations use the session that is open at the time and reject `NOT_CONNECTED` when none is.
  They run one at a time, because obexd runs one transfer per session. An operation that fails with
  a lost session reports it to the supervisor, which reopens. Message `path`s belong to one
  session: re-list after every `connected`.
- `pushMessage` pushes to `outbox`. MAP gives no send or delivery report on an iPhone
  ([ADR 0006](decisions/0006-map-sync-model.md)), so `accepted` only means the transfer finished.
- The callback is a strong threadsafe function: Node stays alive until `shutdown()` (or the
  supervisor ending) releases it.
- String unions stand in for Rust enums (`'sleep' | 'adapterDown'`, the trigger names, the push
  outcome) because napi's `string_enum` emits `const enum`, which type stripping can't run.
- `Vault.open` finds the key as described in the [vault rules](#vault-rules): the
  `<database minus extension>.key` file if it exists, else the Secret Service, else a new key file
  (`keyStorage: 'file'`, which `doctor` should warn about). Opening runs off the JS thread; it
  rejects `NOT_FOUND` for an existing database without its key and `PERMISSION_DENIED` for a wrong
  key or a dismissed unlock prompt. `openInMemory` uses a random key and never touches the keyring.
- Statements are synchronous on the JS thread, like better-sqlite3. Integral numbers bind as
  INTEGER and others as REAL; booleans as 0/1; `Uint8Array`s as BLOB. INTEGERs come back as numbers,
  or bigints outside ±(2^53 − 1); BLOBs as `Buffer`s. A failed constraint throws `CONFLICT`; bad SQL
  or an unbindable parameter `INVALID_INPUT`; any call after `close()` `NOT_CONNECTED`.
- `transaction(body)` runs `BEGIN IMMEDIATE`, calls `body` and commits. If `body` throws, it rolls
  back and rethrows the same value. A `body` that returns a promise is rolled back with
  `INVALID_INPUT` (an `await` would let other statements into the transaction). Transactions don't
  nest.
- `Bluetooth.open` connects the system bus (`NOT_CONNECTED` without one). Device methods take a
  `XX:XX:XX:XX:XX:XX` address (`INVALID_INPUT` otherwise) and reject `NOT_FOUND` for a device BlueZ
  doesn't know. `connect` rejects `NOT_CONNECTED` for an unpaired or out-of-range device.
- `pair` registers a one-off `DisplayYesNo` agent, pairs, then trusts the device; an already
  paired device is only trusted. `onRequest` answers BlueZ's questions: only `true` (or a promise of
  `true`) accepts; `false`, a throw, a rejection or any other value declines, and `pair` rejects
  `PERMISSION_DENIED`. A second `pair` on the same `Bluetooth` rejects `BUSY`. `cancelPairing`
  makes the running `pair` reject `PERMISSION_DENIED`. When the pairing ends, an unanswered
  `onRequest` promise is abandoned and its callback released, so it can't keep Node running.
- `watchDevices` reports changes after it resolves, in the order BlueZ sent them (zbus queues each
  match rule separately; `system::Signals` re-orders them by arrival). Read the current state with
  `adapter()` and `devices()` afterwards. The callback keeps Node alive until `close()`.
- `Notifier.open` connects the session bus (`NOT_CONNECTED` without one) and keeps Node alive until
  `close()`. `notify` talks to `org.freedesktop.Notifications`: it rejects `NOT_CONNECTED` when no
  server runs or after `close()`, and `INVALID_INPUT` for an empty title. It adapts to the server's
  capabilities: the body is markup-escaped only for servers with `body-markup`, and the `default`
  ("Open") action is offered only with `actions`. Hints: `category` `im.received`, normal urgency,
  `desktop-entry` when set; the server's default timeout applies.
- `Notifier` reports events only for its own notifications, each with the `threadKey` it was shown
  with. A click gives `action` (with the XDG activation token when the server sends one, for
  focusing the window); a close gives `closed` and forgets the id. Signals that arrive before
  `notify` resolves are buffered and replayed. At most 256 shown notifications are tracked; the
  oldest are forgotten first.
- `setLogger` installs a global `tracing` subscriber on first use and points it at `onLog`; a later
  call replaces the callback and level, and `null` turns forwarding off. Tincan's own crates
  (`tincan_*` targets) log at `level`; dependencies (zbus, tokio) only at `warn` and above. Records
  are queued without blocking the Rust thread, and the callback doesn't keep Node alive. An unknown
  level throws `INVALID_INPUT`. Phase 3 routes the records into the daemon's logger.
- `PbapSession.open` connects the session bus and opens an obexd PBAP session, which selects the
  contacts. It isn't supervised: open, pull, `close()`. Each pull selects its phonebook first, and
  pulls on one session run one at a time. Pulls ask for `VERSION`, `FN`, `N`, `TEL`, `EMAIL` and
  `X-IRMC-CALL-DATETIME`, plus `PHOTO` with `photos: true`. Cards from `fav` come back with
  `favorite: true`; an empty phonebook is an empty array. Bad phonebook names, formats, or counts
  above 65535 reject `INVALID_INPUT`; a failed transfer `INTERNAL`; one past `transferTimeoutMs`
  (default 120 s) `TIMEOUT`. `version()` gives the PBAP 1.2 counters, which change when contacts
  do; each is absent if the phone doesn't report it.
- `AncsSession.start` connects the system bus (`NOT_CONNECTED` without one; `INVALID_INPUT` for a
  bad address or a zero interval) and returns at once in `unavailable`. It never pairs, advertises
  or opens the LE link: once BlueZ reports the phone connected with the ANCS service resolved, it
  subscribes to the Notification and Data Sources and probes the Control Point (an app-name request
  for Messages). The first answer makes it `ready`. A phone that rejects the write or stays silent
  leaves it `waiting` with the hint to turn on Share System Notifications; it re-probes every
  `retryMs` (5 s).
- Each notification's attributes (app id, title ≤ 128, subtitle, body ≤ 256, date) are fetched one
  Control Point request at a time and reassembled from fragmented Data Source packets; a request
  unanswered for 15 s is dropped. Each response must echo the request's command and uid (or app
  id); fragments that don't, such as the rest of a dropped answer, are discarded. A notification is held until its app's display name is known
  (one request per app; a nameless app gets a name derived from its bundle id). With
  `content: false` only the app id and date are requested. At most 64 requests queue; the
  pre-existing backlog stops being fetched once half of that is used.
- Notifications already on the phone at subscription come first, flagged `preExisting`; a
  modification re-sends the whole notification with the same `uid`. `recent` keeps the last 200.
  `received` is the phone's Date attribute read as local time (the arrival time if it has none), in
  Unix seconds.
- `performAction` rejects `NOT_CONNECTED` unless `ready`, `NOT_FOUND` for a uid this subscription
  didn't deliver, `INVALID_INPUT` for an action the notification doesn't offer, `BUSY` when the
  queue is full and `INTERNAL` when the phone refuses it.
- Link loss (the device disconnecting, BlueZ removing the service or ending notifications, or a
  write failing with `NOT_CONNECTED`) gives `unavailable` and a fresh subscription when the phone is
  back, after `retryMs`. Uids from the old subscription are forgotten. Every `verifyMs` (30 s) while
  `ready` it checks that both sources still notify and reads the phone's GAP name, to catch a link
  that died silently.
- `close()` stops notifying on both sources, ends with a `closed` event and releases the callback,
  which keeps Node alive until then.

## Reconnect supervisor

`MapSupervisor::start(session_bus, SupervisorConfig::new(address))` owns the MAP session for one
phone and returns a channel of `SupervisorEvent`s:

- `State(LinkState)` on every change: `Connecting { attempt }`, `Connected { session }`,
  `Waiting { attempt, delay }`, `Paused(Sleep | AdapterDown)`, `Stopped`.
- `OpenFailed { attempt, error }` before each `Waiting`.
- `Map(MapEvent)` for the open session. Events are subscribed before `Connected` is announced.

`session()` returns the open `Arc<MapSession>` (or `None`) for listing, downloading and pushing.
Consumers re-list after every `Connected`, since reports can be missed while the link is down.

Behaviour:

- **Backoff:** 1 s doubling to 300 s, no jitter. Reset by a successful open and by any trigger
  that asks to connect now (`Resume`, `Reconnect`, `AdapterUp`, `DeviceConnected`), which also ends
  a wait early. Each open is bounded by `open_timeout` (45 s). Triggers that arrive during an open
  are handled after it.
- **Loss:** detected when obexd removes the session (`MapEvent::SessionClosed`), when the event
  stream ends, or when a consumer reports `Trigger::SessionLost(path)` after a call failed with
  `map::is_session_lost`. A `SessionLost` for any path but the current session's is ignored.
  `DeviceDisconnected` is informational: BlueZ's `Connected` flag can lag a fresh session.
- **Pauses:** `Sleep` and `AdapterDown` close the session and wait without retrying. A missing
  adapter outranks resume. `DeviceConnected` doesn't end a pause.
- `shutdown()` closes the session and ends with `Stopped`; dropping the supervisor aborts it.

`watch_system(system_bus, address, supervisor.trigger_sender())` feeds those triggers. It
subscribes to logind `PrepareForSleep`, BlueZ `InterfacesAdded`/`Removed`, and `PropertiesChanged`
for `Adapter1` and `Device1`, then reads `GetManagedObjects` (sending `AdapterDown` if no adapter is
powered). `AdapterDown`/`AdapterUp` fire only when "any adapter powered" flips. The phone's
`Connected` property gives `DeviceConnected`/`DeviceDisconnected`. It returns when the supervisor
stops. It holds no logind inhibitor: an open session is closed after `PrepareForSleep(true)`
arrives, and a session cut by suspend is reopened on resume either way.

`MapEvents` merges its two match-rule streams by D-Bus serial. zbus queues each rule separately,
so a plain merge could hand out a new message's `Status` change before its `InterfacesAdded`.

## Error mapping

Every export runs inside `catch_unwind`, so no panic reaches JS. Failures throw (or reject) a JS
`Error` whose `code` is a `tincan-bt` `ErrorCode` string:

| `code`              | When                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NOT_CONNECTED`     | Bus unreachable; `ServiceUnknown`/`NameHasNoOwner` (BlueZ or obexd absent); `NotConnected`/`NotReady`, host down, page timeout |
| `BUSY`              | `InProgress`, `Busy`, `AlreadyExists`, connection refused                                                                      |
| `PERMISSION_DENIED` | `NotAuthorized`, `AccessDenied`, `NotPermitted`, rejected or cancelled authentication, OBEX Forbidden (`0x43`)                 |
| `TIMEOUT`           | `NoReply`, `TimedOut`, or any timeout                                                                                          |
| `NOT_FOUND`         | `UnknownObject`/`Method`/`Interface`/`Property`, `DoesNotExist`, missing SDP record                                            |
| `INVALID_INPUT`     | `InvalidArgs`/`InvalidArguments`, or bad arguments (empty/invalid recipient, address, folder)                                  |
| `INTERNAL`          | Anything unclassified, including a Rust panic (`"native code panicked"`)                                                       |

`classify_dbus_error` maps D-Bus error names, with the description as a fallback, onto these codes.

## Safety rules

- **Tests never touch a real phone.** `MapSession` and `MapSupervisor` are tested against the fake
  obexd in `tests/support`. Only the `map_spike` example talks to a phone, and only when someone runs
  it by hand (see the [MAP findings](history/native-phase-0.md#map-phase-01-2026-10-31)).
- The `probe` example and `bluetoothSnapshot` make exactly one read-only call: `GetManagedObjects` on
  `org.bluez`. They never pair, connect, disconnect, or change properties.
- `Bluetooth`'s pairing, discovery and connection calls change real state, so they're tested only
  against the fake BlueZ: in Rust over peer-to-peer connections, and in node through the
  `fake_bluez` example on a private `dbus-daemon` that both buses of the test child point at. The
  example refuses to start on the real system bus.
- `AncsSession` is tested against the fake iPhone only: in Rust over peer-to-peer connections, and
  in node through the `fake_ancs` example, which refuses the real system bus. A live run is manual and
  prints counts and categories, never content.
- `Notifier` is tested against the fake notification server only, so tests never pop up real
  notifications. The `fake_notifications` example refuses a bus under `/run/user/` and a bus where
  `org.freedesktop.Notifications` already has an owner.
- **Logs never carry message text, phone numbers, names or full addresses.** Log ids, counts and
  codes; wrap anything else in `tincan_bt::redact` (`text`, `phone`, `name`, `address`), which prints
  `[text: N chars]`, `[phone]`, `[name]` and `…:EE:FF` unless `TINCAN_LOG_SENSITIVE=1` is set for a
  local debugging session. Error messages follow the same rule.
- Error messages built from D-Bus replies go through `redact::scrub`, which masks `dev_AA_…` object
  paths and MAC addresses; forwarded third-party log records are scrubbed the same way.
- Library code has no `unwrap`/`expect`. The release profile keeps unwinding, so `catch_unwind`
  works; don't set `panic = "abort"`. Background tasks are spawned through `task.rs`: a panic in
  the ANCS session becomes `Unavailable` then `Closed`, and in the MAP supervisor it closes the
  session and reports `Stopped`. Panic payloads are never logged.
- **Untrusted input is bounded.** bMessage bodies are parsed in linear time (a message of 200k
  newlines is cheap), an `END:MSG` inside a body only ends it where the structure says so, and
  vCards inside a body are never read as recipients. Downloads are capped (16 MiB per message, 64 MiB
  with attachments, 64 MiB per phonebook pull). vCards keep raw bytes until each property's
  `CHARSET` is applied (`parse_vcards_bytes`). obexd's reply `Filename` is only accepted if it is
  the path Tincan reserved.
- **Only bonded phones.** MAP, PBAP and ANCS refuse (`PERMISSION_DENIED`) a device BlueZ doesn't
  report as Paired and Bonded. The pairing agent answers only the bus name that owned `org.bluez`
  when it registered, and declines "Just Works" authorization requests (in core).
- Local time for MAP timestamps uses `localtime_r` after a single `tzset()` at addon load, never
  `mktime` from worker threads.
- Fuzz the parsers with `cargo +nightly fuzz run <target>` from `fuzz/`; MSRV is Rust 1.89.

## Vault rules

- The key is 32 random bytes (`getrandom`). It is used as a raw SQLCipher key (`x'…'`), so there is
  no PBKDF2 cost at open. It is stored in the keyring as 64 hex characters (`text/plain`) under
  `xdg:schema=dev.beyland.Tincan.VaultKey`, `vault=<id>`.
- An existing key file wins. It is opened without following symlinks and must be a regular file
  owned by you with no group/other permissions; anything else is refused (not silently fixed).
- A new key file is written to a `0600` temp file, fsynced, then hard-linked into place, so a crash
  never leaves a half-written key. An empty key file is replaced only when no database exists yet;
  otherwise Tincan stops with recovery advice.
- If there is no Secret Service, or no default collection, the key goes to a 0600 file next to the
  database.
- A new key is only generated when the database doesn't exist. A vault whose key is missing fails with
  `NOT_FOUND` rather than being silently replaced.
- A dismissed unlock prompt fails with `PERMISSION_DENIED`, and nothing falls back to a file.
- SQLCipher's own stderr logging is turned off (`cipher_log_level = NONE`); errors come back as codes.
- The database is opened without URI parsing, and the `PRAGMA key` string lives in one zeroized
  buffer. `cipher_memory_security` stays off (3.6× slower writes; SQLCipher already keeps key
  material in its own wiped allocations).

## Hardware findings

The first hardware runs against a real iPhone (MAP, PBAP, ANCS, the vault, the addon in Electron and the
device class) are written up in [history/native-phase-0.md](history/native-phase-0.md). In short: iOS
lists only the 10 newest inbox messages over MAP, sends no read, sending or delivery reports, keeps
`sent` empty, and offers message and contact sharing only to a hands-free Class of Device.

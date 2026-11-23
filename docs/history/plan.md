> **Historical document.** This is Tincan's original design and build plan, kept for context. It is not
> kept up to date; see [architecture.md](../architecture.md) for how Tincan works today and
> [roadmap.md](../roadmap.md) for what's next.

# Tincan — build plan

> iMessage and SMS from your iPhone on your Linux laptop, over Bluetooth. No Mac, no jailbreak, no app on the iPhone.
> `tincan.beyland.dev` · `github.com/beyland-dev/tincan` · npm `@beyland/tincan-*` · CLI `tincan`.

Tincan is a standalone Linux messaging client for iPhone over Bluetooth (BlueZ MAP + PBAP + ANCS),
leaving out everything else (iOS companion app, file transfer, clipboard, calls, camera, AirPods).
Its Bluetooth protocol research was informed by [Tether](https://github.com/zackb/tether) (MIT) as
reference material.

---

## 1. Goals and non-goals

**Goals**

1. A daily-driver messaging client on Linux for one iPhone: read, reply, start new conversations, get notifications.
2. **Agent-drivable by design.** Every action is a typed command. The desktop UI, CLI, and MCP server are thin
   adapters over the same command list. Anything a person can do in the app, an agent can do through MCP or the CLI,
   within the user's policy.
3. Keeps working when the app window is closed (the daemon runs as a systemd user service).
4. Private by default: stored messages are encrypted, message text never goes in logs, and agents need explicit permission.
5. Easy to set up: a guided first-run that checks and fixes the Bluetooth setup.

**Non-goals (v1)**

- An iOS app or any Wi-Fi/LAN features. File transfer is out of scope (you use LocalSend).
- Calls, audio, AirPods, clipboard.
- Supporting several phones at once (the data model allows it later).
- macOS or Windows. Tincan is Linux-only (BlueZ).
- Flatpak or Snap. Bluetooth needs system setup that sandboxed packages can't do cleanly. Revisit after 1.0.

---

## 2. What works and what doesn't (vs. Messages on macOS)

**Supported**

| Feature                                                           | How                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Incoming iMessage and SMS (text)                                  | MAP new-message events + fetch                                                                            |
| Message history from the phone's inbox                            | MAP folder listing on first sync (iOS lists only the 10 newest), then kept locally                        |
| Sending text replies and new messages                             | MAP `PushMessage`                                                                                         |
| Contact names and photos                                          | PBAP phonebook pull                                                                                       |
| Unread/read state, marking read on the phone                      | MAP `Read` flag, re-listed (iOS sends no read events) and `SetMessageRead`                                |
| Desktop notifications, click to open the conversation             | Daemon → freedesktop Notifications                                                                        |
| Search                                                            | SQLite FTS5 in the local store                                                                            |
| Send status (pending → sent / failed + retry)                     | Local outbox + watchdog                                                                                   |
| Group chats (by hand)                                             | Group texts arrive in the sender's thread; move them into a group from the message's hover button or menu |
| Works with the iPhone locked and the app closed                   | Bluetooth profiles don't need the iPhone app                                                              |
| Reconnects after the laptop sleeps or the phone goes out of range | Reconnect supervisor in the native layer                                                                  |

**Not supported (Bluetooth MAP and ANCS can't provide these)**

- Attachments: photos, videos, voice notes, files (you'll see a placeholder at most)
- Tapbacks/reactions (they arrive as flattened text like `Loved "…"`; Tincan can hide them or show them as small notes)
- Threaded replies, editing, unsending, message effects, stickers, Memoji, Genmoji
- Typing indicators, delivered/read receipts
- Messages you sent from the iPhone itself (MAP's sent folder is empty; only messages sent _from Tincan_ appear as yours)
- Full iCloud history (iOS exposes only the 10 most recent inbox messages over MAP)
- Blue vs. green bubbles (iMessage and SMS look the same over MAP)
- Reliable group info: no group IDs, no member lists, no group names from the phone, no adding or removing people
- Working without the phone nearby and connected
- Creating group chats or sending to a group as a real group (sending goes to one person)
- Polls, Apple Pay, app extensions, SharePlay, location sharing, Check In

The opt-in [iPhone backup sync](#after-10-backlog) in the backlog could fill in attachments, messages sent from the
phone, full history and real group info, though not live.

---

## 3. Architecture

```
            ┌────────────────────────────── tincan daemon (systemd --user) ──────────────────────────────┐
            │                                                                                          │
            │   @beyland/tincan-core  (TypeScript)                                                       │
            │     CommandRegistry · handlers · sync engine · thread keying · groups                    │
            │     outbox + send watchdog · contacts merge · agent policy + approvals · event bus       │
            │     store schema, migrations, queries (SQL in TS)                                        │
            │                         │                                                                │
            │                         ▼ napi-rs (generated .d.ts)                                       │
            │   @beyland/tincan-native  (Rust)                                                           │
            │     bluez: adapter, pairing agent, connect, reconnect supervisor   (zbus, system bus)    │
            │     obex:  MAP session + MNS events, PBAP pull                     (zbus, session bus)   │
            │     ancs:  GATT notification source/data source                    (zbus, system bus)    │
            │     parse: bMessage, vCard 2.1/3.0                                                       │
            │     vault: encrypted SQLite (rusqlite + SQLCipher), key in Secret Service                │
            │     notify: freedesktop Notifications (actions → open thread)                            │
            │                                                                                          │
            │   Unix socket server  $XDG_RUNTIME_DIR/tincan/tincan.sock  (dir 0700, socket 0600)           │
            └──────────────▲─────────────────────────▲──────────────────────────▲──────────────────────┘
                           │ NDJSON envelope         │                          │
               ┌───────────┴─────────┐   ┌───────────┴──────────┐   ┌───────────┴──────────┐
               │ apps/desktop        │   │ @beyland/tincan (CLI)  │   │ @beyland/tincan-mcp    │
               │ Electron main ──────┤   │ `tincan …` generated   │   │ `tincan mcp` (stdio)   │
               │  preload bridge     │   │ from contracts       │   │ tools from contracts │
               │ Preact renderer     │   └──────────────────────┘   └──────────────────────┘
               └─────────────────────┘
                       all three use @beyland/tincan-client + @beyland/tincan-protocol
```

### Key decisions

| Decision                 | Choice                                                                                                            | Why                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Language                 | TypeScript everywhere, plus **one Rust addon (napi-rs) from day one**                                             | One main language for agents to work in. Rust only where Node is weak (D-Bus, SQLCipher).                  |
| What goes in Rust        | Bluetooth (BlueZ, OBEX, ANCS), parsing Bluetooth data formats, encrypted SQLite connection, desktop notifications | All of it is D-Bus or native code. Everything else stays in TypeScript.                                    |
| Who owns state           | A separate daemon (systemd user service)                                                                          | Has to receive messages and show notifications while the window is closed. The CLI and MCP talk to it too. |
| How clients talk to it   | NDJSON over a Unix socket                                                                                         | Simple, local-only, protected by file permissions, no network port to defend.                              |
| Where the API is defined | `packages/protocol`: zod **input and output** schemas plus metadata, kept separate from the handlers              | The renderer, CLI, and MCP get full types without loading native code. JSON Schema is generated from it.   |
| Storage                  | SQLite (SQLCipher) through Rust; schema and queries in TypeScript                                                 | Encrypted at rest; domain logic stays in one language.                                                     |
| UI stack                 | Preact + @preact/signals + preact-iso, Electron, TypeScript, Vite+                                                | Lightweight reactive UI with fast builds.                                                                  |
| Tooling                  | pnpm workspace + `vp` (check/test/pack/build/run), Cargo workspace, `@napi-rs/cli`                                | Unified TypeScript tooling plus Rust.                                                                      |

### Command-driven architecture patterns

- `defineCommand({ name, title, description, kind, input, handler, format?, positional?, internal? })`
  → a registry that generates the CLI, the MCP server, and the API the UI uses.
- `kind: "query" | "mutation"` becomes the MCP `readOnlyHint`, and a destructive list becomes `destructiveHint`.
- Shared error codes and a `CoreError` class; input checked by zod in `registry.run` so every surface validates the same way.
- Coarse events (`thread.changed`, `message.changed`, …); the UI refetches when they arrive.
- `tincan commands` lists every command with its schema; `tincan mcp-config [client] --install`; an `AGENTS.md` guide served as the `tincan://guide` MCP resource.
- TypeScript limited to syntax Node can run directly (`erasableSyntaxOnly`); packages run as `.ts` source during development; `vp pack` builds `dist/` for publishing.
- electron-builder AppImage + .deb, a GitHub Actions desktop-build workflow, and an "Install `tincan` in PATH" command.

**Additional contract features**

- Output schemas on every command (typed results everywhere, MCP `outputSchema`).
- Contracts in a package of their own, so clients never load core or native code.
- Extra metadata on each command: `sensitive` (returns message text or contacts) and `approval` (`none | agent`).
- Long-lived daemon + Unix socket instead of an HTTP server inside the app.

---

## 4. Repository layout

```
tincan/
├─ apps/
│  └─ desktop/                     @beyland/tincan-desktop
│     ├─ src/main/                 Electron main: window, tray, single instance, daemon bootstrap, IPC → socket
│     ├─ src/preload/              contextBridge: window.tincan.{run, subscribe, platform}
│     ├─ src/renderer/             Preact app (views, components, store, styles)
│     ├─ resources/                blue default app icon and nightly icon variant
│     └─ vite.config.ts
├─ packages/
│  ├─ protocol/                    @beyland/tincan-protocol — entities, envelope, events, command contracts (zod), JSON Schema export
│  ├─ core/                        @beyland/tincan-core — registry, handlers, sync, store, groups, policy
│  ├─ daemon/                      @beyland/tincan-daemon — socket server, lifecycle, wiring, service install
│  ├─ client/                      @beyland/tincan-client — typed socket client + event subscription + reconnect
│  ├─ mcp/                         @beyland/tincan-mcp — MCP server built from contracts, approval handling
│  ├─ cli/                         @beyland/tincan — `tincan` binary
│  ├─ native/                      @beyland/tincan-native — JS wrapper + generated .d.ts for the Rust addon
│  └─ fake-phone/                  @beyland/tincan-fake-phone — scripted phone that stands in for the native addon
├─ crates/
│  ├─ tincan-bt/                     pure Rust library: bluez/obex/ancs/parsers (testable without napi)
│  ├─ tincan-vault/                  SQLCipher + Secret Service key handling
│  └─ tincan-napi/                   napi-rs bindings over tincan-bt + tincan-vault (+ notifications)
├─ packaging/
│  ├─ systemd/tincan.service         user unit
│  └─ system-setup/                privileged setup script (bluetoothd --experimental drop-in, device class), with uninstall
├─ fixtures/                       bMessage, vCard, ANCS samples, fake-phone scenarios
├─ docs/                           architecture.md, protocol.md, bluetooth.md, security.md, troubleshooting.md
├─ AGENTS.md                       conventions for coding agents (and the runtime `tincan://guide`)
├─ Cargo.toml                      Cargo workspace
├─ package.json / pnpm-workspace.yaml / vite.config.ts / tsconfig.base.json
├─ LICENSE (MIT) / NOTICE (third-party attribution)
└─ .github/workflows/              ci.yml (vp check, vp test, cargo fmt/clippy/test, napi build), release.yml
```

---

## 5. Component specs

### 5.1 `@beyland/tincan-protocol`

- **Entities (zod):** `Device`, `Handle` (`tel:+15551234567` | `email:a@b.c`), `Contact`, `Thread`
  (`key`, `kind: direct|group`, `title`, `members`, `lastMessage`, `unread`, `muted`), `Message` (`id`,
  `threadKey`, `direction`, `sender`, `body`, `sentAt`, `receivedAt`, `source: map|ancs|local`, `status`,
  `read`, `mapHandle?`, `reaction?`, `attachmentHint?`), `GroupRoster`, `Draft`, `Approval`, `Settings`, `DoctorReport`.
- **`attachmentHint`** (`{ count?: number, kinds?: ("image"|"video"|"audio"|"file")[] }`) records that a message had
  attachments Tincan can't show. It's best effort: filled from the ANCS notification text (e.g. "Attachment: 1 Image") or
  a placeholder in the MAP body, whichever iOS provides (to verify on hardware). The attachment itself is never available.
- **Thread keys:** `tel:…`, `email:…`, `sender:<id>` (alphanumeric SMS senders, read-only),
  `group:name:<slug>`, `group:members:<sorted-slugs>`.
- **Envelope (JSON-RPC-like, one JSON object per line):**
  - request `{ "id": 1, "method": "thread.list", "params": {…}, "client": { "kind": "desktop|cli|mcp", "name": "…" } }`
  - response `{ "id": 1, "result": … }` or `{ "id": 1, "error": { "code": "NOT_FOUND", "message": "…", "details": … } }`
  - event `{ "event": "message.changed", "seq": 42, "data": {…} }` (after `events.subscribe`)
  - a `hello` handshake with protocol version and server capabilities.
- **Command contract:** `{ name, title, description, kind, input, output, positional?, internal?, sensitive?, approval?, destructive? }`.
- **Error codes:** `NOT_FOUND`, `INVALID_INPUT`, `CONFLICT`, `NOT_CONNECTED`, `BUSY` (another computer holds the
  MAP session), `PERMISSION_DENIED` (iOS toggle off), `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `TIMEOUT`, `INTERNAL`.
- `pnpm gen:schema` writes `schema/tincan.schema.json` for agents and tools outside the monorepo.

### 5.2 Command catalogue (v1)

| Group    | Commands                                                                                                                         | Kind / flags                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| system   | `status`, `doctor`, `version`, `commands`, `events.subscribe`                                                                    | query                                                                       |
| service  | `service.status`, `service.install`, `service.disable`                                                                           | internal (the desktop's Background card; the CLI has `tincan service`)      |
| device   | `device.info`, `device.list`, `device.pair.start`, `device.pair.confirm`, `device.connect`, `device.disconnect`, `device.forget` | `info`/`list` query; others mutation; `forget` destructive                  |
| device   | `device.pair.status`, `device.pair.cancel`, `device.history`                                                                     | `pair.status`/`history` query; `pair.cancel` mutation                       |
| sync     | `sync.status`, `sync.now`                                                                                                        | query / mutation                                                            |
| thread   | `thread.list`, `thread.get`, `thread.markRead`, `thread.hide`, `thread.mute`, `thread.pin`                                       | query / mutation; `list`/`get` sensitive                                    |
| message  | `message.list`, `message.search`, `message.send`, `message.retry`, `message.draft.save`                                          | `list`/`search` sensitive; `send`/`retry` approval:agent                    |
| contact  | `contact.list`, `contact.search`, `contact.get`, `contact.sync`                                                                  | sensitive (except `sync`)                                                   |
| group    | `group.list`, `group.save`, `group.delete`, `group.assignMessage`                                                                | `list` sensitive query; `delete` destructive                                |
| approval | `approval.list`, `approval.resolve`                                                                                              | `resolve` internal (only the desktop app or an interactive CLI can call it) |
| settings | `settings.get`, `settings.set`                                                                                                   | mutation                                                                    |

**Events:** `device.changed`, `pairing.changed`, `sync.changed`, `thread.changed`, `message.changed` (`{threadKey, ids}`),
`message.sendStatus`, `contact.changed`, `approval.requested`, `approval.resolved`.

### 5.3 `@beyland/tincan-native` (Rust, napi-rs)

The TypeScript side sees this API (napi-rs generates the `.d.ts`):

```ts
// Built (../native.md#exported-api).
class Bluetooth {
  static open(): Promise<Bluetooth>;
  adapter(): Promise<AdapterInfo | null>; // powered, address, class, discovering
  devices(): Promise<BtDevice[]>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  pair(
    address: string,
    onRequest: (r: BtPairingRequest) => boolean | Promise<boolean>,
  ): Promise<void>;
  cancelPairing(address: string): Promise<void>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  forget(address: string): Promise<void>;
  watchDevices(onEvent: (e: BtDeviceEvent) => void): Promise<DeviceWatch>; // close() to stop
}
// Built: the supervised MAP link (../native.md#exported-api). It reopens the session across link loss,
// sleep and adapter changes, and the methods use whichever session is open.
class MapLink {
  static start(
    address: string,
    options: MapLinkOptions | null, // backoff and timeouts
    onEvent: (e: MapLinkEvent) => void, // state changes, open failures, MAP events (MNS)
  ): Promise<MapLink>;
  state(): MapLinkState; // connecting | connected | waiting | paused | stopped
  trigger(
    t:
      | "sleep"
      | "resume"
      | "reconnect"
      | "adapterDown"
      | "adapterUp"
      | "deviceConnected"
      | "deviceDisconnected",
  ): void;
  listMessages(folder: string, filter?: MapListFilter): Promise<MapListing[]>;
  getMessage(path: string): Promise<ParsedBMessage>;
  pushMessage(recipients: string[], body: string): Promise<"accepted" | "unconfirmed" | "pending">;
  setRead(path: string, read: boolean): Promise<void>;
  shutdown(): Promise<void>;
}
// Built: one-shot phonebook access; open, pull, close.
class PbapSession {
  static open(address: string, options?: { transferTimeoutMs?: number }): Promise<PbapSession>;
  pullContacts(options?: PbapPullOptions): Promise<ParsedVCard[]>; // format, offset, maxCount, photos
  pull(phonebook: "pb" | "fav" | "ich" | "och" | "mch" | "cch", options?): Promise<ParsedVCard[]>;
  size(phonebook?): Promise<number>;
  version(phonebook?): Promise<PhonebookVersion>; // PBAP 1.2 change counters
  close(): Promise<void>;
}
// Built: the phone's notification feed over the LE link BlueZ holds; resubscribes after link loss.
class AncsSession {
  static start(
    address: string,
    options: { content?: boolean; retryMs?: number; verifyMs?: number } | null,
    onEvent: (e: AncsSessionEvent) => void, // state changes, notifications (upserts by uid), removals
  ): Promise<AncsSession>;
  state(): AncsSessionState; // unavailable | waiting (sharing off) | ready | closed
  recent(limit?: number): Promise<AncsNotification[]>; // app, category, title, body, flags
  performAction(uid: number, action: "positive" | "negative"): Promise<void>;
  close(): Promise<void>;
}
class Vault {
  static open(path: string, options?: { id?: string }): Promise<Vault>;
  static openInMemory(): Vault; // tests
  readonly keyStorage: "keyring" | "file" | "memory";
  exec(sql, params?): { changes; lastInsertRowid };
  execBatch(sql): void;
  query<T>(sql, params?): T[];
  transaction<T>(body: () => T): T; // synchronous body
  close(): void;
}
class Notifier {
  static open(
    onEvent: (e: NotifierEvent) => void, // clicks (with threadKey, activation token) and closes
    options?: { appName?: string; desktopEntry?: string },
  ): Promise<Notifier>;
  notify(n: {
    title: string;
    body: string;
    threadKey: string;
    icon?: string;
    replaces?: number;
  }): Promise<number>;
  dismiss(id: number): Promise<void>;
  capabilities(): Promise<string[]>;
  close(): void;
}
function setLogger(onLog: ((r: LogRecord) => void) | null, level?: LogLevel): void; // tracing → JS
```

Rules for the Rust side:

- tokio runtime inside napi-rs; events go to JS through `ThreadsafeFunction`.
- **No panic may reach JS.** Every exported function catches panics and returns a typed error with a code.
- A reconnect supervisor in Rust: backoff, react to sleep/resume (logind `PrepareForSleep`), adapter removed or added, phone out of range. Done as `MapSupervisor` + `watch_system` ([native.md](../native.md#reconnect-supervisor)).
- Write the logic in `tincan-bt` with mockable D-Bus traits; keep `tincan-napi` a thin binding layer.
- Logs via `tracing`. Message text, phone numbers, names and addresses are redacted (`tincan_bt::redact`) unless `TINCAN_LOG_SENSITIVE=1`; `setLogger` forwards the events to the daemon's logger.
- The vault key is created once and stored in Secret Service through a small zbus 6 client in `tincan-vault`
  (`oo7` and `secret-service` pull in zbus 5). If there's no keyring, fall back to a 0600 key file and warn in
  `doctor`. A key is only generated for a database that doesn't exist yet.
- Builds Linux x64 and arm64 (gnu). Published as per-architecture npm packages through napi-rs optional dependencies.

### 5.4 `@beyland/tincan-core`

- **Registry** bound to contracts from `protocol`: `registry.implement(contract, handler)`.
- **Store** (SQL in TypeScript over `Vault`): `messages`, `threads`, `contacts`, `handles`, `groups`, `drafts`,
  `outbox`, `approvals`, `settings`, `sync_state`, `messages_fts` (FTS5). Numbered migrations with tests.
- **Sync-ready from day one** ([ADR 0007](../decisions/0007-sync-ready-store.md)), though nothing syncs yet: stable
  message ids that two computers assign the same way, `origin` and hybrid-logical-clock `updated_at` on syncable
  rows (last writer wins for read, mute, group edits), a per-row change sequence, tombstones (`deleted_at`) instead
  of deletes, and attachments stored by SHA-256. Drafts, outbox, approvals, settings, sync state, gaps and
  "notified" stay local to each computer. In the store: a MAP or ANCS message's id is a hash of the phone, thread,
  direction, phone time (to the second), body and an occurrence index for identical texts in the same second; one
  sent from Tincan gets a UUIDv7. A local `unnotified` table holds only live arrivals, so anything else counts as
  notified. Deleting a message also blanks its body. Merges are last-writer-wins per row for now.
- **Sync engine:** first sync (backfill, newest first; iOS lists at most 10), incremental sync from MAP
  `notification` events, a full pass after every reconnect and a periodic re-list for read changes made on the
  phone, dedupe by `(mapHandle, device)` with a content-hash fallback ([ADR 0006](../decisions/0006-map-sync-model.md)).
- **Gap detection:** after a reconnect, if none of the listed inbox messages overlap with what the store already has,
  messages may have been missed. Record a `gap` (thread, from the last message Tincan saw to the oldest one listed) and
  emit `thread.changed`. Messages that arrive in a catch-up pass are stored as already notified: they never raise
  desktop notifications, only messages that arrive live do.
  _Done (`core/src/sync.ts`):_ `SyncEngine` runs every pass through one queue and emits `sync.changed`
  (link state, then `syncing`), `message.changed` per thread and `thread.changed`. Read state merges against the
  previous listing kept in `sync_state`, so only changes made on the phone win and a read in Tincan not yet mirrored
  isn't undone; `markReadOnPhone` mirrors reads using the current session's paths. A gap is recorded for every thread
  (`thread_key` null) when a reconnect lists a full window with no overlap. Handles Tincan deleted are never refetched.
  The re-list interval is an engine option (default 60 s) until settings carry it.
- **ANCS notifications:** show the Share System Notifications hint only after 2–3 s in `waiting` (every start passes
  through it briefly). Don't raise desktop notifications for `preExisting` items or ones whose `received` is more than
  about 2 minutes old: iOS re-posts old notifications (e.g. grouped missed calls) as new after a reconnect.
- **Thread keying:** phone numbers normalized with `libphonenumber-js` (default region from settings), email lowercased.
  _Done (`core/src/keys.ts`):_ numbers become E.164; short codes (≤ 6 digits) and numbers libphonenumber can't place
  keep their digits. Alphanumeric senders are `sender:<lowercase id>` and can't be replied to. The Bluetooth layer keeps
  numbers as the phone sent them, so core re-keys them with `normalizeThreadKey` before they reach the store. Group
  keys use slugs (lowercase, whitespace runs to `-`, members sorted and joined with `+`).
- **Phone port:** core talks to the phone only through `PhonePort` (`core/src/phone.ts`), structural copies of the
  native module's types. The daemon checks the real addon against it at compile time (`satisfies PhonePort`), so
  core never imports `native`. _Done:_ `@beyland/tincan-fake-phone` implements it with iOS's quirks (10-message inbox
  window, no read events, session-scoped paths, own-number echo, ANCS backlog replayed as `preExisting`) plus
  scriptable failures, and loads JSON scenarios from `fixtures/scenarios/`.
- **Contacts:** merge PBAP data into handles; photos cached as files next to the store. _Done:_ `ContactSync`
  (`core/src/contacts.ts`) mirrors `pb` on connect (at most hourly) or on demand, skipping the pull when the phonebook
  version is unchanged and less than a day old. Contact ids hash the card's name and raw addresses, so every computer
  agrees; an edited card is a new contact and the old one is tombstoned. Entry 0 (the owner card) gives Tincan your own
  numbers, `fav` marks favourites, and a second pull with photos stores each one once as `<sha256>.<ext>` (0600) and
  removes files no contact uses. A failed photo pass keeps the contacts and retries next time.
- **Outbox:** a local `pending` record, MAP push, then a watchdog (sent, failed, or unknown after a timeout) and retry. iOS sends no
  sending or delivery reports, so "sent" means the phone accepted the push. Messages sent from Tincan show as yours. _Done:_ `Outbox`
  (`core/src/outbox.ts`): a failed push is `failed` with its error code; an `unconfirmed` or `pending` outcome, a
  `TIMEOUT`, a 45-second watchdog or a restart mid-push is `unknown` (a late answer still settles it). Messages wait up
  to 5 minutes for the phone and go out in order when it connects, then fail with `NOT_CONNECTED`. `retry` takes
  `failed` and `unknown` messages. Sending takes a thread key; resolving names and raw numbers belongs to the commands.
- **Groups (by hand):** the iPhone gives a group text one sender over MAP and no group over ANCS (no subtitle in
  practice), so every group text lands in its sender's thread. Automatic group correlation was removed on 2026-11-17. Instead, each incoming message in a person's thread has a "Move to a
  group…" hover button and a right-click menu, both of which start pick mode with that message picked;
  `group.assignMessage` moves it and adds the sender to the group's members. Groups store a roster (manual).
- **Reactions:** detect iOS tapback text (`Loved "…"`, `Laughed at "…"`, …, plus localized forms later) and attach it as
  a `reaction` on the closest matching message in the thread, or show it as a small note. Best effort. _Done
  (`core/src/reactions.ts`):_ English tapbacks attach to the newest matching message (a quote iOS cut short with `…`
  matches by prefix) in the thread or the sender's groups. Removals (`Removed a heart from …`) tombstone the reaction. One Tincan can't place stays a visible message.
- **Commands:** _Done (`core/src/handlers/`):_ the sync, thread, message, contact and group commands run over
  the store and whichever phone services the daemon `attach`es (`NOT_CONNECTED` "No phone is set up" without
  them). Thread keys are canonicalised (`tel:5550100001` → `tel:+15550100001`). `message.send` takes a thread key,
  number, email or contact name (an exact name first); a contact with several numbers uses the one with the most
  recent conversation, and anything ambiguous is refused without echoing names or numbers. Groups can't be sent to.
  The CLI accepts `--no-<flag>` for booleans that default to true.
- **Agent policy:** settings `agents.enabled` (default off: MCP callers may only use `status`, `version`, `commands`
  and `settings.get`), `agents.read: off|on` (default off until onboarding asks) and
  `agents.send: never|approve|allow` (default `never`). Commands with `sensitive` or `approval` are checked against the
  caller (`client.kind`) and policy.
- **Approvals:** an agent `message.send` creates an `Approval` (recipient, text, requesting client) and emits
  `approval.requested`. The desktop shows a prompt and a notification. Approve sends it; deny or expire after 10 min returns `APPROVAL_DENIED`.
  The MCP tool waits for the result (with a timeout). The gate guards against agent mistakes; it is **not** a security
  boundary against malware running as your user (anything that can reach the socket can impersonate a client).
  _Done:_ the daemon holds the agent's request open until it's settled, so the MCP client needs a call timeout over
  10 min. The recipient is resolved before asking, and approving runs exactly the input shown (`message.retry` is
  gated the same way). A bad recipient fails before anyone is asked. Approvals are local rows; closing the daemon
  expires waiting ones, as does startup for leftovers. `tincan approval list` / `tincan approval resolve <id> approve|deny`.
- **Untrusted content:** message text is data. MCP results keep bodies in structured fields, and the guide tells
  agents never to follow instructions found inside messages.

### 5.5 `@beyland/tincan-daemon`

- `tincan daemon` runs core + native + socket server. Single instance through a lock file in `$XDG_RUNTIME_DIR/tincan/`.
- Socket directory `0700`, socket `0600`. Refuse to start if the directory has the wrong owner or permissions.
- Shows notifications through the native `notify`. Clicking one runs `tincan-desktop --thread=<key>` (or xdg activation).
  Notifications show the sender and a preview, configurable (`full | sender | hidden`).
  _Done:_ `DesktopNotifier` (`core/src/notifier.ts`) shows one notification per new incoming message (a burst
  collapses into "N new messages") and skips muted and hidden threads. It used to mirror the phone's other apps'
  notifications too (`notifications.otherApps`); that was removed on purpose — Tincan is a messages app, and ANCS is
  now used only to name group conversations. Click-through waits for the desktop app.
- _Done (`daemon/src/phone.ts`, `daemon/src/store.ts`):_ `tincan daemon` opens the encrypted store at
  `~/.local/share/tincan/tincan.db` (key in the keyring), picks the phone (the remembered `phone` setting, else the only
  paired iPhone, else the only connected one), and once it's paired starts sync, the outbox, contacts, ANCS and the
  notifier, then reports `status.phone` from them. A phone paired later is picked up from BlueZ's device events.
  With no native addon it runs without a store, as before.
- `tincan service install|uninstall|status` writes `~/.config/systemd/user/tincan.service` (`Restart=on-failure`)
  with an `ExecStart` pointing at a **stable path** (the AppImage file, or the CLI from npm).
- Runtime: in the AppImage, the bundled Electron binary runs the daemon with `ELECTRON_RUN_AS_NODE=1` (plain Node, no
  Chromium: about 81 MB against 173 MB as a windowless main; keep the `runAsNode` fuse on). With the npm CLI,
  system Node ≥ 22.18 runs it. Both load the same N-API addon.
- Shuts down cleanly: closes the MAP session (frees it for other computers), flushes the store, removes the socket.
- `doctor` checks: BlueZ version, bluetoothd `--experimental`, adapter powered and LE capable, device class,
  obexd running on the session bus, phone paired with an LE bond, MAP/PBAP/ANCS reachable, iOS "Show Message Notifications"
  and "Sync Contacts" on (detected from permission errors), MAP not held by another computer,
  keyring available, service installed. Every check returns `ok | warn | fail` + a fix hint + an `autoFix` id.
  _Done:_ `diagnose()` in `core/src/doctor.ts` is pure (facts in, checks out, plus `skip` for what couldn't be
  read); `daemon/src/system.ts` gathers the facts (`bluetoothctl --version`, `/proc` cmdlines, `main.conf`, the
  ERTM parameter, the addon's adapter and devices, `busctl --user` for obexd). The MAP, PBAP
  and ANCS checks read the services' `lastError`. `tincan doctor` asks the daemon, or runs the same checks itself
  when none is running (phone checks skipped) and exits 1 if any fail. `tincan service install` writes the unit from
  `renderUnit()` with `ExecStart` set to the real paths of node and tincan (version managers put node behind
  per-shell shims), creates the `ReadWritePaths` directories first, and uses `RuntimeDirectory=tincan` because
  `ProtectSystem=strict` makes `$XDG_RUNTIME_DIR` read-only. `packaging/systemd/tincan.service` is tested to match.
  `doctor --fix` is Phase 4.
- _Done:_ **Background service from the app.** `service.status` and `service.install` let the desktop install the
  unit. A daemon the app spawned holds the single-instance lock, so `systemctl restart` would fail on it. Instead
  the daemon writes and enables the unit without starting it, stops itself (releasing the lock and socket), then
  runs `systemctl --user start tincan.service`; `ensureDaemon()` reconnects to it. If the service is already active
  it _is_ this daemon, and nothing is handed over. Daemons on a fake phone or their own socket can't install it
  (the unit runs the real phone on the default socket), and report `NOT_FOUND`. `service.disable` disables the
  unit without stopping it, and leaves it in place (the service's `ProtectHome` can't remove it; `tincan service
  uninstall` does). When this daemon is the service it replies, then exits cleanly (so `Restart=on-failure`
  leaves it stopped), and `ensureDaemon()`, which starts the unit only when it `is-enabled`, spawns the app's
  own daemon.
- _Done:_ **Connection history.** Core records the phone's connection, its messages access (including
  `refused`), pairing, the adapter and its class in a `connection_log` table (states, addresses and error codes
  only; capped at 500 rows). `tincan device history` lists it. Doctor's `history` check warns when the phone
  dropped repeatedly or messages were refused in the last day.
- _Done:_ **Refused messages.** After three `NOT_FOUND` MAP opens in a row (iOS isn't offering MAP to this
  computer), the MAP profile reports `refused` instead of `connecting`. Doctor counts the failures and explains
  the fix: turn on **Show Message Notifications**, else forget this computer on the iPhone and Tincan's pairing,
  restart the iPhone, and pair again. `device.connect` also makes the messages link retry straight away.
- _Done:_ **Hands-free class.** `device.info` and `device.pair.status` report `handsFree` (the adapter's class is
  Audio/Video Hands-Free, see [native.md](native-phase-0.md#device-class-phase-05-2026-10-31)). The daemon watches the
  adapter, so a class reset after a bluetoothd restart shows up in Settings, the Pair dialog and `tincan pair`.

### 5.6 `@beyland/tincan-client`

- Typed `run<Name>(input) → Promise<Output>` from contracts, `subscribe(handler)`, handshake, automatic reconnect,
  request timeouts, and a `ensureDaemon()` helper (starts the service, or spawns `tincan daemon` if no service is installed).
  **Done:** `ensureDaemon()` starts `tincan.service` when `systemctl --user cat` finds it, otherwise spawns a detached
  `tincan daemon`, then waits for the socket. `ReconnectingClient` retries with backoff (250 ms doubling to 5 s), keeps
  event handlers across reconnects and reports `connecting`/`connected`/`closed` through `onState`, so callers can
  refetch after a reconnect. Requests made while disconnected fail fast with `NOT_CONNECTED`.

### 5.7 CLI — `@beyland/tincan` (`tincan`)

- Generated: `tincan <group> <action>` from contracts (flags from the input schema, `--json`, `@file` values, positional arguments).
- Hand-written: `tincan daemon`, `tincan service …`, `tincan setup` (runs the privileged system setup through `pkexec`, shows
  exactly what it will change first, idempotent, `--uninstall`), `tincan doctor [--fix]`, `tincan pair` (interactive),
  `tincan mcp`, `tincan mcp-config [client] [--install]`, `tincan commands`, `tincan schema`.
- Nice extras: `tincan watch` (stream incoming messages), `tincan send <to> <text>`, `tincan threads`, `tincan open <thread>`.
- CLI calls identify as `client.kind = "cli"`. Sends ask for confirmation on a TTY unless `--yes`.
- _Done:_ `tincan mcp`, `tincan mcp-config [client] [--install] [--name] [--force]`, and the `send`/`threads` shortcuts
  (aliases for `message.send`/`thread.list`). `message.send`, `message.retry` and `group.delete` ask `[y/N]` on stderr
  when stdin and stderr are terminals; `-y`/`--yes` skips it and scripts proceed without asking. `mcp-config` launches
  the resolved Node and CLI paths (`node …/bin.ts mcp` from source, which needs Node's default type stripping).
  `--install` merges into JSON(C) configs (Copilot CLI `~/.copilot/mcp-config.json` or `$COPILOT_HOME`, Cursor
  `~/.cursor/mcp.json`, VS Code `~/.config/Code/User/mcp.json` under `servers`), keeps other servers, copies the old
  file to `<file>.bak`, reports `created`/`updated`/`unchanged` and needs `--force` to replace a different `tincan`
  entry. Claude Code and Codex own their configs, so Tincan runs `claude mcp add --scope user` / `codex mcp add` after
  checking `~/.claude.json` / `~/.codex/config.toml`. Not yet: `setup`, `doctor --fix`, `open`.
- _Done:_ `tincan pair [address]` (`device.pair.*`): makes this computer discoverable, lists the iPhones it finds
  (or takes an address), pairs, shows the passkey to compare, and hides the computer again. Pairing started from
  the iPhone's Settings ▸ Bluetooth is noticed too. The daemon adopts the new iPhone, replacing a stale remembered
  one. It warns when the adapter isn't hands-free. `tincan --help` leaves out `service.*`: `tincan service` runs
  locally rather than asking the daemon.

### 5.8 MCP — `@beyland/tincan-mcp` (`tincan mcp`, stdio)

- One tool per non-internal contract (`message.send` → `message_send`) with `inputSchema`, `outputSchema`, and
  `readOnlyHint`/`destructiveHint`/`openWorldHint` annotations.
- Resource `tincan://guide` (AGENTS guide), plus resources for `tincan://threads` and `tincan://thread/{key}` (only when `agents.read` is on).
- Sends go through the approval flow. If the MCP client supports elicitation, it also asks the user there.
- `mcp-config` snippets/installers for Claude Code, Codex, GitHub Copilot CLI, Cursor, VS Code.
- _Done:_ `createMcpServer({client})` and `runStdioServer()` in `packages/mcp`. Tool schemas are the contracts' zod
  schemas. For array outputs (`thread.list`, `message.list`, …) the SDK advertises `{result: [...]}` as the output schema
  and `structuredContent` to clients before protocol 2026-07-28, while the text content stays the bare JSON. Errors
  come back as `isError` results with `CODE: message` text. The server connects lazily with client kind `mcp` and
  `timeoutMs: 0`, because approvals hold `message_send` open for up to 10 minutes. Approval-gated tools say so in their
  description and send progress notifications every 15 s while waiting, if the client asked for progress. The
  `tincan://threads` and `tincan://thread/{key}` resources (the thread plus its last 50 messages) are registered while
  `agents.read` is on, and follow `settings.changed`. Elicitation is skipped: the SDK's form elicitation is deprecated
  for 2026-era requests, and an agent's client shouldn't be the one to approve the agent's own send, so approval stays
  in the Tincan app or `tincan approval resolve`.

### 5.9 Desktop — `apps/desktop` (Preact + Electron + TypeScript + Vite+)

**Main process:** single-instance lock (`--thread=` opens or focuses the conversation), tray icon with an unread badge,
`ensureDaemon()` on start, owns the socket through `tincan-client`, exposes only `run`/`subscribe` over IPC, blocks
`internal` commands unless they come from its own windows, autostart option (XDG autostart), and a menu command
"Install `tincan` in PATH".

**Security:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, no remote content,
`setWindowOpenHandler` denies everything except `https:` links (opened in the browser), all navigation blocked, IPC
input checked against contracts in main.

**Renderer:**

- **Onboarding wizard:** doctor checks → `tincan setup` (pkexec) if needed → pair (passkey confirm) → iOS toggles with
  screenshots → install the service → first sync progress → **"What Tincan can't see"** → agent access choices.
- **"What Tincan can't see"** (an onboarding step, also under Settings ▸ About): one short screen that says, in plain
  words, that (1) messages you send from the iPhone itself don't appear in Tincan, only ones sent from Tincan; (2) Tincan
  starts with only the most recent messages on the phone (iOS shares about the 10 newest) and keeps everything from
  then on; (3) photos, videos and other attachments can't be shown, only marked. The user acknowledges it once.
- **Onboarding as a conversation (done in the desktop app):** first run opens "Tincan · Getting started" at the top of
  the thread list instead of a dialog. Tincan "types" each step behind a typing indicator, and the user answers with
  quick-reply chips. Steps: hello, pairing (a live iPhone card with Pair iPhone…), the two iPhone Bluetooth switches
  (an iOS-style settings mock that turns green as MAP/PBAP come up), what Tincan can and can't see, personalising
  (theme with hover preview, pop-up position, default country), the background service, AI agents (a switch) and
  shortcuts. Answers are kept in `localStorage`, so it resumes where it was left; closing it or "Start using Tincan"
  marks it done, and Settings or the palette ("Getting started with Tincan") reopen it. Doctor checks, first-sync
  progress and demos of reactions or the info panel aren't in it yet. The original idea:
- **Idea — onboarding as a conversation:** instead of (or around) a wizard, first run opens a pinned "Tincan" thread
  that tells the setup story as an example text conversation. Tincan's messages explain each step, and the user's
  replies are suggested-action chips such as "Pair my iPhone", "Turn on Show Notifications" and "Got it". Doctor
  checks, pairing, iOS toggles (with inline screenshots as image cards), the first sync's progress and "What Tincan
  can't see" each become a few bubbles with rich cards. The thread also shows off the app: reactions, link previews,
  the info panel and the command palette, demonstrated on real UI. It is local only: it is never sent and never
  reaches MAP. It can be replayed from Settings ▸ About and hidden like any thread. Open questions: whether doctor
  failures should interrupt the conversation or render as an inline "fix it" card; and keyboard-only flow (the chips
  are buttons, Enter picks the first).
- **Main view:** thread list (search, unread, pinned, muted, group badge) | conversation (grouped bubbles, day
  dividers, contact photos, send status + retry, reaction notes, "sent from iPhone not shown" hint, attachment
  placeholder, history-start marker) | composer
  (per-thread drafts, Enter to send, Shift+Enter for a new line, character count for SMS).
- **Attachment placeholder:** an attachment arrives as U+FFFC in the body, an `attachmentHint`, or iOS's own text
  ("Attachment: 1 Image", "Attachments: 3 Images, 1 Video", "1 Sticker", "1 Audio File"). Each kind gets its own
  card, never a broken image or "�": photos as a tile grid (up to four, "+N"), video as a dark player frame, audio as
  a mic pill ("Listen on your iPhone"), files as a document row, stickers as a die-cut sticker with a peeled corner and contacts as a contact
  card, each with the count and "View on your iPhone". An unknown kind falls back to a generic card. A shared
  location or iMessage app item (U+FFFD) becomes a location card with a drawn map and the same note. Notifications
  say "1 attachment" or "Shared a location or Messages app item" instead of the raw characters.
- **Jumbo emoji:** a message of one to three emoji and nothing else is drawn about 3× larger with no bubble; a
  tapback on it gets room above so it doesn't overlap the message before.
- **Message time:** hovering a message shows its time as a small label beside the bubble, on its open side, centred
  vertically. Cards and rich content sit a little apart from the text of their message.
- **History-start marker:** above the oldest message Tincan has for a thread, a quiet divider: "Earlier messages are
  only on your iPhone."
- **Window:** no system titlebar. The sidebar and conversation headers are the drag region; the window controls are
  drawn over the conversation header (macOS: traffic lights over the sidebar header).
- **New message:** written in place of the conversation, like Messages: a "To:" field (contact picker from PBAP, or a
  number or email) in the header, the existing conversation shown below once a known recipient is picked.
- **Groups:** save and edit member lists, "move to group" for messages that arrived as individual texts (started from
  the info panel or the palette; pick several, then choose a group or name a new one), explanation of the limits. Unnamed groups are titled by their members' names ("Aunt Kate, Nana, Uncle Jay"), and
  any group can be renamed from Group Info, the conversation menu or the palette (an empty name goes back to the members).
- **Tapbacks:** a reaction text (`Kaia liked “…”`, `Loved “…”`, `Reacted 🎉 to “…”`) is shown as a badge on the
  message it quotes, drawn with Tincan's own iOS-style tapback icons (heart, thumbs up/down, "ha ha", !!, ?) rather than emoji; a custom emoji reaction shows that emoji. When Tincan doesn't have that message (sent or received on the iPhone before Tincan synced), a
  **ghost bubble** stands in for it: the quoted text with a dotted border, faded, on the side it most likely came from,
  with a "Not in Tincan" caption and a tooltip saying it was sent or received while Tincan wasn't connected to the iPhone. Tapbacks are kept as rows (`reaction_kind` set,
  `reaction_to` null) and attach to the real message as soon as Tincan stores one whose text they quote (`placeTapback`
  on arrival, `#adoptTapbacks` when the quoted message arrives later, e.g. from an sms.db import). Tincan can't send
  tapbacks: MAP has no reaction API, and a `Liked “…”` text from Tincan shows on iOS as plain text.
- **Contact info:** the info button in the conversation header, `Ctrl+Shift+B` or "Contact info" in a thread's
  context menu opens a panel on the right of the conversation (Esc or `Ctrl+Shift+B` closes it) with the contact's photo, phone numbers and emails
  (a group's members), and pin/mute/hide, move messages to a group (direct threads) and delete. The conversation header itself carries no pin/mute/hide buttons;
  those live in the context menu, the info panel and the palette. Contacts are read-only (PBAP can't write), so
  edits happen on the iPhone and arrive with the next contacts sync. Photos come from `contact.photo` (an internal
  query that returns the PBAP photo as base64) and are fetched lazily per contact.
- **Sidebar:** resizable by dragging its edge (220–440 px, double-click resets, arrow keys when focused) and
  collapsible with the sidebar button or `Ctrl+B`; both are remembered. Group threads show two members' photos
  stacked; pinned tiles show a contact's first name.
- **Links:** web links in messages are clickable and open in the browser. The first link in a message gets a preview
  card (title, site, image) fetched by the main process: http(s) only, public addresses only (every DNS answer and
  redirect is checked, so a message can't make Tincan probe the LAN), 5 s timeout, 1 MB of HTML and a 2 MB image at
  most, cached in memory. The image comes back as a data URL. Settings ▸ Appearance ▸ Link previews turns fetching
  off; URLs are never logged. "Messages that are only a link" (Link and card / Card only) can hide the URL text of a
  message that is just a link when its card can be drawn. Some sites get their own card:
  - **Giphy:** the whole GIF at its own aspect ratio (from the media URL), with a light caption instead of a card.
  - **YouTube:** an in-chat player ([lite-youtube-embed](https://github.com/paulirish/lite-youtube-embed)): a poster
    with a play button that loads the `youtube-nocookie.com` iframe only when clicked (the CSP allows that frame and
    main adds the Referer YouTube requires). `t=` start times are kept. The player is trimmed (`rel=0`, no annotations or captions by default, no fullscreen);
    YouTube's own title and logo overlay can't be turned off.
  - **Bluesky:** posts are read from the public AppView (`public.api.bsky.app`) and drawn as a post card: author,
    avatar, text, images, video poster, external link, quoted post and counts. iOS sometimes sends only a rich-link
    summary ("Website: patak (@patak.cat) (bsky.app)", with bidi marks and no URL); that is drawn as a summary card.
    Future cards worth adding (most shared by text): Spotify/Apple Music, Instagram/TikTok reels, X/Threads, Google/Apple
    Maps places, Amazon products, Airbnb/Zillow listings, GitHub repos/PRs, Reddit, Partiful/Eventbrite events,
    Letterboxd/IMDb, news articles.
- **Tooltips:** every hover hint is Tincan's own tooltip (`data-tip`, one delegated `Tooltip` component) rather than a
  native `title`: themed, placed below and flipped above near the window's edge (inside a message row they open beside the bubble instead), quick to reappear once one has
  shown, keyboard focus shows it too, and shortcuts render as key chips. Icon-only buttons carry an `aria-label`.
- **Scrollbars:** every scroll area uses one thin, themed scrollbar with a transparent track; the thumb takes the
  accent on hover.
- **Delete conversation:** the thread context menu and info view offer "Delete Conversation" (`thread.delete`). It
  happens at once: the thread is hidden and a toast offers Undo for a few seconds before the command runs. It tombstones the thread and its messages in Tincan only; the iPhone keeps them, MAP re-lists don't
  bring them back, and a new message starts the thread again.
- **Delete messages:** "Delete Messages…" in the info panel or the palette uses the same pick mode as move to group;
  the picked messages are removed from Tincan after a confirmation (`message.delete`, tombstoned with their tapbacks).
  The iPhone keeps them and syncs don't revive them.
- **In-app notices:** confirmations, errors and undo offers are toasts (`notify(title, {tone, body, action,
  duration})`): wide cards that slide in, stack as a deck and fan out on hover (which pauses their timers), dismiss
  themselves after a few seconds (errors stay longer) or with ×, and can carry an action. Pin, mute and hide offer
  **Undo**. Settings ▸ Notifications ▸ Notification position picks one of six corners/edges.
- **Contacts refresh:** "Refresh Contacts" in the info panel, "Refresh now" on the iPhone card and the palette's
  "Refresh contacts" run `contact.sync {force: true}`, a full PBAP re-read, so edits made on the iPhone show up.
  A "Refreshing contacts…" notice appears while it runs. Cached photos stay on screen until their replacements load.
- **Contact details:** PBAP asks for name, numbers (with labels), emails, nickname, organization/department, title,
  birthday, addresses, URLs and note, kept as `contacts.details` JSON (migration 2). iOS actually sends only name,
  numbers, emails, photo, company, addresses and websites. Birthday, notes, nickname, job title, related names and
  social profiles stay on the phone. The info panel shows what arrived as click-to-copy rows (a hover Copy button,
  the whole row is a `cursor: copy` target, and "Copied" feedback), plus a "What your iPhone shares" disclosure.
- **Approvals:** banner and queue for agent send requests (recipient, full text, which agent).
- **Status bar:** phone connected / reconnecting / busy elsewhere / permission missing / disconnected from Tincan, with a link to the fix.
  When the phone is out of range: "iPhone away — new messages will arrive when it's back." It shows one actionable
  item at a time and never blocks the app.
- **Gap marker:** where the sync engine recorded a gap, a quiet divider in the conversation: "Messages from 2:10–4:30
  PM may be missing." (With backup sync on, it adds "· filled in at the next sync" and a **Fill in now** button;
  see the backlog.)
- **Settings:** phone, notifications (preview level, sound), sync depth, groups, agent access, appearance (light/dark/system, color themes, link previews), about/diagnostics export (redacted). Each section is a card. The settings modal is about 68% of the
  window wide and 75% tall over a blurred backdrop, with a thin themed scrollbar.
  The iPhone card (`device.info`) shows the name, connection, each profile's state (messages, contacts,
  notifications), last check, last contacts sync, what Tincan keeps, pairing and address, with **Check now**,
  **Disconnect** / **Connect** (`device.disconnect` stops Tincan using the phone and is remembered across daemon
  restarts; `device.connect` resumes) and **Forget…** (`device.forget`, confirmed: unpairs the phone and clears its
  messages from Tincan). **Default country** is a searchable picker (flag, name, calling code; search by name, ISO
  code or "+44") and sets the region used to read numbers typed without a leading `+`.
  With no iPhone paired the card offers **Pair iPhone…**. When messages are refused it shows a checklist and
  **Fix connection…**, and it warns when the adapter isn't hands-free. A **Copy diagnostics** link copies the
  doctor checks and the connection history (no message text, numbers or names) for a bug report.
- **Pair iPhone dialog** (`device.pair.*`): searches, lists the iPhones found, shows the passkey to compare, and on
  failure lists what to try (forget this computer on the iPhone, restart it). Opened from Settings, the status
  line, the palette, or the onboarding conversation when no iPhone is paired. The Forget dialog points to it and warns that an iPhone
  may need a restart before it pairs again.
- **Fix connection dialog:** opened from the status line, the refused checklist in Settings and the palette. It
  steps through what got a refusing iPhone working: turn on Show Message Notifications and try again, forget on
  both sides, restart the iPhone, then pair again.
- **Background card:** when the daemon can manage the service (`service.status`), a **Run in the background**
  switch. On (`service.install`), Tincan starts at login and restarts if it stops; a daemon the app started hands
  over to the service and the app reconnects. Off (`service.disable`) disables the service; if the app was
  connected to it, the app reconnects to a daemon of its own. Hidden for fake-phone and custom-socket daemons.
- **Themes:** System, Light and Dark, plus 16 color themes (Periwinkle, Fog, Sand, Mint, Orchid, Sky, Coral,
  Graphite, Slate, Forest, Midnight, Plum, Ocean, Ember, Contrast Light/Dark). A color theme sets the window's light or
  dark scheme to match (`nativeTheme.themeSource`) and its colours through `:root[data-theme]`. Each theme's swatch
  is a gradient of its accent, a second accent and its background. Settings ▸ Appearance picks one from a single dropdown
  grouped Tincan / Light / Dark / High contrast, which previews each theme live as you arrow through it.
- **Settings order:** Appearance, iPhone, Background, Notifications, Phone numbers, AI agents.
- **Photo attachments** draw as a fanned stack of up to three portrait stand-in tiles (3:4 in front, 4:5 behind, never
  square) with no bubble behind them (as Messages stacks a batch), with the count and "View on your iPhone" in small
  type underneath. A single photo lines up with the messages around it.
- **Settings controls:** on/off settings (link previews, hide link-only messages, AI agents, agents reading messages) are
  switches; settings with more than two choices are segmented controls or dropdowns. Each agent setting says what
  it allows; the read and send settings only appear once the switch beside the AI agents title is on.
- **Empty state:** with no conversation open, a short list of clickable starters (new message, search, command
  palette, settings) with their shortcuts.
- **Command palette** with labelled groups: Conversations, This Conversation (info, pin, mute, hide,
  delete, mark read), Actions (new message, search, sidebar, check phone, hidden conversations, settings), iPhone
  (connect/disconnect, forget, details, refresh contacts) and Appearance ("Change theme…", link previews, link-only
  messages). "Change theme…" opens a submenu of every theme (high-contrast themes in their own group) that previews each one live as you arrow through it; Esc or Backspace goes back and
  restores the saved theme. Keyboard shortcuts: `Ctrl+K`, `Ctrl+N`, `Ctrl+F`, `Ctrl+B`, `Ctrl+Shift+B`, `Ctrl+,`, `Alt+↑/↓`.
- Accessibility: keyboard reachable, ARIA roles on lists and messages, respects reduced motion.

**Packaging:** electron-builder AppImage + .deb (x64, then arm64). The .deb installs the `tincan` CLI symlink. The AppImage
offers to install it. Updates: electron-updater (AppImage) against GitHub Releases.

---

## 6. Testing strategy

| Layer        | Tooling                                                        | What it covers                                                                         |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Rust parsers | `cargo test` + fixtures                                        | bMessage, vCard (2.1/3.0, encodings, photos), ANCS attribute parsing                   |
| Rust D-Bus   | `zbus` mock servers or `python-dbusmock` in `dbus-run-session` | pairing agent, MAP/PBAP calls, reconnect logic, error mapping                          |
| Core         | Vitest (`vp test`) with `fake-phone`                           | sync, dedupe, thread keying, groups, outbox/watchdog, migrations, policy/approvals     |
| Surfaces     | Vitest                                                         | CLI flag generation, MCP tool list/annotations, envelope/handshake, socket permissions |
| Desktop      | Playwright `_electron` against a daemon using `fake-phone`     | onboarding, read/reply, notifications click-through, approvals                         |
| Hardware     | `docs/hardware-checklist.md` + `tincan doctor --report`        | real iPhone: lock, sleep/resume, out of range, iOS update, other computer holding MAP  |

`fake-phone` is what lets coding agents work without a real iPhone: `TINCAN_FAKE_PHONE=fixtures/scenarios/busy-group.json tincan daemon`
swaps in a scripted implementation of the native API (incoming messages, group bursts, failures, disconnects)
and an in-memory store, so it touches neither Bluetooth nor the keyring. The CLI tests run their daemon this way.
A scenario is JSON: `phone` (name, address, own number), `contacts`, a seeded `inbox`, `notifications` already on the
phone, and a `script` of steps (`receive`, `notify`, `disconnect`, `reconnect`, `readOnPhone`, `failNextPush`,
`shareMessages`, `adapterClass`), each run `afterMs` after the previous one. `phone.paired: false` starts unpaired
(the fake adapter finds the phone while discoverable), `phone.shareMessages: false` makes MAP opens fail with
`NOT_FOUND` and `phone.adapterClass` sets this computer's class. `unpaired.json`, `refused.json` and
`class-reset.json` show pairing, a refusing iPhone and a class reset. Tests drive `FakePhone` directly and call `settle()` to flush its events.

---

## 7. Phases

Estimates assume coding agents do most of the implementation and you review the work and test on real hardware.

### Phase 0 — De-risking spike (3–5 days)

Throwaway prototypes on your real laptop and iPhone, to answer the riskiest questions first:

1. napi-rs + zbus: connect, open MAP, list the inbox, receive an MNS NewMessage event, push a message, pull PBAP, subscribe to ANCS.
   **MAP done** (2026-10-31, [native.md](native-phase-0.md#map-phase-01-2026-10-31)): live `NewMessage` events, listing, download and push
   to `outbox` work; iOS lists only the 10 newest inbox messages and sends no read or sending reports.
   **PBAP done** (2026-10-31, [native.md](native-phase-0.md#pbap-phase-01-2026-10-31)): contacts (1 s for 460, 8 s with photos),
   favourites, call history (capped at 100 per list) and version counters all work.
   **ANCS done** (2026-11-01, [native.md](native-phase-0.md#ancs-phase-01-2026-11-01)): live notifications, removals and
   reconnects work; the run found and fixed a bug that lost most of the pre-existing backlog.
2. The addon loads in system Node **and** in Electron `--daemon` mode from inside a packaged AppImage.
   **Loads in Node 24 and Electron 45** (2026-10-31, [native.md](native-phase-0.md#addon-in-node-and-electron-phase-02-and-04-2026-10-31)); the packaged AppImage is still to check.
3. rusqlite with bundled SQLCipher builds for x64 and arm64; the key round-trips through GNOME Keyring.
   **Done on x64** (2026-10-31, [native.md](native-phase-0.md#vault-phase-03-2026-10-31)); arm64 still to build.
4. Measure the memory of Electron in `--daemon` mode, to confirm it's acceptable as an always-on service.
   **Done:** about 81 MB PSS with `ELECTRON_RUN_AS_NODE`, against 173 MB as a windowless Electron main and 24 MB under system Node. The daemon uses `ELECTRON_RUN_AS_NODE`.
5. Find out whether BlueZ `main.conf` `Class=` is enough, or a dedicated device-class unit is needed.
   **Done:** it isn't enough, because BlueZ's `hostname` plugin overrides it. `system-setup` installs a oneshot `btmgmt class 4 8` unit, and `doctor` checks the class ([native.md](native-phase-0.md#device-class-phase-05-2026-10-31)).

**Exit:** a script prints incoming messages live and can send a reply; decisions written to `docs/decisions/`.
ADRs 0001–0005 are written ([decisions/](../decisions/README.md)); the MAP decisions wait for the item 1 hardware run.

### Phase 1 — Foundations (3–4 days)

- Monorepo scaffold: pnpm 12 catalog, `vite.config.ts` (fmt/lint/type-aware), `tsconfig.base.json`,
  Cargo workspace, `@napi-rs/cli` build wired into `vp run`.
- CI: `vp check`, `vp test`, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, napi build matrix.
- `protocol` with the envelope, error codes, entities, and the first contracts (`status`, `commands`).
- `AGENTS.md`, `docs/architecture.md`, LICENSE, NOTICE, issue templates.

**Exit:** `pnpm ready` passes on CI; `tincan commands --json` prints schemas from a stub daemon.

### Phase 2 — Native layer (1–2 weeks)

- `tincan-bt`: adapter/device/pairing agent, MAP (list/get/push/setRead/MNS), PBAP, ANCS, reconnect supervisor, sleep/resume.
- `tincan-vault`, notifications, panic safety, log redaction.
- Port parsers and fixtures; mock-D-Bus tests.

**Status (2026-11-01):** done. Every §5.3 API is built with mock-backed Rust and node tests; MAP, PBAP and ANCS have run
against the real phone, and CI checks that the generated `.d.ts` is committed.

**Exit:** every API in §5.3 works against a real phone and has mock-backed tests; the `.d.ts` is checked in CI.

### Phase 3 — Core + daemon (1–2 weeks)

- Store and migrations (sync-ready, [ADR 0007](../decisions/0007-sync-ready-store.md)), sync engine, thread keying, contacts, outbox/watchdog, groups, tapback detection.
- Socket server, events, policy and approvals, `doctor`, `service install`, `fake-phone`.

**Exit:** the daemon runs as a user service for 48 hours on your laptop: survives sleep, reconnects, no duplicate messages, notifications work.

### Phase 4 — CLI + MCP (3–5 days)

- Generated CLI plus the hand-written commands (`setup`, `pair`, `doctor --fix`, `watch`, `mcp-config --install`).
- MCP server with annotations, resources, approval wait, elicitation.
- _Done:_ `tincan mcp`, `mcp-config --install`, the MCP server (§5.8), `send`/`threads` and send confirmations.
  Elicitation is deliberately skipped (§5.8). `setup`, `pair` and `doctor --fix` remain.

**Exit:** an agent in Claude Code/Copilot CLI can list threads, summarize unread messages, and draft a reply that waits for your approval.

### Phase 5 — Desktop app (2–3 weeks)

- Main/preload/security, onboarding, thread list, conversation, composer, new message, groups, approvals, settings,
  tray, command palette, themes, the icon set.
- _Done (`apps/desktop`):_ the main process (single-instance lock with `--thread=`, `ensureDaemon` + reconnecting
  client, `run`/`subscribe`-only IPC with the internal-command gate, sandbox, CSP, navigation blocked, tray); the
  onboarding conversation with Tincan (setup cards inline) and its "What Tincan can't see" step; thread list with search, unread, pinned, muted and groups; conversation
  with day dividers, history-start and gap markers, attachment chips, reaction notes, send status and retry; composer
  with drafts; new message; group sender names and the group-reply limit; the approval banner; status line; settings;
  command palette and shortcuts; System/Light/Dark theme setting (kept in the app's `preferences.json`); custom
  titlebar; inline new message; picking messages to move into a group; tapbacks placed on their message, or on a
  ghost bubble when Tincan doesn't have it; contact photos; the contact info panel; thread context menu; deleting
  conversations (`thread.delete`) and messages (`message.delete`); stacked group avatars; a resizable, collapsible sidebar; clickable links with
  preview cards; a grouped command palette; settings cards; the iPhone settings card with connect, disconnect and
  forget (`device.*`); iOS-style tapback icons; color themes; the empty-state starters; the palette's theme submenu and the Settings theme picker with live preview on hover; group renaming; per-kind attachment cards and location cards; jumbo emoji; hover time labels; stacked toasts with Undo and placement; contact refresh; link-only messages; Giphy, YouTube (lite-youtube-embed) and Bluesky cards; custom tooltips; themed scrollbars; the default-country picker. `pnpm --filter @beyland/tincan-desktop dev` runs
  it against a fake-phone daemon, and the UI was checked there end to end, including an agent send approved from the
  banner. `TINCAN_DEV_REAL=1` runs it against the real daemon; checked with the user's iPhone.
  Since then: the Pair iPhone dialog, the refused state and Fix connection, the hands-free warning, Copy
  diagnostics and the Background card. Remaining: an onboarding flow around them, the app icon, packaging.

**Exit:** you can use Tincan as your daily messaging app on Linux.

### Phase 6 — Hardening (1–2 weeks, overlaps Phase 5)

- Hardware checklist on at least your laptop + iPhone, ideally another adapter (Intel vs. Realtek/MediaTek) and an older iOS.
- Edge cases: MAP held by another computer, iOS permission prompts, phone restarts, adapter unplugged, 10k+ messages, emoji/RTL/long text, contact-less numbers, short codes.
- Performance: thread list and search under 50 ms on 10k messages; daemon memory budget.
- Redacted diagnostic bundle (`tincan doctor --report`).

### Phase 7 — Release 1.0 (3–5 days)

- release.yml: AppImage + .deb (x64 and arm64), the native addon npm packages, `@beyland/tincan` CLI.
- **Supply chain:** pinned, checksum-verified build tools, `SHA256SUMS`,
  GitHub artifact attestations / npm provenance, and no `curl | sh` in builds.
- `tincan.beyland.dev`: landing page, install guide, supported/unsupported table, troubleshooting, agent guide.

**Total:** about **4–8 weeks to a daily driver** (end of Phase 5), and **2–3 months to a polished public 1.0**.

### After 1.0 (backlog)

- Inline reply from notifications (KDE supports it; GNOME doesn't).
- Several phones; message export (JSON/Markdown); per-thread notification rules.
- Localized tapback detection; better group heuristics.
- Optional: a second messaging source (e.g. BlueBubbles for users who also have a Mac) behind the same core interface.
- **RCS as a transport** (iOS 18+). Tincan can't speak RCS itself (it needs the SIM's carrier IMS registration), but the
  iPhone may relay RCS chats with Android contacts over MAP like SMS and iMessage. Add to the hardware checklist:
  whether RCS 1:1 and group messages appear in MAP listings and ANCS, whether a MAP push to an Android contact goes
  out as RCS or falls back to SMS, and how the bMessage marks it. If MAP shows them, label the transport in threads
  where it's detectable; if not, fall back to ANCS text as for groups.
- **Sending to group chats** (opt-in experiments; MAP can't push to a group). Spike in this order:
  1. **Shortcuts relay.** The user installs a "Tincan Send" shortcut from an iCloud link (no App Store app) and a
     personal automation "When I get a message containing `⟦tincan⟧`" set to Run Immediately. Tincan pushes a 1:1 MAP
     message to the user's own handle (`⟦tincan⟧ send <member handles> | <text>`); the shortcut parses it and uses
     Send Message with those recipients, which iOS normally routes to the existing group. Tincan confirms through
     MAP/ANCS where it can. Exact text, silent, a second or two. Open questions: does a message to yourself fire the
     automation (else use a second handle on the same Apple ID); does it run while locked; do member lists always hit
     the existing group (phone vs. email handles could fork a new one); trigger messages clutter the self-thread
     and can't be deleted. Send-only: Shortcuts can't read messages or send tapbacks. Variant: the trigger only says
     "check queue" and the shortcut fetches pending sends from Tincan over the LAN, which keeps text out of the
     self-thread but breaks the Bluetooth-only model.
  2. **Siri over HFP.** Tincan connects as a hands-free unit, sends `AT+BVRA=1` to open Siri, speaks "Send a message
     to <group name> saying …" with local TTS, answers the confirmation (or relies on "Automatically Send
     Messages"), and checks Siri's reply with local STT. Only works for named groups; 5–15 s per send; may grab
     call audio; Siri's dialogue changes between iOS releases.

  Both keep the agent approval flow and go through the same outbox command so clients see one send path.

- **Rich emoji picker** (desktop composer). A button in the composer plus `:shortcode` autocomplete as you type
  (`:thu` → 👍). Search by name and keyword (CLDR annotations, e.g. emojibase data, lazy-loaded so it doesn't weigh
  on startup), categories, skin-tone choice that's remembered, recent and frequent emoji, and full keyboard
  navigation. Emoji draw with the system font (Noto Color Emoji on most distros); hide emoji newer than the font can
  show so the user never picks a tofu box. Insert-only: MAP can't send tapbacks, so the picker doesn't offer reactions.

- **Calls over HFP** (iOS supports HFP 1.7). Tincan connects as a hands-free unit, as a car kit does: incoming call
  with caller ID (`+CLIP`), answer (`ATA`), decline or hang up (`AT+CHUP`), dial (`ATD`), the call list (`AT+CLCC`),
  and the phone's signal, battery, roaming and carrier (`+CIEV`, `AT+COPS`), with call audio over SCO (mSBC wideband)
  through the laptop's microphone and speakers. A call window in the desktop app, `call.*` commands (dialling is
  `approval`), and the call history PBAP already pulls. BlueZ doesn't speak HFP itself: use PipeWire's native
  backend (`hfp_hf` role) or our own RFCOMM AT channel plus PipeWire for audio; spike which. Open questions: does
  claiming HFP pull every call's audio to the laptop (iOS routes calls to a connected hands-free unit), and can
  audio be handed back to the phone; conflicts with headsets that already use HFP; does it share the link with the
  Siri-over-HFP experiment above. Without HFP, ANCS's positive and negative actions can already answer or decline a
  call, with audio staying on the phone.
- **Use the phone's clock** (GATT Current Time Service `0x1805`, over the LE link ANCS already uses). Read Current
  Time (`0x2A2B`) and Local Time Information (`0x2A0F`, time zone and DST offset) and convert MAP timestamps, which
  are the phone's local time with no zone, with the phone's offset instead of the laptop's. Fixes wrong times when
  the two are in different zones (travel, a laptop set to UTC) and lets `doctor` warn about clock skew. Subscribe to
  changes so a zone change on the phone applies from then on; fall back to the laptop's zone when the service is
  missing. Verify on hardware that iOS exposes both characteristics to a bonded computer.

- Flatpak investigation.
- **Multi-computer sync** (e.g. the desktop runs the overnight backup sync, the laptop picks it up when it wakes).
  Builds on the sync-ready store ([ADR 0007](../decisions/0007-sync-ready-store.md)); about one to two weeks once
  backup sync exists. Start one-way: after a backup sync the desktop writes an encrypted delta (changes since the
  peer's last sequence, plus attachment blobs), and the laptop merges it on wake **before** its first Bluetooth
  catch-up, so gap markers and the coverage watermark clear there too. Merged messages count as already notified.
  Computers pair once with a code. Transport options, least to most work:
  - **A synced folder** (Syncthing, Nextcloud, Dropbox) holding encrypted deltas: almost no transport code, and it
    works even if the desktop is asleep by the time the laptop wakes.
  - **Direct over the LAN** between paired computers: no third party, but both must be awake at once.
  - **Iroh** (dial by key, NAT traversal, relays, blob transfer): works away from home too; the largest dependency.

  Two-way sync (the laptop's daytime messages back to the desktop) is the same merge in both directions, about
  three to five weeks in total. Only one computer holds the phone's Bluetooth connection at a time (`BUSY`).

- **iPhone backup sync** (opt-in; needs its own ADR and a hardware spike first). Fills the gaps MAP leaves by reading
  the iPhone's local backup, the same service Finder/iTunes use, through libimobiledevice (`idevicebackup2`). No iOS
  app is needed. Bluetooth stays the live channel; backup sync adds what MAP can't provide.
  - **What it adds:** messages sent from the iPhone itself (`is_from_me`), full history, attachments (images
    converted from HEIC), real group chats (IDs, names, members) instead of heuristics, iMessage vs. SMS, real reactions.
  - **How:** pair once over USB ("Trust This Computer" + passcode); later backups reuse the pairing record over USB
    or Wi‑Fi. iOS backs up the whole device (no Messages-only option): the first backup is large and slow, later ones
    are incremental. Tincan extracts `sms.db` (HomeDomain `Library/SMS/sms.db`) and the attachment files through
    `Manifest.db`, then deletes the rest of the backup or keeps it encrypted. Imported messages are de-duplicated
    against MAP and local ones (handle + time + text).
  - **Automation:** a daemon schedule (or systemd user timer), e.g. nightly while the phone is charging and reachable,
    at most once per ~20 h. Exposed as a normal registry command (e.g. `history.sync`, `sensitive`, long-running with
    progress events), so the CLI, MCP agents and the desktop app can start it and the agent policy governs it.
    A locked phone should work if it has been unlocked once since boot (as iTunes Wi‑Fi sync did).
  - **UX:** two layers that never compete: Bluetooth is "now", backup sync quietly fills in "before".
    - **Onboarding:** after the Bluetooth first sync and "What Tincan can't see", an optional step: "Fill in your
      history? Plug in your iPhone once." (Now / Later / No thanks). Now: Trust on the phone, then the first backup
      runs in the background with progress in the status bar; Tincan stays usable. "Sync overnight while charging" is on
      by default.
    - **Backfill:** one quiet summary after a sync ("Filled in 23 messages, 4 photos and 12 of your replies"), never a
      notification per message. Backfilled messages slot in by time and arrive **already read** (unread counts never
      jump). They upgrade in place: attachment placeholders become images, heuristic groups become real ones (ask once
      before merging), messages gain iMessage vs. SMS. Scroll position never jumps; a reader sees a "new earlier
      messages" pill instead. Gaps that a sync covers are cleared.
    - **Coverage watermark:** each thread records "complete up to the last sync (2:00 AM)". Before it, no "sent from
      iPhone not shown" hints, gap markers or history-start marker; after it, one subtle line: "Replies you sent from
      your iPhone since 2:00 AM appear after the next sync." `thread.get` returns the watermark so agents know when a
      thread may be incomplete.
    - **Needs attention** (status bar, one item at a time, never blocking): passcode needed ("Unlock your iPhone and tap
      Sync now"), trust lost ("Plug in once to reconnect history sync"), low disk ("Sync paused · free up space or
      delete stored backups").
    - **Settings ▸ History:** last and next sync, Sync now, schedule, storage used, keep or delete raw backups, forget
      this iPhone.
    - **Manual backfill:** always one click away, and all entry points run the same `history.sync` command.
      - **Persistent:** a history item in the status bar ("History synced 2:00 AM · **Sync now**"), the command
        palette ("Sync history now"), and the conversation header menu.
      - **In context:** a **Fill in now** button on every gap marker, and on the history-start marker and coverage
        watermark line.
      - **States** (the same on every entry point): not set up → "Set up history sync" (opens the onboarding step);
        iPhone not reachable over USB or Wi‑Fi → disabled with "Plug in your iPhone or join the same Wi‑Fi";
        running → inline progress ("Filling in… 40%"), and clicking again only shows the progress (one sync at a
        time); passcode needed → "Unlock your iPhone to continue"; done → the marker disappears as the messages
        slot in, or shows "Nothing more to fill in" if the backup didn't cover that time.
  - **Open questions for the spike:**
    1. Does iOS ask for the passcode on the phone each time a backup starts (especially encrypted backups)? If so,
       unattended overnight sync isn't possible.
    2. Does a backup started over Wi‑Fi with the phone locked succeed? How mature is Wi‑Fi support on Linux
       (`netmuxd` or similar) compared with USB?
    3. How do Messages in iCloud, "Optimize storage" and "Keep messages for 30 days" affect what a local backup
       contains? **Likely blocker:** Apple says computer backups leave out "data already synced and stored in iCloud,
       like … iMessages, and SMS and MMS messages" ([support.apple.com/108771](https://support.apple.com/en-us/108771)),
       so with Messages in iCloud on (the default for most users) `sms.db` may be missing or stale. Test this first;
       if it holds, backup sync only helps users who turn Messages in iCloud off.
    4. The laptop must be awake: plugged in and awake, a wake timer (systemd `WakeSystem=`), or a user-chosen time.
    5. How often does trust get lost (untrusting, privacy reset, iOS updates)? Tincan must detect it and prompt to re-pair over USB.
  - **Costs and risks:** Tincan holds a full phone backup and possibly the backup encryption password (keyring only);
    the `sms.db` schema changes between iOS releases, and newer releases store message text in `attributedBody`
    (a binary NSAttributedString) that needs its own parser; libimobiledevice sometimes lags new iOS releases; new
    system dependencies (libimobiledevice, usbmuxd).

---

## 8. Risks and mitigations

| Risk                                                  | Impact                              | Mitigation                                                                                               |
| ----------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| An iOS update changes MAP/ANCS behaviour              | Features break                      | Fixtures from real phones, the hardware checklist on each iOS release, `doctor` that detects the problem |
| Bluetooth adapter/driver differences                  | Pairing or LE issues                | Adapter information in `doctor`, a list of known-good adapters, BlueZ minimum version                    |
| Only one MAP session per phone                        | `BUSY` when another client holds it | Clear status + `doctor` hint; release the session on shutdown                                            |
| Native crash takes down the daemon                    | Missed messages                     | Catch panics, systemd `Restart=on-failure`, full re-sync after reconnect                                 |
| Electron as an always-on daemon is heavy              | Memory use                          | Measured in Phase 0: about 81 MB with `ELECTRON_RUN_AS_NODE`, 24 MB on system Node                       |
| Agent sends something wrong, or a message tells it to | Embarrassing or harmful send        | Approval gate on by default, untrusted-content guidance, approval queue shows the full text              |
| Privacy leaks through logs or diagnostics             | Exposure                            | Redaction by default in Rust and TypeScript, redacted diagnostic bundle, encrypted store                 |
| Apple trademark                                       | Naming trouble                      | Never use "iMessage" in the product name or icon; describe it as "works with iPhone messages"            |

---

## 9. Initial milestones (completed)

1. **Spike A (Rust):** napi-rs addon that opens a MAP session to a paired iPhone and prints new messages (Phase 0.1–0.2).
2. **Spike B (Rust):** SQLCipher vault + Secret Service key round trip (Phase 0.3).
3. **Scaffold:** monorepo + CI with `protocol` envelope and the `commands` contract (Phase 1).
4. **Parsers & fixtures:** bMessage/vCard parsers and fixtures in `tincan-bt` with tests.
5. **Core & surfaces:** sync engine, encrypted store, CLI, MCP server, and Electron desktop app.

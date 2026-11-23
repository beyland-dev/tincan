# Architecture

How Tincan is put together today. What's next is in [roadmap.md](roadmap.md) and the original design in
[history/plan.md](history/plan.md); the Rust layer is described in [native.md](native.md); decisions are
recorded in [decisions/](decisions/).

## Process model

```
 iPhone ──Bluetooth──▶ bluetoothd (system bus) ──▶ obexd (session bus)
                                │                       │
                                └──────── D-Bus ────────┘
                                            │
              ┌─────────────── tincan daemon (one per user) ───────────────┐
              │  @beyland/tincan-native  (napi over tincan-bt + tincan-vault)   │
              │             │ napi (promises, ThreadsafeFunction events)  │
              │  @beyland/tincan-core    (registry, policy, events, …)      │
              │             │                                             │
              │  socket server  $XDG_RUNTIME_DIR/tincan/tincan.sock (NDJSON)  │
              └──────────────────────────▲────────────────────────────────┘
                                         │
               ┌─────────────────────────┼──────────────────────────┐
           tincan CLI                 tincan mcp                 desktop app
              └──────────── @beyland/tincan-client + @beyland/tincan-protocol ┘
```

- **One daemon per user**, normally run by systemd (`packaging/systemd/tincan.service`). It owns all
  state: the Bluetooth sessions, the encrypted message store, settings and the event bus. It keeps running
  when no client is connected, so messages arrive and notifications show with the app closed.
- **A single-instance lock** (`tincan.lock`, holding the pid) sits next to the socket. A lock whose
  pid is dead is replaced; a live one makes a second daemon fail with `BUSY`. A stale lock is only
  replaced (and a daemon's own lock only removed) while holding a takeover token
  (`tincan.lock.takeover.<n>`), so of several daemons racing for a stale lock exactly one wins.
- **The runtime directory** must be a directory owned by the user with mode `0700`; the daemon
  refuses to start otherwise. The socket is `0600`. The same folder (in RAM) holds Bluetooth
  transfers and short-lived notification icons; everything else, contact photos included, is in
  the encrypted store. `$TINCAN_SOCKET` (or `--socket`) overrides the
  path, which is how tests and development run isolated daemons.
- **Clients are thin.** The CLI, the MCP server and the desktop renderer depend only on
  `@beyland/tincan-protocol` and `@beyland/tincan-client`. They never import `core`, `daemon` or
  `native`, so they load without Rust or Bluetooth.
- The daemon loads the addon at runtime as an optional dependency. If it's missing, the daemon
  still runs and `tincan status` reports `Native: unavailable`.

## Data flow

Inbound (a new message):

1. The phone notifies obexd's MAP Notification Server (MNS); obexd emits a D-Bus signal.
2. `tincan-bt` (Rust, zbus) receives it, fetches the message over OBEX, and parses the bMessage.
3. `tincan-napi` hands the parsed value to JS through a `ThreadsafeFunction` callback.
4. `tincan-core` stores it, keys it to a thread, and emits `message.changed` / `thread.changed`.
5. The daemon writes the event to every connection that called `events.subscribe`; clients
   refetch what they show.

Outbound (a request): client → NDJSON request → daemon → `core.run(method, params, client)` →
registry (policy, input validation) → handler → native call if needed → validated output →
NDJSON response.

Events are **coarse**: they say _what changed_ (ids, keys), not the new data. Clients refetch
through queries, so there's a single read path and no event-ordering bugs in the UI.

## Wire protocol

One JSON object per line over the Unix socket ([`envelope.ts`](../packages/protocol/src/envelope.ts)).

| Direction | Shape                                                                     |
| --------- | ------------------------------------------------------------------------- |
| server →  | `{ "hello": { protocolVersion, server: {name, version}, methods } }` once |
| → server  | `{ "id", "method", "params"?, "client": { "kind", "name" } }`             |
| server →  | `{ "id", "result" }` or `{ "id", "error": { code, message, details? } }`  |
| server →  | `{ "event", "seq", "data" }` after `events.subscribe`                     |

- `PROTOCOL_VERSION` is checked by the client against the hello; a mismatch is `PROTOCOL_MISMATCH`.
- Lines over 4 MiB drop the connection. Subscribers more than 16 MiB behind are disconnected.
- `events.subscribe` / `events.unsubscribe` are transport methods, not commands.
- `client.kind` (`cli | mcp | desktop`) is self-declared; see the policy note below.

## Contracts and the registry

`@beyland/tincan-protocol` is the single source of truth for the API. Each command is a **contract**
(`defineContract`): a dotted `name`, `title`, `description`, `kind` (`query | mutation`), zod
`input` and `output`, plus metadata:

| Field         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `positional`  | Input keys the CLI takes as positional arguments                      |
| `internal`    | Only the desktop app or the CLI may call it; never offered to agents  |
| `sensitive`   | Returns personal data; MCP frames it as untrusted                     |
| `agentScope`  | Which agent setting gates it: `read`, `drafts`, `manage`, `ownDrafts` |
| `approval`    | `agent`: `agents.send` decides whether an agent's call goes or queues |
| `destructive` | Deletes something the user can't get back (MCP `destructiveHint`)     |

`@beyland/tincan-core` binds handlers to contracts with `registry.implement(contract, handler)`.
`registry.run` does, in order:

1. look the command up (`NOT_FOUND`);
2. `authorize` the caller against the contract flags and settings (`PERMISSION_DENIED`). For agents
   the settings apply as `agents.access` caps them (`effectiveAgents`, exposed as `core.agents`),
   and every agent check in core and the daemon's event filter reads that, never
   `settings.agents` directly;
3. parse the input with zod (`INVALID_INPUT`, with the issues in `details`);
4. for an agent's `message.send`, decide with the send policy whether it goes or becomes an agent
   draft (`context.agentSend`), and reserve its rate-limit slots (a queued send counts too);
5. run the handler (it never waits for the user);
6. parse the output against the contract (`INTERNAL` if a handler breaks its own contract).

Every surface is generated from the same contracts: the CLI's subcommands and flags,
`tincan commands` and `tincan schema` (JSON Schema for input and output), the MCP tools
(`readOnlyHint` from `kind`, `destructiveHint` from `destructive`), and the desktop API.

## Agent drafts and send delays

Every message an agent writes that needs the user is an **agent draft** (`AgentDraft`, the local
`agent_drafts` table, never synced): an agent's `message.send` the send policy doesn't let go, or
any agent `message.draft.save`. Drafts queue per recipient (the `tel:`/`email:` key, which is the
conversation's key once there is one) and never expire; the desktop app shows them in the
composer beside the user's own draft, which stays in `drafts`. A direct agent send gets a draft
too (`intent: "send"`, already `scheduled`), so agents follow every outcome the same way with
`draft.get`. Core's `drafts.ts` keeps a draft's state in step with its message (`scheduled` →
`sent`/`failed`, or back to `queued`/`cancelled` when the message is taken back) and presents
drafts to agents.

Send delays live in the daemon's **outbox**. A message with a delay is stored `scheduled`, sorted
at its `sendAt` (`outbox.send_at`), with a timer outside the outbox's serial send queue, so a
message without a delay never waits behind one. When the timer fires the message becomes `pending`
in one transaction (re-stamped with the real send time, which also restarts the offline hold) and
goes as any other send. A timer that fires more than 15 s late, and an overdue message found at
start-up, doesn't send (`STALE_SEND_MS`). `message.cancel` deletes a message that hasn't reached
the phone; `message.sendNow` skips the rest of the delay. Agents' messages, and drafts the user
sends, use `agents.sendDelaySeconds`; everything else uses `sendDelaySeconds`.

**The agent policy is a usability control, not a security boundary.** Anything that can reach the
socket runs as the user and can claim any `client.kind`. The policy stops agents from making
mistakes; it doesn't stop malware. The access levels (`off`, `readOnly`, `assistant`, `full`) and
what each enforces are in [security.md](security.md#ai-agents-mcp).

## Errors

Errors cross every boundary as a code plus a human message:

| Code                | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `NOT_FOUND`         | Unknown command, thread, message, object or SDP record                |
| `INVALID_INPUT`     | Input failed validation, or bad arguments to native code              |
| `CONFLICT`          | State conflict (e.g. a non-socket file where the socket goes)         |
| `NOT_CONNECTED`     | No phone, or BlueZ/obexd/the bus is unavailable                       |
| `BUSY`              | Another daemon, or another computer, holds the resource (MAP session) |
| `PERMISSION_DENIED` | The phone, the OS or the agent policy refused                         |
| `TIMEOUT`           | A request, transfer or D-Bus call took too long                       |
| `PROTOCOL_MISMATCH` | Client and daemon speak different protocol versions                   |
| `INTERNAL`          | Anything else, including a Rust panic                                 |

- TypeScript throws `TincanError(code, message, details?)`; the daemon serialises it with
  `toWireError`, and the client rebuilds it with `TincanError.fromWire`. Anything that isn't a
  `TincanError` becomes `INTERNAL`.
- Rust uses `tincan_bt::Error` with the same codes. `classify_dbus_error` maps D-Bus error names
  (and OBEX status text) onto them. At the napi boundary every export runs in `catch_unwind`, and
  failures reject with a JS `Error` whose `code` is the code string. See
  [native.md § Error mapping](native.md#error-mapping).

## Privacy

- Message text, phone numbers and contact names are never logged, in TypeScript or Rust. Logs
  carry ids and counts.
- Fixtures are synthetic (555 numbers, made-up names).
- The message store is SQLCipher with its key in Secret Service (falling back to a `0600` key file when no keyring is available).
- For MCP agents, real handles are masked behind opaque IDs (`agents.handles: hidden`) and one-time verification codes / short-code senders are hidden (`agents.hideCodes: true`) by default. See [security.md](security.md).
- The CLI's human output names people and conversations (`Thread.title`, contact names from one
  batched `contact.list` per run, group names) and formats numbers without a contact, so it's safe
  on a shared screen; thread keys, handles and Bluetooth addresses appear only with `--verbose`
  or `--json`. In an agent's shell the CLI gets masked results like any agent and only matches
  opaque `handle:` IDs against names, never back to numbers. Conversation arguments accept contact
  and group names (`resolveThreadTarget`, `resolveGroupTarget`).
- The user hides **people** from agents (`agents.hide`, `agents.show`, `agents.hidden`, all
  internal). A person is a row in the local `agent_hidden_people` (a UUIDv7, the contact it follows
  or null, a label) with its handles in `agent_hidden_handles` (`contact` or `manual`). PBAP has no
  stable contact id (`contacts.id` hashes the card), so a person is anchored on handles: a handle is
  hidden iff it's in `agent_hidden_handles`, and `Store.replaceContacts` ends by reconciling,
  fail-closed (a live card sharing a hidden handle joins that person with all its handles, merging
  people; a deleted card unlinks, keeping label and handles; nothing is ever unhidden). Group
  conversations can also be hidden themselves (`threads.agent_hidden`, now only for groups); a group
  is hidden when that's set or any member or roster handle is hidden (`agentHiddenSql` in the
  store, also for keys with no conversation). `Core.agentThreadAccess` refuses hidden conversations
  (as `NOT_FOUND`, like out-of-scope ones), the store's agent list, search and contact queries leave
  them out (`excludeAgentHidden`), name lookups don't find hidden contacts, and agent sends to them
  always become drafts (`note: "hidden"`), even with Full access. Hiding takes back agents' pending
  direct sends to them as drafts. `Thread.hiddenFromAgents`, `hiddenBy` and `hiddenPerson`, and
  `Contact.hiddenFromAgents`, reach only the desktop app and CLI. The `threads.hidden` column
  now only keeps an empty conversation, left behind when its messages move to a group, out of the
  list until its next message.

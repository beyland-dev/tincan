# Native layer: Phase 0 lab notes

> **Historical document.** Findings from the first hardware spikes (October and November 2026), kept for
> context. They describe one development laptop and one iPhone and are not kept up to date. The current
> native layer is described in [native.md](../native.md).

## Probe run (Phase 0, 2026-10-31)

`cargo run -p tincan-bt --example probe` against a development laptop. Addresses and device names are
replaced with placeholders.

- **Adapter** `hci0` (`AA:BB:CC:DD:EE:FF`):
  - powered, discoverable, not pairable;
  - Class of Device `0x7c010c` (computer/laptop with service bits set).
- **iPhone** (test device):
  - paired, bonded, trusted and **connected**;
  - icon `phone`, a modalias with Apple's vendor ID (`bluetooth:v004Cp…`), so `isIphone` is true.
- **UUIDs advertised:** MAP MSE `0x1132` and MAP MNS `0x1133` (`supportsMap`), PBAP PSE `0x112f`
  (`supportsPbap`), ANCS (`supportsAncs`), HFP AG `0x111f`, A2DP source, and others.
- `bluetoothSnapshot()` through the addon returned the same data.
- **Conclusion:** the adapter and phone side are ready for MAP/PBAP once no other MAP client holds the session.

### Vault (Phase 0.3, 2026-10-31)

`cargo run -p tincan-vault --example vault_spike` on the development laptop (Fedora Atomic, GNOME
Keyring, x86_64):

- **SQLCipher 4.19.0 community** through rusqlite 0.41 `bundled-sqlcipher`. It links the system
  `libcrypto.so.3` (OpenSSL 3.5). FTS5 is available.
- **The key round-trips through GNOME Keyring:** created and stored in about 7 ms, reloaded in about
  2 ms. The `login` collection was already unlocked, so no prompt appeared. The test item was deleted
  afterwards.
- **Encryption at rest:** the database is mode 0600 in a 0700 directory and has no `SQLite format 3`
  header. A wrong key is rejected at open with `PERMISSION_DENIED`.
- **Performance:** 1000 inserts plus FTS rows in one transaction take about 7–9 ms; an FTS `MATCH` takes
  well under 1 ms.
- **Not yet verified:** an aarch64 build.

The rules the vault follows are in [native.md § Vault rules](../native.md#vault-rules).

### Addon in Node and Electron (Phase 0.2 and 0.4, 2026-10-31)

`pnpm build:native` built `tincan-native.linux-x64-gnu.node` (1.6 MB). The same script was then loaded
in three runtimes, ran `buildBMessage` → `parseBMessage` with a synthetic 555 number and called
`bluetoothSnapshot()` (read-only). Memory is the PSS of the whole process tree after about 6 s idle.

| Runtime                                                | Node    | Loads | Snapshot            | Processes | PSS        |
| ------------------------------------------------------ | ------- | ----- | ------------------- | --------- | ---------- |
| System Node                                            | 24.18.0 | yes   | 1 adapter, 1 device | 1         | **24 MB**  |
| Electron 45.2.1, `ELECTRON_RUN_AS_NODE=1`              | 24.22.1 | yes   | 1 adapter, 1 device | 1         | **81 MB**  |
| Electron 45.2.1 main, no window, GPU disabled          | 24.22.1 | yes   | 1 adapter, 1 device | 7         | **173 MB** |
| Same, plus `--in-process-gpu --no-zygote --no-sandbox` | 24.22.1 | yes   | 1 adapter, 1 device | 2         | 136 MB     |

- The addon (N-API 10) loads unchanged in every runtime; no Electron rebuild is needed.
- A windowless Electron main still starts the GPU, network-service and zygote processes. Trimming them
  with flags saves little and drops the sandbox.
- **Decision:** the daemon never runs as an Electron main process. From the AppImage it runs the bundled
  Electron binary with `ELECTRON_RUN_AS_NODE=1`, which costs about 81 MB. The npm CLI runs it under system Node,
  which costs about 24 MB. The packaged app must keep the `runAsNode` fuse enabled.
- Load the ESM `index.js` with dynamic `import()` from a CommonJS Electron entry. Top-level awaiting
  `app.whenReady()` in an ESM main entry hung on Electron 45.
- **Not yet verified:** loading from inside a packaged AppImage (there is no desktop app yet).

### Device class (Phase 0.5, 2026-10-31)

iOS only offers **Show Message Notifications** and **Sync Contacts** to a computer whose Class of Device
is Audio/Video Hands-Free (major 4, minor 8: `Class & 0x1ffc == 0x0408`). With any other class, iOS
refuses the MAP and PBAP SDP lookups, and obexd reports "Unable to find service record" or
"Connection refused (111)". Permissions that are already granted survive a later class change.

`main.conf` `Class=` is **not enough** on its own:

- BlueZ's `hostname` plugin calls `btd_adapter_set_class` with a class derived from hostnamed's
  chassis, or `/sys/class/dmi/id/chassis_type` without hostnamed. Every chassis maps to major class
  Computer. This overrides `main.conf` when the adapter is probed and whenever the hostname changes.
- `btd_adapter_set_class` returns early when the value is unchanged, so a class set later through mgmt
  stays until bluetoothd restarts or the adapter is re-probed.
- The development laptop's adapter reports `0x7c010c` (Computer/Laptop); an already-paired phone keeps
  working only because permissions were granted earlier under the hands-free class.

Fixes, both privileged:

1. A oneshot unit, `PartOf=bluetooth.service` / `After=bluetooth.service`, that runs `btmgmt class 4 8`
   and reads the class back with a retry (`tincan-btclass@.service`).
2. Start bluetoothd with `--noplugin=hostname` and set `Class = 0x000408` in `main.conf`. This also
   drops the pretty-hostname sync.

**Decision:** `system-setup` installs a oneshot unit (option 1). It survives distro `main.conf` and unit
updates and doesn't touch other plugins. The daemon can't set the class itself: `Adapter1.Class`
is read-only over D-Bus, and mgmt needs `CAP_NET_ADMIN`. `doctor` reads the class and reports `fail`
with the fix when it isn't `0x0408` at onboarding. After the permissions are granted it reports `warn`.

Related setup that `doctor` should check, from the same notes:

- ANCS needs bluetoothd `--experimental` (or `Experimental = true`) **before** pairing.
- The kernel option `bluetooth.disable_ertm=1` breaks obexd.
- The adapter must be pairable for connect-first pairing.

**Recovering a refusing iPhone (2026-11):** after Tincan was forgotten and re-paired, MAP opens kept failing with
"Unable to find service record" (`NOT_FOUND`) even with the class right and Show Message Notifications on, and the
iPhone answered "Pairing Unsuccessful" when picked from its own Bluetooth list. What fixed it: forget the pairing on
both sides, **restart the iPhone**, then pair from Tincan with the computer discoverable. iOS seems to cache a
refused SDP answer per peer until it restarts. Tincan now reports such a phone as `refused` after three `NOT_FOUND`
opens, walks through these steps in its Fix connection dialog, and keeps a connection history for diagnostics.

### MAP (Phase 0.1, 2026-10-31)

`cargo run -p tincan-bt --example map_spike` against a paired iPhone (iOS) with no other MAP client
holding the session. Output is redacted; no message content was recorded.

**What works**

- **Session:** `CreateSession` (Target `map`) and `SetFolder("/telecom/msg")` take 0.9–2.7 s.
  `SupportedTypes` is `["SMS_GSM"]` only. Every test message was an iMessage (blue) and was listed,
  reported and downloaded as `SMS_GSM`, so MAP can't tell iMessage from SMS.
- **Folders:** `inbox`, `sent`, `outbox`, `deleted`.
- **Listing:** 10–90 ms per folder. Every entry has a handle (a decimal number up to 19 digits), folder,
  `Type` `sms-gsm`, `Status` `complete`, `Read`, `Sender`/`SenderAddress` (a bare number, no `+`),
  `Subject` (the start of the body) and `Size`. `Recipient`, `ReplyTo` and `AttachmentSize` are empty.
  Listings are newest first. The `Read=false` filter works.
- **Timestamps** are `YYYYMMDDTHHMMSS` in the phone's local time with no zone suffix;
  `parse_map_timestamp` converts them with the laptop's zone, which is right while the two agree.
- **GetMessage:** 10–280 ms for 400–600 byte bMessages. Every one parsed: version `1.0`, type
  `SMS_GSM`, charset `UTF-8`, one body part, originator with `TEL` and `N`/`FN`, no recipients.
  **Downloading doesn't mark a message read** (probe: unread before and after `Get`).
- **MNS events:** the phone opens its MNS connection (an obexd server session with target
  `bb582b41-…`) as soon as the MAP session registers, and **`NewMessage` reports arrive live**:
  seven test texts each produced `InterfacesAdded` (folder, type) then `Status` `notification`.
  The bMessage can be fetched straight away. obexd also emits `InterfacesAdded` and `Status`
  `complete` for every object a listing creates, so the new-message signal is the `notification`
  status, not `MessageAdded`.
- `UpdateInbox` succeeds (about 50 ms) and has no visible effect.
- **PushMessage:** one test message to the user's own number, pushed to `outbox` relative to
  `/telecom/msg` with `Charset` `utf8`. The transfer completed in 212 ms (`PushOutcome::Accepted`) and
  the message was delivered, as an iMessage (blue): iOS chooses iMessage or SMS itself. Because it went to the user's own number it also came back as a
  `NewMessage` 2.1 s later. **No `SendingSuccess` or `DeliverySuccess` report arrived**, and the pushed
  message never appeared in `sent` or `outbox`. A completed transfer is the only confirmation.

**Limits**

- **The inbox exposes only the 10 most recent messages**, whatever `MaxCount` asks for. Older ones
  drop out of listings as new ones arrive. Tincan keeps history itself from the moment it first sees a
  message; there's no deeper backfill.
- **`sent`, `outbox` and `deleted` are always empty.** Messages sent from the phone aren't visible;
  only messages pushed by Tincan can show as sent.
- **No read-status events.** Messages read on the phone during a watch produced no event; the
  change only showed on the next listing.
- Opening a session once failed with `org.bluez.obex.Error.Failed: Internal Server Error` shortly
  after the previous session closed, while the phone's MNS session was still up. The retry worked.

**Not yet tested:** push failures (no signal, invalid number), multi-recipient pushes, `SetMessageRead`, `MessageDeleted`/`MessageShift` reports, attachments, and long or non-ASCII bodies.

### PBAP (Phase 0.1, 2026-10-31)

`cargo run -p tincan-bt --example pbap_spike` against the same iPhone, read-only. Output is redacted to
counts, timings and field presence; no names or numbers were recorded.

- **Session:** `CreateSession` (Target `pbap`) took 0.4 s. iOS shared contacts without a prompt;
  the pairing already allowed it.
- **Every phonebook is there:** `pb` (460 entries), `fav` (9), and `ich`, `och`, `mch` and `cch`
  (100 each). **iOS caps call history at 100 entries per list.** Each phonebook reports
  `Folder`, `DatabaseIdentifier` and both version counters (32 hex characters each), so
  `version()` can tell when contacts changed without pulling them.
- **Pulls:** all 460 contacts in 1.1 s, in either vCard 3.0 or 2.1 (identical content). `Offset`
  and `MaxCount` paging works. With `PHOTO`, the pull took 7.8 s and returned 58 JPEG photos
  (about 1 MB of base64): pull without photos first, and photos separately.
- **Cards:** every one parsed. Entry 0 is the phone owner's own card. 458 of 460 have a name, 422 a phone
  number, 131 an email. Phone types are `cell`, `home`, `work` and `pref`; 125 numbers have no type,
  probably because iOS puts their custom label in an `itemN.X-ABLabel` line, which the parser
  ignores.
- **`fav`** returns full cards for the favourites (marked `favorite` by `pull`).
- **Call history:** every entry has a number, the call type (`RECEIVED`, `DIALED` or `MISSED`;
  `cch` mixes them) and a `YYYYMMDDTHHMMSS` local time. iOS fills in the name and emails from
  the contact; unknown callers have no name.

**Not yet tested:** whether the version counters change after a contact edit, phones without Sync
Contacts allowed, and a contact list large enough to need paging.

### ANCS (Phase 0.1, 2026-11-01)

`AncsSession` from Node against the same iPhone, over the bonded LE link with bluetoothd
`--experimental`. Output was redacted to states, uids, app ids, categories, flags, field lengths and
ages; no titles or bodies were recorded. Three runs: 10 minutes, then 40 s and 30 s with debug logs.

- **Startup:** `waiting` (the Share System Notifications hint) shows for 0.1–0.6 s on every start,
  until the probe is answered, then `ready`. Consumers should wait 2–3 s in `waiting` before showing
  the hint.
- **Delivery:** live notifications arrived and were removed: Reminders (`schedule`), an incoming
  call (`incomingCall`, important, positive and negative actions), missed calls, voicemail and
  Messages (`social`, negative action only). Clearing about 22 notifications on the phone gave a
  removal for each. `received` is right: live items were 1–5 s old.
- **Reconnect:** the phone dropped the LE link at 325 s (`unavailable`, `NOT_CONNECTED`) and came
  back at 379 s; the session went `waiting` then `ready` and replayed the backlog as `preExisting`,
  under new uids.
- **Re-posts:** after the reconnect, iOS re-posted a missed call from 13 hours earlier as a new
  notification without the PreExisting flag (it removed the old uid and grouped it under a new
  one). Desktop notifications should skip anything whose `received` is more than about 2 minutes
  old.
- **Bug found and fixed:** the first run delivered only 3 of the 22 notifications already on the
  phone. When a request failed (a timeout or a malformed answer), the next request went out at once,
  and the failed response's remaining fragments, or a late answer, were parsed as the answer to the
  next request. That one was then dropped for its uid, and every later response stayed one behind
  until the queue drained. The assembler now matches each response on its echoed header (command
  plus uid, or command plus app id) and drops fragments that don't match. With the fix, all 7
  notifications on the phone came through. What made the first request fail wasn't caught; the
  debug log now records the reason.

**Not yet tested:** `performAction` on a real notification, a phone with Share System Notifications
off, and very large backlogs (more than 32 notifications).

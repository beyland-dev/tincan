# Roadmap

Tincan is in early, alpha releases. This page describes what works today, what's being worked on, and
what Tincan deliberately won't do. Plans change; [open an issue](https://github.com/beyland-dev/tincan/issues)
if something here matters to you. The original design document is kept in
[history/plan.md](history/plan.md).

## Working today

- **Messaging over Bluetooth:** incoming iMessage and SMS text, replies and new 1:1 conversations,
  read and unread state synced with the iPhone, send status with retry, and automatic reconnects after
  sleep or the phone leaving range.
- **Contacts:** names and photos from the iPhone's address book.
- **Desktop app:** conversation list and view, search, drafts, tapbacks shown on their message,
  best-effort group chats, pin and mute, hiding conversations from agents, a command palette,
  eighteen themes, desktop notifications with one-click code copy, optional link previews, guided
  pairing and a Fix connection flow.
- **Background service:** a systemd user service so messages and notifications arrive with the window
  closed.
- **Command line:** the `tincan` command, generated from the same typed commands the app uses, with
  JSON output and JSON Schemas.
- **AI agents:** an MCP server (`tincan mcp`) and one-command setup for common agent apps, with agent
  access off by default, access levels, agent drafts in the composer for you to send, edit or discard,
  hidden phone numbers and verification codes, and rate limits. The CLI follows the agent settings
  when it runs in an agent's shell.
- **Send delays:** an optional undo window before a message goes to the iPhone, on by default (10
  seconds) for agents' messages.
- **Privacy:** an encrypted local database with its key in the desktop keyring, no network port, no
  Tincan server, and no message content in logs.
- **Packaging:** `.deb` and AppImage for x86_64 and arm64, and the CLI on npm, with checksums and
  build attestations.

## Next

Roughly in order, and subject to change:

- **Hardening for 1.0:** more adapters (Intel, Realtek, MediaTek) and iOS versions on the
  [hardware checklist](hardware-checklist.md), edge cases (phone restarts, adapter unplugged, very
  large stores), and performance on large message stores.
- **Use the phone's clock** over Bluetooth LE, so message times are right when the phone and computer
  are in different time zones.
- **Inline reply from notifications**, where the desktop supports it.
- **Message export** (JSON and Markdown) and per-conversation notification rules.
- **Better group chats** and tapback detection in more languages.
- **RCS:** check whether the iPhone relays RCS conversations over Bluetooth, and label them if so.

## Exploring

Ideas that need a spike before any commitment:

- **Sending to group chats**, which Bluetooth MAP can't do directly (for example through a Shortcuts
  relay on the iPhone).
- **Calls** over the hands-free profile.
- **Filling in history** (attachments, messages sent from the iPhone, full history) from a local iPhone
  backup. iOS may leave Messages out of backups when Messages in iCloud is on, which could rule this
  out.
- **Several phones** paired with one computer.
- **Flatpak**, if the Bluetooth system setup can be handled cleanly from a sandbox.

### Messages from anywhere: an always-on hub

The idea: keep an old iPhone, signed in to your Apple ID with iMessage on, next to an always-on Linux
computer running Tincan. That computer becomes a **hub**, and your other computers reach your messages
through it from anywhere, whether or not your main iPhone is nearby. Tincan still talks to the phone only
over Bluetooth; the new part is computers syncing with each other.

**The spike that decides it.** Before anything else, check with real hardware that a second iPhone can
stand in for you:

- iMessages to your number arrive on it (Settings › Messages › Send & Receive) and reach Tincan over
  MAP and ANCS like the phone's own messages.
- SMS reach it through Text Message Forwarding from your main iPhone (Apple documents forwarding to
  iPads and Macs; a second iPhone may not be offered).
- Messages Tincan sends through it go out from your number, not the old phone's.

If that holds, the rest is engineering on top of the
[sync-ready store](decisions/0007-sync-ready-store.md).

**Shape: one hub, several spokes.**

- The hub is the only computer that talks to the phone. It also owns the outbox, send delays and the
  agent policy, so there's one source of truth for what gets sent.
- Spokes (your laptop and other computers) keep a synced copy of messages, so reading and search work
  offline. Sending from a spoke asks the hub to send. Read, mute and pin sync last-writer-wins, as the
  store already allows; drafts and settings stay per computer.

**Transport: [iroh](https://iroh.computer).** Encrypted peer-to-peer connections between paired
computers, with no account and no Tincan server. It's open-source Rust, which fits the native layer.
Computers connect directly when they can (including through most home routers); when they can't,
traffic goes through a relay that only sees encrypted data. Out of the box that's n0's free public
relays, with a setting for your own relay (a small server running iroh's open-source relay) or a paid
one. n0 describes its public relays as meant for development and testing, so check with n0 whether an
open-source app used by individuals can rely on them before shipping.

**What has to be solved first.**

- **A new threat model.** Today anything that can reach the daemon's local socket is you. Remote access
  needs real device pairing (a code or QR), removing a device you've lost, end-to-end encryption between
  your computers, and a decision on how the agent settings apply to each spoke. This needs its own
  security review before it ships.
- **Running unattended:** reconnecting to the phone after drops, updates and restarts for weeks at a
  time; keeping the old phone on its charger safely (Optimized Battery Charging); and telling you when
  the hub loses the phone.
- **The same Bluetooth limits as today.** No sending to group chats, no attachments, no typing
  indicators or read receipts, and only the history the phone shares.
- **Agents on an always-on hub** that can text as you raise the stakes on prompt injection; access levels
  and send delays matter even more here.

**Steps:**

1. The hardware spike above.
2. A prototype: a spoke that reads and sends through the hub, with no local copy.
3. Sync over iroh: pairing, a synced copy on each spoke, sends forwarded to the hub, then a security
   review.

Reaching the hub from a phone would need a separate mobile app; that's out of scope for now.

## Not planned

- An iOS app, or any Wi-Fi or cloud relay to the phone. Tincan talks to the iPhone over Bluetooth only.
  (Computers syncing with each other, as in the [hub idea](#messages-from-anywhere-an-always-on-hub), is
  separate.)
- macOS or Windows. Tincan is built on Linux's BlueZ stack.
- File transfer, clipboard sharing, AirPods or audio routing.
- Anything that needs an Apple account, a Mac or a jailbreak.
- Features Bluetooth can't carry: photos and attachments, typing indicators, read receipts, edits,
  unsend and effects (see [What works](../README.md#what-works-and-what-doesnt)).

# Changelog

All notable changes to Tincan are documented in this file. Tincan follows
[Semantic Versioning](https://semver.org/); during 0.x, minor releases may include breaking changes.

## [Unreleased]

## [0.1.2] - 2026-11-25

### Fixed

- Background systemd user service installed from an AppImage now sets `APPIMAGE_EXTRACT_AND_RUN=1`
  (while keeping `NoNewPrivileges=yes`), fixing startup failures (`Cannot mount AppImage, please
  check your FUSE setup`) caused by systemd's user-namespace sandboxing blocking setuid
  `fusermount3`.

## [0.1.1] - 2026-11-24

### Fixed

- Desktop `.AppImage` and `.deb` packages now include the bundled daemon's `node_modules` directory
  (including `@beyland/*` workspace packages and the native Bluetooth/SQLCipher addon), which
  `electron-builder` previously excluded by default.
- Release workflow no longer fails when optional GPG signing (`SHA256SUMS.asc`) is unconfigured.

## [0.1.0] - 2026-11-23

The first public release.

### Highlights

- iMessage and SMS from your iPhone on Linux, over Bluetooth: no Mac, no jailbreak, no iPhone app.
- Everything stays on your computer, in an encrypted database. No account, server or telemetry.
- A desktop app, the `tincan` CLI and an MCP server for AI agents, all driving one local daemon.
- Opt-in AI agent access with access levels, agent drafts you review, send delays and redaction.

### Desktop app

- Conversations with contact names and photos, read/unread sync with the phone, pin and mute,
  replies and new one-to-one messages, with send status and retry.
- Full-text search, a saved draft per conversation ("Draft: …" in the list), and tapbacks.
- Link previews, off by default: HTTPS only, loaded automatically only in conversations with saved
  contacts or people you've replied to (click to load elsewhere).
- Light, dark and system appearance plus a set of colour themes.
- Desktop notifications that open their conversation, showing the message, the sender only or
  nothing, with a **Copy code** button for sign-in codes.
- An optional send delay for your own messages, with Undo and Send now.
- A connection dock with today's timeline of connects, disconnects and messages, plus **Fix
  connection…** and **Copy diagnostics**; phone details such as Bluetooth addresses stay blurred
  until clicked.
- Settings in four sections: General, Messages & Privacy, iPhone and AI agents.
- A command palette (Ctrl+K) and keyboard shortcuts for new message, search and settings.
- Guided first-run setup and pairing.
- **Run in the background**: a systemd user service keeps messages and notifications arriving after
  the window closes, and reconnects after sleep or range loss.

### CLI

- Every daemon command is a `tincan` subcommand; `tincan commands` and `tincan schema` list them
  with JSON Schemas.
- Contact names instead of numbers (`--verbose` adds each conversation's key), and `--json` on
  every command.
- `tincan setup`, `pair`, `service install`, `status`, `send`, `watch` and `doctor`.
- Drafts: `tincan drafts` and `tincan draft list|show|send|discard`.
- `tincan message cancel` and `send-now` for messages in their send delay; `tincan send` counts
  down at a terminal, and Ctrl+C cancels.
- `tincan connect <agent>` and `tincan disconnect <agent>` add Tincan to Claude Code, Copilot,
  Codex, Cursor, OpenCode, Antigravity, Muse and Pi (`--print` changes nothing).
- Sends and deletes ask first (`--yes` in scripts). Agent policy changes, sending or discarding
  agent drafts and connecting agents need confirmation at a real terminal.
- Inside a detected AI agent's shell, the CLI connects as that agent (for example `Claude Code
  (CLI)`) and the agent settings apply to everything it runs.

### AI agents (MCP)

- `tincan mcp` serves agents over stdio. Agent access is **off by default**.
- Access levels: **Off**, **Read only**, **Assistant** (drafts, sends within a send limit, numbers and
  codes always hidden) and **Full access** (no send limit; asks you to confirm before switching).
- Read scopes: contacts only, contacts and people you've replied to (the default), or everyone.
  Conversations outside the scope look to agents as if they don't exist.
- Send policies: **Ask me** (every message is an agent draft; the default), **Only people I've
  texted** and **Always**. A send limit of 10 per 10 minutes by default with Assistant.
- Agent drafts land in the conversation's composer, labelled with the agent's name, for you to send,
  edit or discard. They queue, never expire, and the agent can see whether each was sent (and
  edited), discarded or cancelled.
- An agent message delay (10 seconds by default) holds agents' messages, and agent drafts you send,
  on your computer so you can cancel them.
- Hide people (every number and email they have) and groups from agents; hidden people always get
  drafts, at every access level.
- Optional inbox actions (mark read, mute, pin). The **Danger** options, showing phone numbers and
  verification codes, appear only under Full access.

### Privacy and security

- Messages, contacts (photos included) and settings live in an encrypted SQLCipher database whose
  key is kept in your desktop keyring.
- Bluetooth MAP, PBAP and ANCS through BlueZ. Pairing uses numeric comparison only ("Just Works" is
  declined), and Tincan only syncs with a paired, bonded phone.
- The daemon listens only on a private Unix socket. No network port, and no message text, numbers
  or names in logs.
- Agents get opaque handles instead of numbers and emails, redacted verification codes and sign-in
  links, and all phone-derived content framed as untrusted.
- Agent rate limits survive restarts, and drafts are capped per conversation and per agent.
- `tincan doctor` checks Bluetooth, BlueZ and phone permissions; `--report` masks addresses, device
  names and home paths.
- The systemd user service is hardened (`ProtectSystem=strict`, `ProtectHome=read-only`,
  `PrivateTmp`, `NoNewPrivileges`, `UMask=0077`, start-rate limits).
- Releases ship `SHA256SUMS` and GitHub build provenance attestations.

### Requirements

- Linux x86_64 or arm64 with glibc 2.35+ (Ubuntu 22.04+, Debian 12+, Fedora 36+).
- BlueZ 5.64+ with obexd, OpenSSL 3 and systemd; a desktop keyring is recommended.
- Packages: `.deb` (with the CLI and an AppArmor profile) and AppImage, which carries update
  information for AppImageUpdate. The CLI alone is on npm (Node.js 22.18+).

### Known limitations

Apple's iPhone shares only part of Messages over Bluetooth:

- No full history: the first sync brings the 10 most recent messages, and Tincan keeps everything
  from then on.
- No attachments: photos, videos and audio show as a note.
- Messages you send from the iPhone itself don't appear.
- No sending to group chats.
- No typing indicators, delivery or read receipts, edits, unsend or message effects.
- Only one computer or car can hold the phone's message session at a time.

Tincan is alpha software: expect bugs and breaking changes before 1.0, and keep your iPhone as the
source of truth for your messages.

[Unreleased]: https://github.com/beyland-dev/tincan/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/beyland-dev/tincan/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/beyland-dev/tincan/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/beyland-dev/tincan/releases/tag/v0.1.0

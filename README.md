# Tincan

A Linux desktop app, with a matching command line and MCP server, that reads and sends text messages through your iPhone over Bluetooth.

> [!WARNING]
> **Tincan is early, alpha software.** Expect bugs, rough edges and breaking changes between releases. Your
> iPhone stays the source of truth for your messages; don't rely on Tincan as their only copy.

Tincan runs a small local daemon (a systemd user service) that talks to your paired iPhone over BlueZ's Message Access (MAP), Phone Book Access (PBAP), and Apple Notification Center (ANCS) profiles. Messages are stored locally in an encrypted SQLCipher database with the key in your desktop keyring. A desktop app, the `tincan` CLI, and an MCP server for AI agents all drive the same typed command set.

**Docs:** [tincan.beyland.dev/docs.html](https://tincan.beyland.dev/docs.html) covers installing, pairing, the app, the CLI and agent setup on one page.

## What works (and what doesn't)

Bluetooth MAP exposes a narrow slice of Messages on iPhone. Tincan is honest about the limits:

- **Works:** incoming iMessage and SMS text, sending replies and new 1:1 messages, contact names and photos, read/unread sync, full-text search, desktop notifications with one-click verification-code copy, automatic reconnect after sleep or range loss, optional send delays with undo, and optional AI agent access via MCP or the CLI with agent drafts and privacy guardrails.
- **Not supported by Bluetooth MAP:** viewing photo/video/audio attachments (placeholders shown instead), sending to group chats, messages sent from the iPhone itself (MAP's sent folder is empty), full iCloud history (iOS lists only the 10 newest inbox messages on first sync; Tincan keeps history locally from then on), typing indicators, and delivery receipts.

## Requirements

- 64-bit Linux (x86_64 or arm64) with **glibc 2.35+**: Ubuntu 22.04, Debian 12, Fedora 36 or newer, or a current rolling distribution
- **BlueZ 5.64+** (with obexd), **OpenSSL 3** (`libssl3` on Debian/Ubuntu), and `systemd`
- A Bluetooth adapter (built-in or USB) and an iPhone nearby
- A desktop keyring (GNOME Keyring or KWallet) is recommended for the database key
- For CLI-only installs from npm: Node.js ≥ 22.18 (and a Rust toolchain if building from source)

## Installation

### Desktop app (recommended)

Download the `.deb` or `.AppImage` (x86_64 or arm64) from [GitHub Releases](https://github.com/beyland-dev/tincan/releases) or [tincan.beyland.dev](https://tincan.beyland.dev/download.html). The `.deb` also installs the `tincan` command.

```sh
sudo apt install ./Tincan-*.deb
```

> [!IMPORTANT]
> **AppImage on Ubuntu 24.04 and newer:** the AppImage may fail to start because AppArmor restricts the
> unprivileged user namespaces that Chromium's sandbox needs. **Don't run it with `--no-sandbox`**: that
> disables the sandbox for the window that renders messages from anyone who texts you. Use the `.deb`
> (which ships an AppArmor profile), or add a local AppArmor profile as described in
> [docs/troubleshooting.md](docs/troubleshooting.md#the-appimage-wont-start-on-ubuntu-2404-or-newer).

### Verify your download

Every release includes `SHA256SUMS` and GitHub build provenance attestations:

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify Tincan-*.AppImage --repo beyland-dev/tincan   # or the .deb
```

### CLI & daemon via npm

```sh
npm install -g @beyland/tincan
tincan setup                 # enables BlueZ experimental mode & hands-free device class (uses sudo)
tincan service install       # installs and starts the systemd user daemon
tincan pair                  # pairs your iPhone (confirm the six-digit code on both screens)
tincan doctor                # verifies Bluetooth, BlueZ and phone permissions
```

Then on your iPhone, open **Settings › Bluetooth**, tap **(i)** next to your computer, and turn on **Show Notifications** (called **Show Message Notifications** on some iOS versions) and **Sync Contacts**.

## Common CLI commands

```sh
tincan status                # daemon and phone connection status
tincan threads               # list conversations, by contact name (--verbose adds each thread key)
tincan send <to> <text>      # send a text (asks first; --yes to skip in scripts)
tincan message cancel <id>   # take back a message still in its send delay
tincan drafts                # agent drafts waiting for you
tincan watch                 # stream daemon events
tincan doctor --report       # redacted diagnostics for bug reports (review before pasting)
tincan commands              # list every command (with JSON Schemas via --json)
```

## Agents & automation: use at your own risk

Tincan can give AI agents access to your messages through its MCP server (`tincan mcp`) or the `tincan` CLI. Agent access is **off by default**, and when you turn it on:

- You pick an access level: **Read only**, **Assistant** (drafts, inbox actions and sending, with a send limit and phone numbers and codes always hidden) or **Full access** (no send limit and, if you choose, nothing asks first; Tincan asks you to confirm). Each level shows only the options it allows. Only Full access offers **Show phone numbers & emails to agents** and **Show verification codes to agents**, both off by default.
- **Agent drafts.** By default, every message an agent writes lands in that conversation's composer as an agent draft, labelled "Drafted by Claude Code" (the agent's self-reported name), for you to send, edit or discard. Drafts queue (several per conversation), never expire, and conversations with one show "Draft: …" in the list. The agent can see whether its draft was sent (and whether you edited it), discarded or cancelled.
- **Send delays.** An agent's message, or an agent draft you send, waits on your computer (10 seconds by default) before it goes to your iPhone, so you can undo it. You can turn on the same delay for your own messages (off by default). Once a message reaches the phone it can't be unsent.
- By default agents read only conversations with your contacts and people you've replied to, so texts from strangers never reach them unless you choose **Everyone**. Sends are rate-limited (10 per 10 minutes by default with Assistant).
- Phone numbers and emails are replaced with opaque IDs, verification codes and reset links are redacted, short-code senders and people and groups you hide from agents (a contact with all their numbers and emails, and every group they're in) are invisible to them, and agents can't delete anything, change settings or send their own drafts.
- Message text, names and contact fields are passed to agents explicitly marked as untrusted.
- **The CLI in an agent's shell is the agent.** When `tincan` detects it's running inside an AI agent's shell (Claude Code, Codex, Cursor, …), it connects as that agent (for example `Claude Code (CLI)`) and the agent settings apply, so `tincan send` becomes an agent draft or a delayed send. Run `tincan` from a normal terminal for your full CLI.
- Commands that change agent settings, send or discard agent drafts, or add Tincan to agents (`tincan settings set`, `tincan draft send`, `tincan draft discard`, `tincan connect`, `tincan disconnect`) only run after confirmation at an interactive terminal, can't be skipped with `--yes`, and refuse to run inside detected AI-agent environments.

**These are guardrails, not guarantees.** Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it. Redaction can miss unusual formats. And the agent policy isn't a security boundary: any process running as your Linux user, including an agent with shell access, can reach the daemon as you. Grant only what you need and read every agent draft before you send it. See [docs/security.md](docs/security.md) for the full threat model.

```sh
tincan connect                           # list supported agents and which are connected
tincan connect claude                    # also: copilot, codex, cursor, opencode, antigravity, muse, pi
tincan connect claude --print            # just print the config, change nothing
tincan disconnect claude                 # remove it
```

## Development

Requires Node ≥ 22.18, pnpm 12, and a Rust toolchain (for the native Bluetooth + SQLCipher addon).

```sh
pnpm install
pnpm build:native            # compile the Rust napi-rs addon
pnpm ready                   # format/lint/typecheck, test, and build all packages
pnpm dev                     # run the desktop app against a scripted fake phone (no iPhone needed)
pnpm tincan <args>           # run the CLI from source
```

Rust checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

See [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/troubleshooting.md](docs/troubleshooting.md) and [docs/roadmap.md](docs/roadmap.md) for more details.

Tincan is open source under the MIT license so you can inspect, build and fork it, though this repo isn't accepting external pull requests. Bug reports are welcome in [Issues](https://github.com/beyland-dev/tincan/issues); please report security or privacy vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Acknowledgements

Tincan's Bluetooth MAP/PBAP/ANCS implementation was informed by [Tether](https://github.com/zackb/tether) (MIT) as reference material. See [NOTICE](NOTICE).

## Trademarks

Apple, iPhone and iMessage are trademarks of Apple Inc., registered in the U.S. and other countries. Tincan is an independent project and is not affiliated with, sponsored by or endorsed by Apple Inc.

## License

[MIT](./LICENSE)

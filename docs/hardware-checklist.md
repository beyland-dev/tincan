# Hardware Verification Checklist

Run this manual checklist on a real Linux laptop + iPhone before tagging a public release.
Automated CI never touches a real phone.

## Environment

- [ ] Distro & kernel version noted
- [ ] BlueZ version ≥ 5.64 (`bluetoothctl --version`)
- [ ] Bluetooth adapter chipset noted (e.g. Intel, Realtek, MediaTek)
- [ ] iOS version noted

## Clean Install & Setup

- [ ] Install packaged `.deb` or `.AppImage` on a machine without Node/pnpm installed
- [ ] On Ubuntu 24.04+: the `.deb` starts with the Chromium sandbox on (no `--no-sandbox`)
- [ ] On the oldest supported base (Ubuntu 22.04: glibc 2.35, OpenSSL 3, BlueZ 5.64) the app and daemon start
- [ ] Run `tincan setup` and confirm `tincan doctor` reports `Experimental = true` and Hands-free class (`0x...0408`)
- [ ] Pair a fresh iPhone via `tincan pair` or the desktop onboarding flow (numeric code shown on both screens)
- [ ] Enable **Show Message Notifications** and **Sync Contacts** on iPhone
- [ ] Confirm `tincan doctor` passes every check

## Messaging & Sync

- [ ] Initial inbox sync populates recent conversations without firing desktop notifications
- [ ] Live incoming SMS and iMessage arrive promptly and trigger a desktop notification
- [ ] Clicking a notification focuses the desktop app on that conversation
- [ ] One-time verification code shows the copy banner and **Copy code** notification action
- [ ] Sending a 1:1 reply transitions `pending` → `sent` and clears any saved draft
- [ ] Sending a message to yourself shows one bubble (no incoming MAP echo duplicate) and marks the thread `isSelf`
- [ ] Read state syncs both ways (reading in Tincan marks read on iPhone; reading on iPhone updates Tincan on next re-list)
- [ ] Tapback reaction attaches to the quoted message
- [ ] Photo/attachment message renders as a placeholder card rather than raw `￼`/``

## Resilience

- [ ] Laptop suspend/resume: daemon reconnects automatically and catches up missed messages
- [ ] iPhone leaves Bluetooth range and returns: reconnects without duplicate messages
- [ ] Another device holds MAP (`BUSY`): `doctor` and UI report clearly, recovers when released
- [ ] Background service (`tincan service install`): survives closing the desktop window and reboot

## AI Agent / MCP

- [ ] With `agents.access: off`, MCP tools except status/settings/version/commands return `PERMISSION_DENIED`
- [ ] With `agents.read: all`, `agents.handles: hidden`, `agents.hideCodes: true`:
  - [ ] No raw phone numbers or emails appear in `thread_list`, `message_list`, or `contact_search`
  - [ ] Short-code conversations and OTP codes are hidden/redacted
  - [ ] Conversations hidden from agents (right-click ▸ Hide from agents) stay in the list but are
        invisible to MCP, and show up under Settings ▸ AI agents ▸ Hidden from agents
- [ ] With `agents.send: approve`, an agent send lands in that conversation's composer with "Drafted by {agent}
      · Discard"; several queue behind a "‹ 1 of N ›" stepper; sending one starts the agent send delay
      ("Sending in 10s · Undo") before it reaches the phone, and Undo puts it back in the queue
- [ ] With `agents.read: known` (the default once reading is on), a stranger who texted you never shows up in
      `thread_list` or `message_search` until you reply to them yourself
- [ ] With `agents.send: replied`, a send to someone you've never texted from Tincan still becomes a draft, even if they texted first
- [ ] With `agents.send: always` under Assistant, a send goes out after the agent delay (with a Cancel notification),
      but a send to a conversation hidden from agents still becomes a draft; under Full access it goes out directly
- [ ] With a send delay set, Undo during the countdown keeps the message off the phone; a delayed message that
      reaches the phone is echoed back once (no duplicate bubble)
- [ ] `tincan settings set`, `tincan draft send`, `tincan draft discard`, `tincan connect <agent>`,
      `tincan disconnect <agent>` and `tincan agents show <person|number|group>` refuse without an
      interactive terminal, and `--yes` doesn't skip them; `tincan agents hide <contact|number|group> --yes`
      works from a script
- [ ] Run from an agent's shell (e.g. Claude Code), `tincan threads` says it's running as that agent and follows the
      agent settings

# Security and Privacy

Tincan handles personal messages, contacts, and phone numbers. This document describes what Tincan
protects, how it stores data, and where its boundaries lie. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## Threat Model in One Paragraph

Tincan trusts **you** and the software you run as your Linux user. It does not trust **the people
who text you**, **nearby Bluetooth devices**, **web pages linked in messages**, or **AI agents**
(which can be steered by any of the former). Anything running as your user can read your messages
through the daemon's socket, exactly as you can; Tincan's agent settings reduce accidents and casual
exposure, but they are not a wall between you and software you've chosen to run.

## Local Storage & Encryption

- **Database encryption:** Messages, contacts (photos included), conversations, and metadata are
  stored in `~/.local/share/tincan/tincan.db` using SQLCipher (AES-256). The file is `0600`. No
  personal data is kept in plain files.
- **Key storage:** A 32-byte key from the kernel CSPRNG (`getrandom`) is stored in your Secret
  Service keyring (`dev.beyland.Tincan.VaultKey`, e.g. GNOME Keyring or KWallet). A locked keyring
  or a dismissed prompt never falls back to a file. Only when no keyring exists does Tincan use a
  `0600` key file next to the database, and `tincan doctor` warns about it. The key file is created
  atomically, is never followed through a symlink, and is refused if it isn't a regular file owned by
  you with no group/other permissions.
- **Contact photos:** Stored in the encrypted database, once each, named by content hash. Only
  JPEG, PNG, GIF and WebP images are kept (no SVG). Older versions cached them as plain files in
  `~/.local/share/tincan/photos/`; the daemon moves those into the database at startup and deletes
  the folder (deleting doesn't scrub the disk blocks, so on an unencrypted disk traces may remain
  until they're overwritten).
- **Notification icons:** Notification servers take an icon as a file, so a contact's photo is
  written to a short-lived `0600` file in `$XDG_RUNTIME_DIR/tincan` (in RAM, `0700`, checked to be a
  directory of your own that only you can reach, as for Bluetooth transfers). It's removed when the
  notification closes or is replaced, after five minutes at most, and when the daemon stops;
  leftovers are removed at startup. Without `$XDG_RUNTIME_DIR` (or with a folder that fails the
  checks), notifications show no photo rather than writing one to disk.
- **Socket:** The daemon listens only on a Unix domain socket at
  `$XDG_RUNTIME_DIR/tincan/tincan.sock` (directory `0700`, socket `0600`). The daemon refuses a
  directory owned by another user or open to group/other, and clients (CLI, MCP server, desktop app)
  refuse to connect to a socket or directory that isn't private and owned by you, so another user on
  a shared machine can't plant a fake daemon. No TCP port is opened.
- **Service hardening:** The systemd user unit runs with `UMask=0077`, filesystem protections, and
  start-rate limits.
- **No sensitive logging:** Message text, phone numbers, and contact names are never written to
  daemon logs, Rust logs, or error messages; Bluetooth addresses in D-Bus errors are masked. The
  desktop app writes the daemon it starts to `~/.local/state/tincan/daemon.log` (`0600`).
- **Diagnostics:** `tincan doctor --report` and the desktop app's **Copy diagnostics** fully mask
  Bluetooth addresses (both `AA:BB:…` and `dev_AA_BB_…` forms), replace device names, and turn home
  directories into `~`. Review a report before you paste it anywhere.

## Bluetooth

- Tincan only syncs with a phone that BlueZ reports as **paired and bonded**.
- Pairing requires numeric comparison (the code shown on both screens). Unverified "Just Works"
  pairing requests are declined, because an iPhone never asks for one.
- The pairing agent only answers BlueZ itself.
- Parsers for messages (bMessage), contacts (vCard) and notifications (ANCS) treat all input as
  hostile: lengths are bounded, downloads are size-capped, and the parsers are fuzzed.
- **Residual risk:** BlueZ doesn't expose a link's security level over D-Bus, so Tincan can't insist
  on an authenticated, encrypted link for MAP/PBAP beyond requiring a bonded device.

## AI Agents (MCP)

Agent access through `tincan mcp` is **off by default**. The **access level** (`agents.access`)
decides how much agents may do and caps every other setting:

| Level                       | Reading                      | Sending and drafts                                      | Inbox actions | Privacy options |
| --------------------------- | ---------------------------- | ------------------------------------------------------- | ------------- | --------------- |
| **Off** (`off`)             | none                         | none                                                    | no            | on              |
| **Read only** (`readOnly`)  | `agents.read` (not `off`)    | none                                                    | no            | always on       |
| **Assistant** (`assistant`) | `agents.read` (may be `off`) | `approve`, `replied` or `always`, within the send limit | as set        | always on       |
| **Full access** (`full`)    | `agents.read`                | `approve`, `replied` or `always`, **no send limit**     | as set        | as set          |

With Off, agents can't see or send messages: they can only check that Tincan is running and what
access you've given them. At every level `settings.get` (and the `settings.changed` event) gives
agents only the agent policy (`agents`); notifications, the default country and your own send
delay are yours. A stored value a level doesn't offer
is kept but has no effect (`effectiveAgents` in the protocol package applies the level), so moving
from Full access back to Assistant turns the privacy options back on without forgetting your
choices. Picking a level in the desktop app or with `tincan settings set --access <level>` also sets
a starting point for what it offers (Full access: `all`, `always` and inbox actions) and never
changes the privacy options or the send delays. Settings from before access levels are migrated when Tincan
starts: agents turned off stay off, and turned on become Read only (if they couldn't send) or
Assistant, never Full access.

The other settings:

| Setting                   | Default   | What it does                                                                                                                        |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agents.access`           | `off`     | `off`, `readOnly`, `assistant` or `full` (above).                                                                                   |
| `agents.read`             | `known`   | Which conversations agents may read: `off`, `contacts`, `known` or `all`.                                                           |
| `agents.send`             | `approve` | `approve` (every send is an agent draft for you), `replied` or `always` (see below). `never` counts as `approve` from Assistant up. |
| `agents.sendLimit`        | `10`      | Messages agents may send per 10 minutes with Assistant (1–60, or `null` for no limit).                                              |
| `agents.sendDelaySeconds` | `10`      | How long agents' messages, and agent drafts you send, wait on your computer before going to the phone (0–300).                      |
| `agents.manage`           | `false`   | Lets agents mark conversations read, mute and pin them.                                                                             |
| `agents.handles`          | `hidden`  | Replaces phone numbers and emails with opaque `handle:…` tokens. Only Full access shows them.                                       |
| `agents.hideCodes`        | `true`    | Hides short-code senders and redacts one-time codes and sign-in links. Only Full access turns it off.                               |
| `sendDelaySeconds`        | `0`       | The same delay for your own messages (off by default).                                                                              |

Agents may save drafts whenever they may send (Assistant and Full access, with reading on); there's
no separate switch.

What `agents.read` lets agents see, on top of the hidden and short-code rules below:

- `contacts`: conversations where every member is one of your saved contacts, or you (the
  conversation with your own number). A group Tincan knows no members of doesn't count.
- `known`: those, plus conversations you've sent a message in yourself. An agent's messages, and the
  phone's copies of them, never count.
- `all`: every conversation you haven't hidden from agents.

Contacts need `agents.read` to be anything but `off`.

What Tincan enforces for MCP clients:

- **Out of scope looks like nothing.** A conversation an agent may not read is left out of lists,
  search, events and resources, and naming it fails with `NOT_FOUND`, exactly like a conversation that
  doesn't exist. The same check covers reading, drafts, inbox actions, group details and the
  daemon's event stream, and it's part of the database query, so a busy inbox of strangers can't
  crowd out the conversations an agent may read.
- **Agent drafts show everything, and never expire.** Every message an agent writes that needs you
  (a `message.send` the policy doesn't let go, or a `message.draft.save`) becomes an **agent
  draft** in that conversation's composer, including for someone you have no conversation with yet.
  Drafts queue (at most 5 per conversation and 20 per agent) and wait until you send, edit or
  discard them; nothing times out and nothing is sent unless you press Send. The desktop app labels
  each with the agent's name (self-reported, so treat it as a label, not proof) and warns only
  about real problems: hidden or direction-changing characters (with a button to remove them),
  links to punycode (`xn--`) or lookalike addresses, code-like text, long blank stretches, and why
  Tincan held it: the conversation is hidden from agents, a short-code sender, or outside what
  agents can read. Ordinary links and recipients get no warning; a draft to someone with no
  conversation yet opens in its own new-conversation view. Agents never see that reason. The same text to the same recipient
  while it's still queued is the same draft. Your own draft is a separate slot: agents never
  replace, delete or read it, including your drafts to people with no conversation yet
  (`message.draft.list` is for the desktop app and CLI only).
- **Agents learn what happened, not what you wrote.** An agent can see the state of its own drafts
  (`queued`, `scheduled`, `sent`, `failed`, `discarded`, `cancelled`) and whether you edited the
  text, but sees your edited text and the message only in conversations it may read. It never sees
  other agents' drafts, and drafts to hidden, short-code or out-of-scope recipients look the same
  as ones to anyone new.
- **Sending from an agent draft doesn't make it yours.** A message sent from an agent draft, edited
  or not, still counts as the agent's: it never makes a conversation `known` or lets `replied` send
  directly. To unlock those, send a message you typed yourself.
- **Send delays hold messages on your computer, not on the phone.** Agents' messages (direct sends,
  and agent drafts you send) wait `agents.sendDelaySeconds` (10 s by default), and yours
  `sendDelaySeconds` (off by default), before Tincan hands them to your iPhone. Until then you can
  cancel (or, for an agent draft, undo back into the composer). **Once a message reaches the phone
  it can't be unsent**, and iMessage's own Undo Send isn't available to Tincan. If your computer
  sleeps through a send's time (more than 15 seconds late), Tincan doesn't send it: an agent draft
  you sent goes back to its queue, an agent's direct send is cancelled and your own message fails
  so you can retry it, saying why (`Message.failure`: `PAUSED` while the computer slept,
  `RESTARTED` when Tincan wasn't running). The same rule applies to sends that were due while the
  daemon was stopped. Agents see why a send failed only on their own messages.
  An agent's send during its delay shows a desktop notification with a Cancel button.
- **`replied` still drafts for anyone new.** An agent's send goes directly only when the
  conversation is one the agent may read and you have personally sent that recipient a message
  before. Someone texting you first doesn't count, and neither do agent messages.
- **`always` sends directly**, after the agent send delay and within the send limit, even to people
  outside what agents may read or who have never texted you. With Assistant, short codes still
  become drafts (`hideCodes` is always on there), and a send to a raw phone number or address always
  does while handles are hidden, whatever the setting.
- **People and groups you hid always get drafts.** At every access level, Full access with
  `always` included, an agent's send to a hidden person (any of their numbers or emails) becomes an
  agent draft for you, noted "hidden". An explicit hide beats every access level.
- **Full access has no other residual guards.** With `always`, nothing else becomes a draft: not a
  short code or a raw number, and there is **no send limit**. Reading still leaves out what you hid
  and what's outside `agents.read`. With `approve` or `replied`, sends
  behave as they do with Assistant. `message.draft.save` always waits for you, at every level.
- **Inbox actions are a separate switch**, from Assistant up: with `agents.manage` off agents can't
  mark read, mute or pin. Like drafts, they only reach conversations the agent may read.
- **Agents can't send their own drafts or change policy.** Sending, editing or restoring agent
  drafts, cancelling or hurrying a delayed send, retrying, changing agent settings, connecting agent
  apps, deleting, and forgetting devices aren't available over MCP (an agent may discard its own
  queued drafts). The `tincan` CLI only sends or discards agent drafts, changes agent policy and
  connects or disconnects agent apps (`tincan connect <agent>`, `tincan disconnect <agent>`) and shows
  someone hidden to agents again (`tincan agents show <person|number|group>`) at an
  interactive terminal (`--yes` doesn't skip the prompt), and fails non-interactive sends, deletes
  and other changes unless `--yes` is passed.
- **The CLI in an agent's shell is an agent.** When the CLI detects that it's running inside an AI
  agent's shell (Claude Code, Codex, Cursor, Gemini CLI, …), it connects as that agent
  (`Claude Code (CLI)`) and says so on stderr: the agent settings apply to everything it runs
  (nothing while agents are off; read scopes, masked numbers and hidden codes; `tincan send` becomes
  an agent send), and policy commands are refused outright. There's no switch to turn this off,
  since the agent controls its environment. To use your full CLI, run `tincan` from a normal
  terminal.
- **Hidden means hidden.** You hide **people** from agents, not single conversations: a contact
  with every number and email it has, or a raw number or address (even one you've never texted).
  Group conversations can be hidden on their own too. In the desktop app: right-click a
  conversation, its info panel, the command palette or Settings ▸ AI agents ▸ Hidden from agents;
  in the CLI, `tincan agents hide <name|number|group>`. A hidden person's conversations, every
  group they're a member of or on the saved roster of, and their contact (`contact.list`,
  `contact.search`, `contact.get`, lookups by name) stay in your app but are invisible to agents,
  whatever new messages arrive, even if you delete a conversation and it starts again, until you
  show them to agents again yourself, whatever `agents.read` says. Hiding follows the iPhone's card
  (whose id changes whenever it's edited, so Tincan anchors on numbers and emails) and fails
  closed: numbers added to the card are hidden too, numbers removed from it stay hidden, a hidden
  raw number later saved to a contact hides that contact, and a deleted contact stays hidden under
  its old name. Groups Tincan knows only from notifications (display names, no numbers) can't be
  matched to a hidden person: hide those groups themselves. Hiding someone takes back agents'
  direct sends to them that haven't reached the phone yet and queues them as drafts for you.
  Agents can't hide, show or list who's hidden (`agents.hide`, `agents.show` and `agents.hidden`
  are internal), and never learn that anyone is hidden. Drafts involving hidden, short-code or
  out-of-scope recipients look the same to an agent as any new recipient, so agents can't probe
  which ones exist.
- **Codes and links.** With `hideCodes`, text is normalised before matching, one-time codes are
  redacted (including spaced, dashed and full-width digits), and links in messages that look like
  sign-in, reset or verification messages are replaced. Such messages are left out of agent search.
  **This is heuristic and will miss some phrasings.**
- **Rate limits** persist across daemon restarts: sends (`agents.sendLimit`, 10 per 10 minutes by
  default with Assistant, none if you set none, never with Full access; a change applies at once;
  a send counts when it's queued as a draft too, and discarding it doesn't give it back), saving
  drafts (30 per 10 minutes) and phone-side changes (marking read, muting, syncing), which apply at
  every level because they protect the phone.
- **Events** follow the same rules as commands, and agents never get pairing events or the phone's
  Bluetooth address.
- **Untrusted framing.** The MCP instructions, guide, tool results and resources mark all
  phone-derived content (message text, names, group names, contact fields) as untrusted data.

### What these controls don't do

- **They don't stop prompt injection.** Warning: An incoming message could trick an agent into
  replying with sensitive information or take actions using other tools you've given it. Sending is itself a way out: prefer Read only,
  or Assistant with `approve`, keep `agents.read` to `contacts` or `known` (strangers' texts are
  where injection comes from), and consider enabling reading only for agents without other
  powerful tools. **Full access** (`all` with `always`) lets anyone who texts you try to steer an
  agent into messaging anyone on your behalf, with no limit and nothing asking first.
- **They don't contain an agent with a shell.** The socket and the CLI run as you. An agent with
  unrestricted shell access (Claude Code, Codex, Cursor, …) can do anything you can, including
  unsetting the variables the CLI looks for, faking a terminal or talking to the socket directly.
  The CLI checks above stop accidents and naive attempts, not a determined program.
- **A send delay isn't a review.** It only helps if you're there to cancel. Keep `approve` (every
  agent message is a draft you send yourself) if you want to read each one first.
- **Redaction is best effort.** Treat agent access as giving the agent your messages.

Use agent features at your own risk.

## Desktop App

- The renderer is sandboxed with context isolation, served from a private `app://` scheme under a
  strict Content Security Policy, and can only call an allowlist of daemon commands. Electron fuses
  disable `NODE_OPTIONS` and inspector flags and require the app to load from its asar archive.
- Message text is never rendered as HTML; only `http(s)` links are clickable and open in your
  browser. Device, USB, HID, serial and Bluetooth permission requests from web content are denied.

## Network Activity

- Messaging, contacts, and notifications work **only over local Bluetooth**. There is no Tincan
  server, account, telemetry, or cloud relay, and no automatic updates.
- **Link previews (desktop, off by default):** When you turn them on, the app fetches page metadata
  and a preview image directly from linked sites (plus public oEmbed/API data for YouTube, GIPHY and
  Bluesky). The site's owner sees your IP address and when the preview loaded. Previews load
  automatically only in conversations with saved contacts or where you've replied; elsewhere you
  click to load. Fetches use a generic browser User-Agent, refuse private, loopback, link-local and
  other non-public addresses after DNS resolution (and on every redirect), and have size, time, and
  concurrency limits. **Previews only fetch over HTTPS:** plain `http://` links get no preview
  (they stay clickable), `http://` preview images are dropped, and a redirect from https down to
  http is refused. Playing a YouTube video loads
  `youtube-nocookie.com` in a sandboxed frame.
- **Spell check (desktop, off by default):** Turning it on downloads dictionaries from Google.
- With both off, the app makes no outbound requests; links you click open in your browser.

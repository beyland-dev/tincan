# @beyland/tincan

The `tincan` command: your iPhone's iMessage and SMS on Linux, over Bluetooth. It runs Tincan's
background daemon, pairs your iPhone, calls every Tincan command from the terminal, and serves
Tincan to AI agents over MCP. No Mac, no jailbreak, no app on the iPhone.

> **Alpha software.** Expect rough edges and breaking changes between 0.x releases. Prefer a window?
> The [desktop app](https://tincan.beyland.dev/download.html) (`.deb` / AppImage) includes this
> command too.

## Requirements

- 64-bit Linux (x86_64 or arm64) with glibc 2.35+ (Ubuntu 22.04, Debian 12, Fedora 36 or newer)
- BlueZ 5.64+ with obexd, OpenSSL 3 (`libssl3`), and systemd
- Node.js 22.18 or newer
- A Bluetooth adapter and an iPhone nearby

## Install and set up

```sh
npm install -g @beyland/tincan
tincan setup             # one-time BlueZ setup: experimental mode + hands-free device class (sudo)
tincan service install   # run the daemon in the background (systemd user service)
tincan pair              # pair your iPhone; confirm the six-digit code on both screens
tincan doctor            # check Bluetooth, BlueZ and the iPhone's permissions
```

Then on the iPhone: **Settings › Bluetooth › (i)** next to your computer, and turn on **Show
Notifications** and **Sync Contacts**.

Prefer to run the daemon yourself? `tincan daemon` runs it in the foreground; `tincan service
status` and `tincan service uninstall` manage the background service.

## Everyday commands

```sh
tincan status                     # daemon and phone connection
tincan threads                    # list conversations
tincan message list <thread>      # messages in a conversation
tincan message search <text>      # search saved messages
tincan send <to> <text>           # send to a number, email, contact name or thread
tincan message cancel <id>        # take back a message still in its send delay
tincan drafts                     # agent drafts waiting for you
tincan draft show <id>            # one agent draft, with its full text
tincan draft send <id>            # send it (asks first, at a terminal)
tincan draft discard <id>         # throw it away (asks first, at a terminal)
tincan thread mark-read <thread>  # mark read (on the iPhone too)
tincan watch                      # print events as they happen
tincan doctor --report            # redacted diagnostics for bug reports (review before pasting)
tincan commands --json            # every command, with JSON Schemas
```

Add `--json` to any command for machine-readable output, and `--help` for its options. Commands can
be dotted, spaced or kebab-cased (`tincan thread.list`, `tincan thread list`).

**Names, not numbers.** Output names people and conversations by contact or group name, so it's safe
to share your screen. A number with no contact is formatted, and your own messages are "You":

```console
$ tincan threads
Ada Lovelace  [1 unread]
  2026-11-21 22:41  Saturday works
+1 (555) 010-0099
  2026-11-21 22:41  Hi from an unknown number
Alan Turing (phone)  [1 unread]
  2026-11-21 22:41  Sent while you were away
Alan Turing (email)  [1 unread]
  2026-11-21 22:01  Did you get my last message?

$ tincan message search chapter
2026-11-21 22:41  Grace Hopper: Chapter 4 is a long one
  Grace Hopper  LM0NIP4T0_6o7rY8wzD_IA
```

Commands that take a conversation accept a contact or group name (`tincan message list "Ada
Lovelace"`). To see the thread keys, handles and Bluetooth addresses too, so you can copy one into
another command, add `--verbose`: `tincan threads --verbose` prints `tel:+15550100001` under Ada.
`--json` always has them. `tincan --version` (or `-v`) prints the version.

**Confirmations:** sending and deleting ask first; in scripts, pass `--yes`. Commands that change agent
settings or send or discard agent drafts (`tincan settings set`, `tincan draft send`, `tincan draft
discard`, and showing a conversation to agents again) only run after confirmation at an interactive
terminal, can't be skipped with `--yes`, and refuse to run inside detected AI-agent environments.

**Send delays:** `tincan settings set --send-delay-seconds 5` holds your own messages on this
computer for 5 seconds before they go to your iPhone (off by default). At a terminal, `tincan send`
counts down on one line and Ctrl+C cancels it; with `--json` or in a script it returns at once and
prints the `tincan message cancel <id>` to run. Agents' messages, and agent drafts you send, wait
`--agents-send-delay-seconds` (10 by default). The delay only holds a message on your computer:
once it reaches the phone it can't be unsent.

## AI agents (MCP)

```sh
tincan connect                   # list the supported apps and which are connected
tincan connect claude            # add Tincan to an app's user-level config
tincan connect claude --print    # print the config to add by hand, changing nothing
tincan disconnect claude         # remove it
```

Supported apps: `copilot` (Copilot CLI and VS Code), `claude`, `codex`, `cursor`, `opencode`,
`antigravity`, `muse` and `pi`. Any other MCP client can launch `tincan mcp` over stdio. Run
`tincan connect <agent>` and `tincan disconnect <agent>` yourself: they ask at a terminal (`--yes`
doesn't skip it) and refuse to run from an AI agent's shell. `--print` runs anywhere.

Agent access is **off by default**. Turn it on in the desktop app's Settings › AI agents, or at a
terminal with an access level and per-setting flags (see `tincan settings set --help`):

```sh
tincan settings get                                 # what agents may do now
tincan settings set --access assistant              # read contacts and people you've texted; sends become drafts
tincan settings set --agents-read contacts --agents-send-limit 5
tincan agents hide "Mom"                            # a contact, number or group (a script needs --yes)
tincan agents hidden                                # who's hidden from agents
tincan agents show "Mom"                            # show them again (asks at a terminal)
```

Hiding a contact hides all their numbers and emails, every conversation with them and every group
they're in, and the contact itself, from agents. A raw number or email works with no conversation
yet. Hidden conversations stay in your list (`tincan threads` marks them "hidden from agents") and
stay hidden from agents, whatever new messages arrive, until you show them again. Agents' messages
to someone hidden always wait for you as drafts, even with full access.

`agents.access` picks how much agents may do, and caps every other setting:

| Level       | `--access`  | What agents may do                                                          |
| ----------- | ----------- | --------------------------------------------------------------------------- |
| Off         | `off`       | Only check status and what access you've given them.                        |
| Read only   | `read-only` | Read, within `agents.read`. No sending, drafts or inbox actions.            |
| Assistant   | `assistant` | Read, draft, manage and send within the settings below; privacy always on.  |
| Full access | `full`      | Everything the settings allow, the privacy options included; no send limit. |

The other settings: `agents.read` (`known` by default, `off`, `contacts` or `all`): which
conversations agents may read; `agents.send` (`approve` by default, `replied` or `always`): whether
their sends go or become agent drafts for you; `agents.sendLimit` (10 per 10 minutes by default,
`none` for no limit; assistant only); `agents.sendDelaySeconds` (10 by default): how long their
messages wait so you can cancel them; `agents.manage` (marking read, muting and pinning);
`agents.handles` (`hidden` by default) and `agents.hideCodes` (`true` by default), which only full
access can turn off. Agents may save drafts whenever they may send.

**Agent drafts.** With `approve`, every message an agent sends is an agent draft: it waits, without
expiring, in that conversation's composer in the desktop app (and in `tincan drafts`) until you send
it, edit it or discard it. With `replied`, a recipient you haven't texted yourself gets a draft. With
`always` under assistant, only people and groups you've hidden from agents, short codes and raw
numbers do; under full access only people and groups you've hidden do. Drafts an agent saves with `message.draft.save` always wait for you.
A message you send from an agent draft still counts as the agent's, so it never lets `replied` send
directly; send one you typed yourself for that. Agents learn whether their draft was sent (and
whether you edited it), discarded or cancelled.

**In an agent's shell, `tincan` is the agent.** When the CLI detects it's running inside an AI
agent's shell (Claude Code, Codex, Cursor, Gemini CLI, …), it connects to the daemon as that agent
(for example `Claude Code (CLI)`) and prints a line saying so. The agent settings then apply to
everything it runs: nothing works while agents are off, read scopes apply, numbers come back as
opaque handles (output shows a contact's name, or the opaque ID when there's none, never the number) and codes are hidden, and `tincan send` is an agent send (a draft for you, or
delayed). Sending drafts, cancelling sends and policy commands are refused. There's no switch to
turn this off; run `tincan` from a normal terminal for your full CLI.

### Use at your own risk

Warning: An incoming message could trick an agent into replying with sensitive information or take
actions using other tools you've given it. Tincan marks message text, names and contact fields as
untrusted, hides codes and phone numbers, and keeps sends as drafts for you or behind a send delay,
but these are guardrails, not guarantees. The agent policy is not a security
boundary: any process running as your user, including an agent with shell access, can use `tincan`
as you. Read the [security model](https://github.com/beyland-dev/tincan/blob/main/docs/security.md)
before giving an agent access.

## Links

- Docs: <https://tincan.beyland.dev/docs.html>
- Troubleshooting: <https://github.com/beyland-dev/tincan/blob/main/docs/troubleshooting.md>
- Source and issues: <https://github.com/beyland-dev/tincan>
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple, iPhone and iMessage are trademarks of Apple Inc.; Tincan is not affiliated with or
endorsed by Apple.

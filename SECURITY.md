# Security Policy

## Supported Versions

Tincan is pre-1.0. During the 0.x series, security fixes are made only for the **latest minor
release** (for example, if 0.4.x is current, fixes ship as a new 0.4.x or 0.5.0 release; 0.3.x is not
patched). Please upgrade to the latest release before reporting, and check whether the issue still
reproduces on `main` if you can.

| Version            | Supported |
| ------------------ | --------- |
| Latest 0.x minor   | Yes       |
| Older 0.x releases | No        |

## Reporting a Vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.** Report it
privately through GitHub's **Private Vulnerability Reporting**:

- [Report a vulnerability](https://github.com/beyland-dev/tincan/security/advisories/new) on the
  Security tab of `beyland-dev/tincan`.

This is the only reporting channel we monitor for security issues. Please include:

- what the issue is and its impact;
- steps to reproduce, or a proof of concept;
- your Tincan version, distribution, BlueZ version and iOS version;
- relevant output from `tincan doctor --report`. It masks Bluetooth addresses, device names and
  home-directory paths, but **review it before attaching**, and never include real message content,
  phone numbers or contact names. Use synthetic data (for example `+1 555 010 xxxx` numbers) in
  reproductions.

## Scope

**In scope**, for example:

- Leaks of message text, phone numbers, contact names or other personal data: into logs, diagnostics,
  crash output, files with loose permissions, or the network.
- Flaws in the encrypted message store or how its key is generated, stored or loaded.
- Escaping the Electron renderer sandbox, bypassing the content security policy, or getting the
  renderer to run code or reach the system from untrusted message content (including link previews).
- Anything an **incoming message or a remote Bluetooth device** can do that it shouldn't: memory
  safety bugs or crashes in the bMessage, vCard or ANCS parsers, pairing without the numeric
  comparison, or impersonating the paired iPhone.
- Another local user on the same machine reaching your daemon socket or data.
- A **remote** prompt-injection path that defeats the agent policy as configured: for example, a
  received text that causes an agent's message to skip your composer when the policy says it should
  queue, exposes a hidden conversation or an
  unredacted handle, or lets an agent run an `internal` command.
- Supply-chain issues in release artifacts, checksums or attestations.

**Out of scope as a security vulnerability** (but still welcome as regular bug reports):

- **Agent policy bypasses by a process already running as your Linux user.** Anything that can reach
  the daemon's socket already acts as you; the agent policy is a usability and safety guardrail, not
  an OS security boundary (see [docs/security.md](docs/security.md)). This includes an agent with
  shell access calling the CLI, editing Tincan's files, or claiming a different client kind.
- Ways around the CLI's interactive-confirmation and AI-agent-environment checks by code running as
  you. These checks reduce accidents; they can't stop a determined local process.
- Verification-code redaction missing an unusual message format, unless it's a broad or systematic
  failure.
- Agent names shown on agent drafts ("Drafted by …"): they're self-reported by the agent and documented
  as such.
- Attacks that need root, physical access to an unlocked session, or a compromised iPhone.
- Limits of Bluetooth MAP itself, or of Apple's implementation on the iPhone.
- Denial of service by someone within Bluetooth range jamming or flooding the radio.
- Running the AppImage with `--no-sandbox`, which the docs tell users not to do.

If you're unsure, report it privately anyway and we'll help sort it out.

## Response Targets

This is a small project maintained on a best-effort basis. We aim to:

- acknowledge your report within **3 business days**;
- give an initial assessment (accepted, need more information, or out of scope) within **10 business
  days**;
- ship a fix for confirmed high-severity issues within **30 days**, and for others in a following
  release, keeping you updated at least every two weeks until it's resolved.

## Coordinated Disclosure

- Please give us a reasonable chance to fix the issue before disclosing it publicly. We ask for up to
  **90 days** from your report, or until a fix is released, whichever comes first, and we're happy to
  agree a different timeline for complex issues.
- Once a fix is released we publish a GitHub Security Advisory (requesting a CVE where appropriate)
  and note it in the [CHANGELOG](CHANGELOG.md).
- We credit reporters in the advisory unless you'd rather stay anonymous.
- We won't take legal action against good-faith research that respects this policy: test only
  against your own devices and accounts, don't access other people's data, and don't degrade other
  users' service.

## Security Model

See [docs/security.md](docs/security.md) for Tincan's full threat model, including:

- Local SQLCipher encryption and Secret Service key storage
- Unix socket permissions (`0700` dir, `0600` socket) and why the agent policy is a usability/safety
  guardrail rather than a multi-user OS security boundary
- AI agent privacy protections (opaque handle IDs, verification code filtering, hidden-thread
  isolation, untrusted-content framing, agent drafts for new recipients, send delays, and persistent
  rate limits)
- Link previews and external network requests

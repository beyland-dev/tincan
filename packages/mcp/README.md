# @beyland/tincan-mcp

Tincan's [Model Context Protocol](https://modelcontextprotocol.io) server, with tools generated from
the command contracts. It's what `tincan mcp` runs.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

To connect an agent app, use the CLI rather than this package directly:

```sh
npm install -g @beyland/tincan
tincan connect claude   # or copilot, codex, cursor, opencode, antigravity, muse, pi
```

Agent access is off until the user picks an access level in Tincan's settings (`agents.access`:
read only, assistant or full access), which caps the rest: which conversations agents may read (`agents.read`: `contacts`, `known` or `all`), whether their sends go
or become agent drafts for the user to send, edit or discard (`agents.send`), and whether they may mark read, mute and pin. People and groups the user hides from agents (a contact with all their numbers and emails, every group they're in, and the contact itself) never reach them, and agents can't hide, show or list who's hidden. Agents' messages wait on
the computer for a send delay (`agents.sendDelaySeconds`, 10 s by default) so the user can cancel them; once a message reaches the phone it
can't be unsent. Sends never block: agents learn the outcome with `draft_get`. Message text, names and contact fields are passed to agents as untrusted data. **Use at your
own risk:** anyone can text the user, and a message can try to manipulate an agent (prompt
injection). See the [agent docs](https://tincan.beyland.dev/docs.html#agents).

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

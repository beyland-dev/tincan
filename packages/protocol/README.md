# @beyland/tincan-protocol

Tincan's wire protocol: the zod entities, the NDJSON envelope, events, error codes and the typed
**command contracts** that every Tincan surface (desktop app, CLI, MCP server) is generated from.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

## What's in it

- `contracts`: each command's name, description, zod `input` and `output`, and metadata
  (`internal`, `sensitive`, `agentScope`, `approval`, `destructive`).
- Entities such as `Thread`, `Message`, `Contact`, `Settings` and `AgentDraft`, and the agent
  access levels (`AgentAccess`, `effectiveAgents`, `accessPatch`).
- `TincanError` and the shared error codes.
- `protocolSchema()`, which turns the contracts into JSON Schema.

It has no native or Bluetooth dependencies, so clients can import it anywhere Node runs.

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

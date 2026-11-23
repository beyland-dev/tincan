# @beyland/tincan-client

A small typed client for the Tincan daemon's local Unix socket. The `tincan` CLI, the MCP server and
the desktop app all use it to call commands and subscribe to events.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

## Example

```ts
import { TincanClient } from "@beyland/tincan-client";

const client = await TincanClient.connect({ client: { kind: "cli", name: "my-script" } });
const status = await client.call("status", {});
await client.close();
```

The client depends only on `@beyland/tincan-protocol`. It needs a running daemon (`tincan daemon` or
`tincan service install`). Anything that can reach the socket acts as the user, so the agent policy
is a guardrail for AI agents, not a security boundary.

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

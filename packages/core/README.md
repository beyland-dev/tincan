# @beyland/tincan-core

Tincan's headless core: the command registry and handlers, the AI agent policy, agent drafts and
send delays, the event bus, the sync engine and the encrypted message store's schema and queries.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

Core reaches the iPhone only through its `PhonePort` interface, which the native Bluetooth layer
implements in production and [`@beyland/tincan-fake-phone`](https://www.npmjs.com/package/@beyland/tincan-fake-phone)
implements in tests. It's hosted by [`@beyland/tincan-daemon`](https://www.npmjs.com/package/@beyland/tincan-daemon);
clients should never import it directly.

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

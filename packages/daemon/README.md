# @beyland/tincan-daemon

The Tincan daemon: a per-user Unix-socket NDJSON server that hosts `@beyland/tincan-core`, loads the
native Bluetooth addon, holds the single-instance lock and manages the systemd user service.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

You normally run it through the CLI:

```sh
tincan daemon            # foreground
tincan service install   # background, as a systemd user service
```

The socket lives at `$XDG_RUNTIME_DIR/tincan/tincan.sock` (directory `0700`, socket `0600`); no
network port is opened. If [`@beyland/tincan-native`](https://www.npmjs.com/package/@beyland/tincan-native)
isn't available the daemon still starts, and `tincan status` reports the native layer as unavailable.

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

# @beyland/tincan-native

The native layer for Tincan: napi-rs bindings over the `tincan-bt` Rust crate (BlueZ, OBEX MAP and
PBAP, ANCS, bMessage and vCard parsing) and the SQLCipher vault.

> Most people want the [Tincan desktop app](https://tincan.beyland.dev/download.html) or the
> [`@beyland/tincan`](https://www.npmjs.com/package/@beyland/tincan) command line, not this package.
> It's published as a building block of Tincan and its API may change between 0.x releases.

Prebuilt for `linux-x64-gnu` and `linux-arm64-gnu`. Requirements: glibc 2.35+ (Ubuntu 22.04 or
newer), OpenSSL 3 (`libssl3`), BlueZ 5.64+ with obexd, and Node.js 22.18+.

The API is documented in [docs/native.md](https://github.com/beyland-dev/tincan/blob/main/docs/native.md).
To build from source, clone the repository and run `pnpm build:native`; run its tests with
`pnpm --filter @beyland/tincan-native test`.

## Links

- Website and docs: <https://tincan.beyland.dev/docs.html>
- Source, issues and architecture: <https://github.com/beyland-dev/tincan>
  ([docs/architecture.md](https://github.com/beyland-dev/tincan/blob/main/docs/architecture.md))
- Security policy: <https://github.com/beyland-dev/tincan/blob/main/SECURITY.md>

## License

MIT. Apple and iPhone are trademarks of Apple Inc.; Tincan is not affiliated with or endorsed by Apple.

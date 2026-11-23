# Contributing to Tincan

Thank you for your interest in contributing to Tincan! Bug reports, docs fixes, hardware reports and
code are all welcome. By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

Security problems should be reported privately, not in issues: see [SECURITY.md](SECURITY.md).

## Prerequisites

- Linux (for the native Bluetooth layer; TypeScript packages and `fake-phone` tests run anywhere with Node)
- Node.js ≥ 22.18 and pnpm 12 (`corepack enable`)
- Rust stable toolchain (with `rustfmt` and `clippy`) plus `libdbus-1-dev`, `libssl-dev` (OpenSSL 3)
  and `pkg-config`

## Getting Started

```sh
pnpm install
pnpm build:native            # builds the Rust napi-rs addon
pnpm ready                   # format/lint/typecheck, tests, and package builds
```

Useful commands (see [AGENTS.md](AGENTS.md) for the full list):

```sh
pnpm check                                   # vp check: format, lint (type-aware), typecheck
pnpm exec vp check --fix                     # format
pnpm test                                    # vp test in every package
pnpm --filter @beyland/tincan-native test    # native addon tests (skip when the addon isn't built)
pnpm tincan <args>                           # run the CLI from source
```

Rust checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### Working Without an iPhone (`fake-phone`)

You do **not** need an iPhone or Bluetooth hardware to develop or test Tincan:

```sh
pnpm dev                     # starts the desktop app against a scripted fake phone
TINCAN_FAKE_PHONE=fixtures/scenarios/busy-group.json pnpm tincan daemon
```

**Never run Bluetooth MAP operations against a real phone in automated tests or CI.** All automated
tests run against `fake-phone` or in-process D-Bus mocks. Another Bluetooth messaging app or computer
may hold the phone's MAP session, so manual experiments on real hardware should be deliberate and run
by hand. Tests that drive core against a scripted phone live in `packages/fake-phone/tests`.

## Architecture & Conventions

See [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md) for the package layout,
dependency direction, and how to add new typed commands. Key rules:

- **Privacy:** Never log message text, phone numbers, or contact names in TypeScript or Rust. Log
  IDs and counts only. Fixtures and screenshots use synthetic data only (555 numbers, made-up names,
  example domains), never real conversations.
- **TypeScript:** Use `.ts` import extensions and erasable syntax only (no `enum`, `namespace`, or
  parameter properties). Tests import from `vite-plus/test`. Format with `pnpm exec vp check --fix`.
- **Rust:** No `unwrap()` outside tests; map failures to `TincanError` codes at the napi boundary.
- **Agent safety:** The agent policy is a usability control, not a security boundary. Changes that
  touch what agents can read or send need tests, and should keep the defaults conservative.
- **Commits:** Small, focused, conventional commits with tests. Never commit `dist/`, `target/`,
  or `*.node` binaries. A DCO sign-off isn't required.

## Submitting Changes

1. Open an issue first for large features or protocol changes.
2. Ensure `pnpm ready` passes, and if you touched Rust,
   `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
3. Update the docs (README, `docs/`, or the website under `website/`) when behaviour changes. If you
   add or remove a runtime dependency (npm or Cargo), regenerate the license notices with
   `node scripts/third-party-notices.mjs`; CI fails when `THIRD_PARTY_NOTICES.md` is stale.
4. Open a pull request describing the change and how you tested it. The PR template has a short
   checklist.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

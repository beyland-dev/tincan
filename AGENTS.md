# AGENTS.md

Guide for coding agents working on Tincan. How it fits together is in [docs/architecture.md](docs/architecture.md);
the original design, with a section per component, is in [docs/history/plan.md](docs/history/plan.md), and
what's next is in [docs/roadmap.md](docs/roadmap.md). Read the section for the component you're touching
before changing it.

## Layout

| Path                  | Package                      | What it is                                                              |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `packages/protocol`   | `@beyland/tincan-protocol`   | Zod entities, wire envelope, events, error codes, **command contracts** |
| `packages/core`       | `@beyland/tincan-core`       | Command registry, handlers, agent policy, event bus                     |
| `packages/daemon`     | `@beyland/tincan-daemon`     | Unix-socket NDJSON server, single-instance lock, native addon loading   |
| `packages/client`     | `@beyland/tincan-client`     | Typed socket client used by the CLI, MCP server and desktop app         |
| `packages/cli`        | `@beyland/tincan`            | The `tincan` binary; commands are generated from contracts              |
| `packages/native`     | `@beyland/tincan-native`     | JS wrapper for the Rust addon                                           |
| `packages/fake-phone` | `@beyland/tincan-fake-phone` | Scripted iPhone implementing core's `PhonePort`, for tests and demos    |
| `crates/tincan-bt`    | —                            | Pure Rust: BlueZ/OBEX over zbus, bMessage and vCard parsers             |
| `crates/tincan-napi`  | —                            | napi-rs bindings over `tincan-bt`                                       |

Dependency direction: `protocol` ← `core` ← `daemon` ← `cli`; `client` depends only on `protocol`.
Clients (CLI, MCP, desktop renderer) must never import `core`, `daemon` or `native`.
Core reaches the phone only through `PhonePort`; `fake-phone` depends on `core` and `protocol`, never `native`.
Tests that drive core against a scripted phone (e.g. the sync engine) live in `packages/fake-phone/tests`,
since core can't depend on `fake-phone`.

## Commands

```sh
pnpm install
pnpm check          # vp check: format, lint (type-aware), typecheck
pnpm test           # vp test in every package
pnpm build          # vp pack in every package
pnpm ready          # all of the above
pnpm tincan <args>  # run the CLI from source (e.g. `pnpm tincan daemon`, `pnpm tincan status`)

cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

Use `pnpm exec vp …` if `vp` isn't on your PATH. Run `pnpm exec vp check --fix` to format.

## Adding a command

1. Define the contract in `packages/protocol/src/contracts/<area>.ts` with `defineContract` (name, title,
   description, `kind`, zod `input` **and** `output`, plus `sensitive` / `approval` / `destructive` /
   `internal` / `positional` as needed). Add it to the tuple in `contracts/index.ts`.
2. Implement it in `packages/core/src/handlers/<area>.ts` with `registry.implement(contract, handler)`.
   Throw `TincanError` with a code from `errors.ts`; never throw bare strings.
3. Emit coarse events (`thread.changed`, `message.changed`, …) after mutations. Add new event payloads to
   `eventSchemas` in `envelope.ts`.
4. Test the handler in core and, if it has CLI-specific output, add a formatter in `packages/cli/src/main.ts`.

The CLI, `tincan commands`, `tincan schema` and (later) the MCP server and desktop API pick it up automatically.

## Conventions

- TypeScript runs directly from source under Node's type stripping: use `.ts` import extensions and only
  erasable syntax (no enums, namespaces or parameter properties).
- Tests import from `vite-plus/test`.
- Message text, phone numbers and contact names are **never logged**. Log ids and counts.
- The agent policy (`settings.agents`) is a usability control, not a security boundary: anything that can
  reach the socket is the user.
- Rust: no `unwrap()` outside tests; errors map to `TincanError` codes at the napi boundary.
- **Never run MAP operations against a real phone in tests or CI.** Another Bluetooth messaging app
  or computer may hold the phone's MAP session; ask the user before any live Bluetooth experiment.
- Commits: conventional, small, with tests. Don't commit `dist/`, `target/` or `*.node`.

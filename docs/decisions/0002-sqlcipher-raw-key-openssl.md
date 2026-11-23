# 0002. SQLCipher with a raw key, linked against system OpenSSL 3

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

The message store must be encrypted at rest and support full-text search. rusqlite can bundle
SQLCipher in two ways. `bundled-sqlcipher` links the system `libcrypto`.
`bundled-sqlcipher-vendored-openssl` builds OpenSSL from source into the binary. SQLCipher also
accepts either a passphrase, which it runs through PBKDF2, or a raw 256-bit key.

The Phase 0.3 spike measured SQLCipher 4.19.0 with FTS5 on x86_64: 1000 inserts plus FTS rows took
7–9 ms, and a `MATCH` query took under 1 ms. See [the Phase 0 notes](../history/native-phase-0.md#vault-phase-03-2026-10-31).

## Decision

- Use `bundled-sqlcipher` and link the system `libcrypto.so.3`.
- Key the database with 32 random bytes as a raw key (`PRAGMA key = "x'…'"`), with no PBKDF2.
- Turn off SQLCipher's stderr logging (`cipher_log_level = NONE`).

## Consequences

- The key is random rather than derived from a password, so PBKDF2 would only add open latency.
- The prebuilt addon needs OpenSSL 3, which current Fedora, Ubuntu 22.04+, Debian 12+ and Arch ship.
  Older distributions would fail to load it with a clear `dlopen` error. If that becomes a support
  problem, switch to the vendored feature and accept a larger binary and longer builds.
- OpenSSL security updates come from the distribution, not from Tincan releases.
- The arm64 build is still to verify.

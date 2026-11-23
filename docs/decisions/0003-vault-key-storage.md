# 0003. Where the vault key lives, and when it falls back to a file

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

The vault key ([0002](0002-sqlcipher-raw-key-openssl.md)) must survive restarts without asking the
user for anything. Some systems have no Secret Service: headless machines, minimal window managers,
or a missing default collection. Silently making a new key would orphan an existing database, and
silently writing the key to a file when the user refused a keyring prompt would ignore their choice.

## Decision

The key is resolved in this order:

1. If a key file exists next to the database, use it. Refuse it if it is group- or
   world-readable.
2. Otherwise, look the key up in the Secret Service under `xdg:schema=dev.beyland.Tincan.VaultKey`,
   `vault=<id>`. It is stored as 64 hex characters, `text/plain`.
3. If there is no Secret Service or no default collection, use a mode 0600 key file in the
   database's 0700 directory.

A new key is only generated when the database does not exist yet. A database whose key can't be
found fails with `NOT_FOUND`. A dismissed unlock prompt fails with `PERMISSION_DENIED` and never
falls back to a file.

## Consequences

- Tincan works on systems without a keyring, with file-permission protection only. `doctor` reports
  which storage is in use, and `warn`s for the file.
- An existing key file keeps winning even after a keyring appears. Moving the key into the keyring is
  an explicit future command, not an automatic step.
- Losing the key means losing the store. The store is a cache of the phone, so recovery is a full
  re-sync rather than data loss.

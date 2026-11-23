# 0001. Talk to the Secret Service directly over zbus 6

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

`tincan-bt` uses zbus 6 for BlueZ and obexd. The vault key has to be stored in the user's keyring
(GNOME Keyring or KWallet) through the freedesktop Secret Service API. The existing crates, `oo7` and
`secret-service`, depend on zbus 5. Using either would put two zbus versions, and two D-Bus connection
stacks, into one addon.

## Decision

`tincan-vault` contains a small Secret Service client written against zbus 6
(`crates/tincan-vault/src/secret_service.rs`). It covers what Tincan needs: open a session, search,
create an item, get a secret, unlock, and complete prompts.

It uses the `plain` session algorithm. The secret crosses the user's own session bus unencrypted.
Under Tincan's threat model this is no weaker than DH-AES: anything that can read that bus is already
the user.

## Consequences

- One zbus version and one async runtime in the addon. The binary is smaller and builds faster.
- About 300 lines of code to maintain. It is tested against a fake keyring served over a p2p zbus
  connection (`crates/tincan-vault/tests/secret_service.rs`), including prompt signals.
- Tested live against GNOME Keyring. KWallet's Secret Service bridge is untested.
- When `oo7` moves to zbus 6, re-evaluate and consider switching to it to get DH-AES sessions.

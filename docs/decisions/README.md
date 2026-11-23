# Architecture decisions

Short records of decisions that are expensive to reverse. Each one states the context, the decision and
its consequences. To change a decision, add a new record that supersedes the old one; don't rewrite it.

| #                                         | Decision                                                    | Status   |
| ----------------------------------------- | ----------------------------------------------------------- | -------- |
| [0001](0001-zbus-6-secret-service.md)     | Talk to the Secret Service directly over zbus 6             | Accepted |
| [0002](0002-sqlcipher-raw-key-openssl.md) | SQLCipher with a raw key, linked against system OpenSSL 3   | Accepted |
| [0003](0003-vault-key-storage.md)         | Where the vault key lives, and when it falls back to a file | Accepted |
| [0004](0004-daemon-runtime.md)            | Run the daemon as Node, never as an Electron main process   | Accepted |
| [0005](0005-device-class.md)              | Set the Bluetooth Class of Device with a privileged unit    | Accepted |
| [0006](0006-map-sync-model.md)            | MAP sync: events for arrivals, the local store for history  | Accepted |
| [0007](0007-sync-ready-store.md)          | A sync-ready message store (for multi-computer sync later)  | Accepted |

Template: `# NNNN. Title`, then **Status**, **Date**, and the sections Context, Decision, Consequences.

# 0007. A sync-ready message store

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

The likely setup is a desktop that runs the overnight iPhone backup sync and a laptop that is off overnight
and holds the Bluetooth connection during the day. The laptop should pick up what the desktop filled in
(messages sent from the phone, attachments, older history) when it wakes. Multi-computer sync is a backlog
item, not a Phase 3 feature.

Merging two stores is easy if the schema allows it from the start: messages almost never change after they
arrive, so a merge is mostly a union with duplicates dropped. Retrofitting it means changing every stored
message id, which is a risky migration on encrypted user data. The Phase 3 schema hasn't shipped yet.

## Decision

The Phase 3 store follows four rules, even though nothing syncs yet:

1. **Stable ids.** A message's `id` is assigned once and never changes, and two computers that see the same
   message assign the same id.
   - MAP and ANCS messages: a deterministic id, a hash of the phone, thread key, direction, the phone's
     timestamp, the body and an occurrence index (for identical texts in the same second). MAP handles aren't
     ids; they stay a per-device dedupe key ([ADR 0006](0006-map-sync-model.md)).
   - Messages sent from Tincan: a random UUIDv7 created by the computer that sent it.
   - Messages imported from a backup later: if they match an existing message, it keeps its id and gains
     Apple's message GUID as an alias (unique); otherwise the id is derived from the GUID.
2. **Provenance and change clocks.** Every row that can sync records `origin` (a random per-install computer
   id kept in `settings`) and `updated_at` as a hybrid logical clock, which stays ordered even when the
   computers' clocks disagree. Fields that change after arrival (read, muted, hidden, pinned, group name and
   roster, reaction and group assignment) merge last-writer-wins by that clock. A local, increasing change
   sequence on each row makes "everything changed since X" a cheap query.
3. **Tombstones.** Deleting a message, thread, contact or group sets `deleted_at` instead of removing the row,
   so the deletion can reach other computers. Queries filter tombstones out.
4. **Content-addressed attachments.** Attachment files are stored by SHA-256 (`blobs/<sha256>`) with a row per
   file and a link per message, so the same file is stored and transferred once and can be fetched lazily.

These stay local to each computer and never sync: drafts, the outbox, approvals, the agent policy and other
settings, `sync_state`, gaps (what this computer missed) and whether this computer has notified about a
message. The coverage watermark from a backup sync does sync.

## Consequences

- Phase 3 gets slightly larger (about a day or two): deterministic ids, clock columns, tombstone filtering and
  a change sequence, each with tests. No sync code is written.
- Later sync becomes an add-on (about one to two weeks once backup sync exists): export the changes since a
  peer's last sequence, encrypt them, transfer them, merge. The transport is decided then: a synced folder
  (Syncthing, Nextcloud), a direct LAN connection between paired computers, or Iroh.
- Messages merged in from another computer are stored as already notified, so a waking laptop doesn't
  replay notifications.
- Tombstones keep deleted rows in the encrypted store. Purging them safely needs every peer to have seen them;
  that's for the sync design to settle.
- The deterministic id depends on the phone's timestamp and body staying identical across computers. If a
  hardware check shows otherwise, the content-hash fallback still merges them, but ids could diverge.

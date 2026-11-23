# 0006. MAP sync: events for arrivals, the local store for history

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

The Phase 0.1 spike against an iPhone ([the Phase 0 notes](../history/native-phase-0.md#map-phase-01-2026-10-31)) found:

- MNS `NewMessage` reports arrive live. obexd turns each one into a message object with `Status`
  `notification`, and the message can be fetched straight away.
- obexd also announces every object a listing creates (`InterfacesAdded`, `Status` `complete`), so
  "an object appeared" doesn't mean "a message arrived".
- iOS lists only the 10 most recent inbox messages. `sent`, `outbox` and `deleted` are always empty.
- iOS sends no read-status reports; read changes made on the phone show only in the next listing.
- `GetMessage` doesn't mark a message read.
- `PushMessage` to `outbox` (relative to `/telecom/msg`) works. iOS sends no `SendingSuccess` or
  `DeliverySuccess` report, and pushed messages don't appear in `sent` or `outbox`.

## Decision

- A message arrival is a `StatusChanged { status: "notification" }` event. The sync engine fetches the
  bMessage then. `MessageAdded` alone never creates a message.
- The local store is the history. Tincan stores every message the first time it sees it, from a listing
  or an event, and never deletes one because it dropped out of the phone's 10-message window.
- Sent messages exist only in Tincan's outbox. Messages sent from the phone itself aren't shown.
- Tincan pushes to `outbox`. A completed push transfer marks the message `sent`; a failed transfer
  marks it `failed`; a transfer that neither completes nor fails before the timeout marks it
  `unknown`. Tincan doesn't wait for MNS sending reports.
- After every (re)connect, Tincan subscribes to events **before** listing, then lists the inbox and
  merges by handle. While connected it re-lists the inbox periodically (a listing costs about 50 ms)
  to pick up read changes made on the phone.
- Fetching a message to show or notify about it is safe: it leaves the phone's unread state alone.
  Marking read on the phone is an explicit `SetMessageRead`.
- Opening a session is retried with backoff by the reconnect supervisor; one open failed with a
  transient obexd `Internal Server Error` right after a previous session closed.

## Consequences

- A first sync shows at most 10 messages, so onboarding should say history starts now.
- Message rows can't rely on the phone to still list them; the handle is a dedupe key, not a
  reference to fetch again later.
- The periodic re-list is a small but constant Bluetooth cost. Its interval is a Phase 3 setting.
- "Sent" can't distinguish a message the phone accepted but couldn't deliver. The UI says "sent",
  never "delivered".

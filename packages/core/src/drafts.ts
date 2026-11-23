import type { AgentDraft, AgentDraftState, ClientInfo } from "@beyland/tincan-protocol";
import { redactForAgents } from "./agent-privacy.ts";
import type { Core } from "./core.ts";
import type { EventBus } from "./events.ts";
import type { Store } from "./store/store.ts";

/** At most this many agent drafts wait in one conversation's composer, from all agents. */
export const QUEUE_CAP_PER_CONVERSATION = 5;
/** At most this many agent drafts from one agent wait, across conversations. */
export const QUEUE_CAP_PER_AGENT = 20;
/**
 * A send timer that fires this much after its time (the computer was asleep, or the clock jumped)
 * doesn't send: the user may no longer be around to undo it.
 */
export const STALE_SEND_MS = 15_000;

/** Announces a draft's change: `threadKey` is the conversation it belongs (or will belong) to. */
export function emitDraftChanged(events: EventBus, draft: AgentDraft): void {
  events.emit("draft.changed", { id: draft.id, state: draft.state, threadKey: draft.to });
}

/** The draft state that follows from its message's status (null: the message is gone). */
function stateFor(status: string | null, current: AgentDraftState): AgentDraftState | null {
  switch (status) {
    case null:
      return current === "scheduled" ? "cancelled" : null;
    case "scheduled":
    case "pending":
      return "scheduled";
    case "sent":
    case "unknown":
      // `unknown`: handed to the phone, which never answered. Saying `failed` would invite the
      // agent to send it again.
      return "sent";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Keeps an agent draft's state in step with the message it was sent as: called whenever that
 * message's status changes (or it's deleted).
 */
export function syncDraftWithMessage(store: Store, events: EventBus, messageId: string): void {
  const draft = store.agentDraftForMessage(messageId);
  if (!draft || draft.state === "queued") return;
  const message = store.getMessage(messageId);
  const next = stateFor(message?.status ?? null, draft.state);
  if (!next || next === draft.state) return;
  const changed = store.setAgentDraftState(draft.id, next);
  if (changed) emitDraftChanged(events, changed);
}

/**
 * A scheduled agent message was taken back before it reached the phone (its message is already
 * gone): `requeue` puts the draft back at the front of its conversation's queue, edits kept;
 * otherwise it's `cancelled`.
 */
export function takeBackDraft(
  store: Store,
  events: EventBus,
  draftId: string,
  requeue: boolean,
): AgentDraft | null {
  const draft = store.setAgentDraftState(draftId, requeue ? "queued" : "cancelled", {
    from: ["scheduled"],
    messageId: null,
    front: requeue,
  });
  if (draft) emitDraftChanged(events, draft);
  return draft;
}

/**
 * An agent draft as `client` may see it. The desktop app and CLI see everything. An agent (only
 * ever shown its own) sees what it typed for the recipient when that was a raw address while
 * handles are hidden, else the masked key; never `note`; and the current text and message only
 * while it may read the conversation, so a hidden or out-of-scope one looks like a brand-new
 * recipient.
 */
export function presentDraft(core: Core, client: ClientInfo, draft: AgentDraft): AgentDraft {
  if (client.kind !== "mcp") return draft;
  const store = core.store;
  const mask = core.maskHandles(client);
  const readable =
    draft.requestedAs === undefined &&
    core.agentThreadAccess(client, store?.getThread(draft.to) ?? draft.to) === null;
  const maskKey = (key: string) => (mask ? core.handleMasker.mask(key) : key);
  const view: AgentDraft = {
    id: draft.id,
    threadKey: readable && draft.threadKey ? maskKey(draft.threadKey) : null,
    to: draft.requestedAs ?? maskKey(draft.to),
    agentName: draft.agentName,
    intent: draft.intent,
    body: draft.body,
    edited: draft.edited,
    revision: draft.revision,
    state: draft.state,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    resolvedAt: draft.resolvedAt,
  };
  if (readable) {
    if (draft.text !== undefined) {
      view.text = core.hideCodes(client) ? redactForAgents(draft.text) : draft.text;
    }
    if (draft.messageId !== undefined) {
      view.messageId = mask ? core.handleMasker.maskMessageId(draft.messageId) : draft.messageId;
    }
  }
  return view;
}

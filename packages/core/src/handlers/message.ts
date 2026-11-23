import {
  TincanError,
  message,
  type AgentDraft,
  type AgentDraftNote,
  type ClientInfo,
  type Message,
  type SendResult,
} from "@beyland/tincan-protocol";
import { hasAgentSecret } from "../agent-privacy.ts";
import type { Core } from "../core.ts";
import {
  emitDraftChanged,
  presentDraft,
  QUEUE_CAP_PER_AGENT,
  QUEUE_CAP_PER_CONVERSATION,
  syncDraftWithMessage,
  takeBackDraft,
} from "../drafts.ts";
import { canReply, handleFor, normalizeThreadKey } from "../keys.ts";
import type { CommandRegistry, HandlerContext } from "../registry.ts";
import { isRawAddress } from "../registry.ts";
import { assertAgentCanAccessThread, presentMessage, resolveThreadTarget } from "./common.ts";

export function messageHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(message.list, (input, { core, client }) => {
      const store = core.requireStore();
      const key = resolveThreadTarget(core, input.threadKey, client);
      assertAgentCanReadThread(core, client, key);
      return store
        .listMessages(key, {
          limit: input.limit,
          before: input.before,
        })
        .map((m) => presentMessage(core, client, m));
    })
    .implement(message.search, (input, { core, client }) => {
      const store = core.requireStore();
      const threadKey = input.threadKey
        ? resolveThreadTarget(core, input.threadKey, client)
        : undefined;
      if (threadKey) assertAgentCanReadThread(core, client, threadKey);
      const wanted = Math.min(500, Math.max(1, input.limit ?? 50));
      if (client.kind !== "mcp") return store.search(input.query, { threadKey, limit: wanted });
      // What agents may read is part of the query. A text with a code or sign-in link stays out of
      // results entirely, so searching can't probe what was redacted: page past those so they
      // don't starve the results.
      const agentScope = core.agentScope(client);
      const batch = Math.min(500, Math.max(wanted * 4, 200));
      const out: Message[] = [];
      for (let offset = 0; out.length < wanted; offset += batch) {
        const matches = store.search(input.query, { threadKey, limit: batch, offset, agentScope });
        for (const m of matches) {
          if (core.hideCodes(client) && hasAgentSecret(m.body)) continue;
          out.push(presentMessage(core, client, m));
          if (out.length >= wanted) break;
        }
        if (matches.length < batch) break;
      }
      return out;
    })
    .implement(message.send, async (input, context) => {
      const { core, client } = context;
      if (client.kind === "mcp") return agentSend(core, client, input, context);
      const outbox = core.requireService("outbox");
      const key = resolveRecipient(core, input.to, client);
      const sent = await outbox.send(key, input.text, {
        delayMs: core.settings.sendDelaySeconds * 1000,
      });
      core.store?.saveDraft(key, "");
      return sendResult(sent);
    })
    .implement(message.retry, async (input, { core }) => {
      const retried = await core.requireService("outbox").retry(input.id);
      return retried;
    })
    .implement(message.cancel, (input, { core }) => {
      const store = core.requireStore();
      const found = store.getMessage(input.id);
      const outbox = core.services.outbox;
      let cancelled: { threadKey: string; body: string; agentDraftId: string | null };
      if (outbox) {
        cancelled = outbox.cancel(input.id);
      } else {
        // No phone services (disconnected): nothing is pushing, so take it back here.
        const result = store.cancelOutgoing(input.id);
        if (result === null) throw new TincanError("NOT_FOUND", "No such message");
        if (result === "busy") throw new TincanError("CONFLICT", "Already sending");
        cancelled = result;
        core.events.emit("message.changed", { threadKey: result.threadKey, ids: [input.id] });
        core.events.emit("thread.changed", { keys: [result.threadKey] });
      }
      // A user-sent agent draft goes back to its queue on Undo with `requeue`; an agent's direct
      // send is cancelled unless the user chose to edit it (`requeue`).
      const requeue = input.requeue === true;
      const draft = cancelled.agentDraftId
        ? takeBackDraft(store, core.events, cancelled.agentDraftId, requeue)
        : null;
      return {
        id: input.id,
        threadKey: found?.threadKey ?? cancelled.threadKey,
        text: cancelled.body,
        ...(draft ? { draft } : {}),
      };
    })
    .implement(message.sendNow, (input, { core }) =>
      core.requireService("outbox").sendNow(input.id),
    )
    .implement(message.draftSave, (input, context) =>
      context.client.kind === "mcp"
        ? agentDraftSave(context, input)
        : userDraftSave(context, input),
    )
    .implement(message.draftList, (input, { core }) =>
      // Internal: only the user's own clients get here. Only replyable recipients, so a draft
      // stored under any other key never shows up as somewhere to send.
      core
        .requireStore()
        .newRecipientDrafts(input.limit ?? 50)
        .filter((d) => canReply(d.to)),
    )
    .implement(message.remove, (input, { core }) => {
      const store = core.requireStore();
      const deleted: string[] = [];
      const byThread = new Map<string, string[]>();
      store.db.transaction(() => {
        for (const id of new Set(input.ids)) {
          const found = store.getMessage(id);
          if (!found || !store.deleteMessage(id)) continue;
          deleted.push(id);
          byThread.set(found.threadKey, [...(byThread.get(found.threadKey) ?? []), id]);
        }
      });
      for (const [threadKey, ids] of byThread)
        core.events.emit("message.changed", { threadKey, ids });
      // A scheduled message deleted before it went: its agent draft, if any, is cancelled.
      for (const id of deleted) syncDraftWithMessage(store, core.events, id);
      if (byThread.size > 0) core.events.emit("thread.changed", { keys: [...byThread.keys()] });
      return { deleted };
    });
}

/** A send's result for the desktop app or CLI. */
export function sendResult(sent: Message): SendResult {
  return sent.status === "scheduled"
    ? { outcome: "scheduled", message: sent, ...(sent.sendAt ? { sendAt: sent.sendAt } : {}) }
    : { outcome: "sent", message: sent };
}

/**
 * An agent's `message.send`: queued as an agent draft for the user, or (as the send policy
 * allows) sent directly after the agent send delay, tracked by a draft either way. Never waits for
 * the user.
 */
async function agentSend(
  core: Core,
  client: ClientInfo,
  input: { to: string; text: string },
  context: HandlerContext,
): Promise<SendResult> {
  const store = core.requireStore();
  const key = resolveRecipient(core, input.to, client);
  assertSendable(key);
  const decision = context.agentSend ?? { queue: true };
  const agentName = agentDisplayName(client.name);
  if (decision.queue) {
    // The same text to the same recipient while the last one is still queued: an MCP host
    // retrying. It's the same draft, and costs no new send.
    const repeat = store
      .listAgentDrafts({ states: ["queued"], to: key, agentName, limit: 500 })
      .find((d) => d.intent === "send" && d.text === input.text);
    if (repeat) {
      context.slot?.release();
      return { outcome: "queued", draft: presentDraft(core, client, repeat) };
    }
    const draft = queueAgentDraft(core, {
      to: key,
      requestedAs: decision.requestedAs,
      agentName,
      intent: "send",
      text: input.text,
      note: decision.note,
    });
    return { outcome: "queued", draft: presentDraft(core, client, draft) };
  }
  // The send policy let this go, to whoever it decided; it never lets an agent send directly to
  // what's hidden from it unless the user gave it `full` access.
  assertAgentMaySendTo(core, client, key);
  const outbox = core.requireService("outbox");
  const draft = store.insertAgentDraft({
    to: key,
    requestedAs: decision.requestedAs,
    agentName,
    intent: "send",
    text: input.text,
    state: "scheduled",
    note: decision.note,
  });
  let sent: Message;
  try {
    sent = await outbox.send(key, input.text, {
      byAgent: true,
      agent: { name: agentName, edited: false, via: "policy" },
      delayMs: core.agents.sendDelaySeconds * 1000,
      agentDraftId: draft.id,
    });
  } catch (error) {
    // It never got as far as the outbox: nothing to track.
    if (!store.getAgentDraft(draft.id)?.messageId) store.deleteAgentDraft(draft.id);
    throw error;
  }
  const current = store.getAgentDraft(draft.id) ?? draft;
  const readable = core.agentThreadAccess(client, store.getThread(key) ?? key) === null;
  return {
    outcome: sent.status === "scheduled" ? "scheduled" : "sent",
    draft: presentDraft(core, client, current),
    ...(readable && !decision.requestedAs ? { message: presentMessage(core, client, sent) } : {}),
    ...(sent.sendAt ? { sendAt: sent.sendAt } : {}),
  };
}

/** Tincan sends only to a phone number or email address. */
function assertSendable(key: string): void {
  if (!canReply(key)) {
    throw new TincanError(
      "INVALID_INPUT",
      key.startsWith("group:")
        ? "Group conversations can't be sent to"
        : "Tincan can only send to a phone number or email address",
    );
  }
}

/** Queues a new agent draft, within the caps (`BUSY` past them). */
export function queueAgentDraft(
  core: Core,
  input: {
    to: string;
    requestedAs?: string;
    agentName: string;
    intent: AgentDraft["intent"];
    text: string;
    note?: AgentDraftNote;
  },
): AgentDraft {
  const store = core.requireStore();
  if (store.countQueuedAgentDrafts({ to: input.to }) >= QUEUE_CAP_PER_CONVERSATION) {
    throw new TincanError(
      "BUSY",
      `Up to ${QUEUE_CAP_PER_CONVERSATION} agent drafts can wait in a conversation. Ask the user to send or discard some first.`,
    );
  }
  if (store.countQueuedAgentDrafts({ agentName: input.agentName }) >= QUEUE_CAP_PER_AGENT) {
    throw new TincanError(
      "BUSY",
      `Up to ${QUEUE_CAP_PER_AGENT} of your drafts can wait for the user. Ask them to send or discard some first.`,
    );
  }
  const draft = store.insertAgentDraft({ ...input, state: "queued" });
  emitDraftChanged(core.events, draft);
  core.events.emit("thread.changed", { keys: [input.to] });
  return draft;
}

/** The desktop app or CLI saving the user's own draft. */
function userDraftSave(
  { core, client }: HandlerContext,
  input: { threadKey?: string; to?: string; text: string; id?: string },
): { threadKey: string; saved: boolean; deleted: boolean } {
  const store = core.requireStore();
  if (input.id !== undefined) {
    throw new TincanError("INVALID_INPUT", "Edit an agent draft with draft.update");
  }
  const target = input.threadKey ?? input.to;
  if (target === undefined) throw new TincanError("INVALID_INPUT", "Give threadKey or to");
  const key = resolveThreadTarget(core, target, client);
  // Someone with no conversation yet must be someone Tincan can send to.
  if (input.to !== undefined && !store.getThread(key)) assertSendable(key);
  store.saveDraft(key, input.text);
  core.events.emit("thread.changed", { keys: [key] });
  const cleared = input.text === "";
  return { threadKey: key, saved: !cleared, deleted: cleared };
}

/**
 * An agent's `message.draft.save`: an agent draft, always queued for the user whatever the send
 * policy says, never touching the user's own draft. See the contract for `id`, `to` and empty
 * text.
 */
function agentDraftSave(
  { core, client }: HandlerContext,
  input: { threadKey?: string; to?: string; text: string; id?: string },
): { threadKey: string | null; saved: boolean; deleted: boolean; draft?: AgentDraft } {
  const store = core.requireStore();
  const agentName = agentDisplayName(client.name);
  if (input.threadKey !== undefined && input.to !== undefined) {
    throw new TincanError("INVALID_INPUT", "Give threadKey or to, not both");
  }
  let key: string | undefined;
  let requestedAs: string | undefined;
  let note: AgentDraftNote | undefined;
  if (input.threadKey !== undefined) {
    key = resolveThreadTarget(core, input.threadKey, client);
    // A conversation that doesn't exist yet counts by its key: a saved contact's, under
    // `contacts` or `known`, may get a draft before anyone has written.
    assertAgentCanAccessThread(core, client, store.getThread(key) ?? key);
  } else if (input.to !== undefined) {
    // As for message.send: a raw number while handles are hidden is echoed back as typed, and a
    // recipient the agent may not read gets a draft like any new one (the user sees why).
    key = resolveRecipient(core, input.to, client);
    if (core.maskHandles(client) && isRawAddress(core, input.to)) requestedAs = input.to.trim();
    note = core.agentThreadAccess(client, store.getThread(key) ?? key) ?? undefined;
  }
  if (key !== undefined) assertSendable(key);

  const view = (draft: AgentDraft) => presentDraft(core, client, draft);
  let existing: AgentDraft | null = null;
  if (input.id !== undefined) {
    const found = store.getAgentDraft(input.id);
    if (!found || found.agentName !== agentName)
      throw new TincanError("NOT_FOUND", "No such draft");
    if (key !== undefined && found.to !== key) {
      throw new TincanError("INVALID_INPUT", "That draft is for another conversation");
    }
    if (found.state !== "queued") {
      throw new TincanError("CONFLICT", `The draft is ${found.state}`);
    }
    if (found.edited) {
      throw new TincanError(
        "CONFLICT",
        "The user has edited this draft; Tincan won't change it for an agent. Save a new one instead.",
      );
    }
    existing = found;
  } else {
    if (key === undefined) throw new TincanError("INVALID_INPUT", "Give threadKey, to or id");
    existing =
      store
        .listAgentDrafts({ states: ["queued"], to: key, agentName, limit: 500 })
        .find((d) => d.intent === "draft" && !d.edited) ?? null;
  }

  if (input.text === "") {
    // Withdrawing: the agent's own untouched draft is discarded; there may be none.
    const discarded = existing
      ? store.setAgentDraftState(existing.id, "discarded", { from: ["queued"] })
      : null;
    if (discarded) {
      emitDraftChanged(core.events, discarded);
      core.events.emit("thread.changed", { keys: [discarded.to] });
    }
    const shown = discarded ? view(discarded) : null;
    return {
      threadKey: shown?.threadKey ?? null,
      saved: false,
      deleted: true,
      ...(shown ? { draft: shown } : {}),
    };
  }

  let draft: AgentDraft;
  if (existing) {
    const updated = store.setAgentDraftText(existing.id, input.text, { byAgent: true });
    if (!updated) throw new TincanError("CONFLICT", "The draft changed; try again");
    draft = updated;
    emitDraftChanged(core.events, draft);
    core.events.emit("thread.changed", { keys: [draft.to] });
  } else {
    draft = queueAgentDraft(core, {
      to: key!,
      requestedAs,
      agentName,
      intent: "draft",
      text: input.text,
      note,
    });
  }
  const shown = view(draft);
  return { threadKey: shown.threadKey, saved: true, deleted: false, draft: shown };
}

/**
 * Refuses an agent a conversation to read: one it may not touch, or one that doesn't exist (which
 * looks the same).
 */
function assertAgentCanReadThread(core: Core, client: ClientInfo, key: string): void {
  if (client.kind !== "mcp") return;
  const found = core.requireStore().getThread(key);
  if (!found) throw new TincanError("NOT_FOUND", "No such conversation");
  assertAgentCanAccessThread(core, client, found);
}

/**
 * Refuses an agent's send the user didn't approve to someone hidden from agents (at every access
 * level), or a short code while those are hidden (the send policy asks the user about those). One
 * outside what agents may read is the policy's to allow, and so is a short code with `full`
 * access (`guardHidden` false), where the user chose to let agents send anywhere.
 */
function assertAgentMaySendTo(core: Core, client: ClientInfo, key: string): void {
  if (client.kind !== "mcp") return;
  const access = core.agentThreadAccess(client, core.store?.getThread(key) ?? key);
  if (access === "hidden" || (access === "shortCode" && core.agents.guardHidden)) {
    throw new TincanError("NOT_FOUND", "No such conversation");
  }
}

/**
 * An agent's self-reported name as shown beside its draft: control and invisible formatting
 * characters dropped, whitespace collapsed, at most 64 characters (graphemes). Clients choose their own
 * names, so this is a label, not an identity.
 */
export function agentDisplayName(name: string): string {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const graphemes = Array.from(NAME_SEGMENTER.segment(clean), (part) => part.segment);
  return graphemes.slice(0, 64).join("").trim() || "An AI agent";
}

const NAME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The one-to-one thread `to` names: an opaque handle ID, a thread key, a phone number or email
 * address, or a contact's name. Errors never repeat the name or number.
 */
export function resolveRecipient(core: Core, to: string, client?: ClientInfo): string {
  const region = core.settings.defaultRegion;
  const text = to.trim();
  if (text.startsWith("handle:")) {
    const resolved = core.handleMasker.unmask(text, core.store);
    if (!resolved) throw new TincanError("NOT_FOUND", "No such conversation");
    return resolved;
  }
  const key = normalizeThreadKey(text, region);
  if (key) return key;
  if (text.includes("@") || !/\p{L}/u.test(text)) {
    const handle = handleFor(text, region);
    if (!handle) throw new TincanError("INVALID_INPUT", "Not a phone number or email address");
    return handle;
  }
  if (client?.kind === "mcp" && core.agents.read === "off") {
    throw new TincanError(
      "PERMISSION_DENIED",
      "Looking up contacts by name requires agent read access (agents.read).",
    );
  }
  const store = core.requireStore();
  // A person hidden from agents isn't there for them by name.
  const found = store.searchContacts(text, {
    limit: 20,
    nameOnly: client ? core.maskHandles(client) : false,
    excludeAgentHidden: client?.kind === "mcp",
  });
  const exact = found.filter((c) => c.name.toLowerCase() === text.toLowerCase());
  const rawCandidates = exact.length > 0 ? exact : found;
  if (rawCandidates.length === 0) throw new TincanError("NOT_FOUND", "No contact matches");
  // Ignore duplicate cards with no replyable phone/email when a usable card matches.
  const usable = rawCandidates.filter((c) => c.handles.some(canReply));
  if (usable.length === 0) {
    throw new TincanError("INVALID_INPUT", "The contact has no phone number or email address");
  }
  if (usable.length > 1) {
    throw new TincanError(
      "INVALID_INPUT",
      `${usable.length} contacts match; use a thread key, opaque handle ID, phone number or email address`,
    );
  }
  const handles = usable[0]!.handles.filter(canReply);
  if (handles.length === 1) return handles[0]!;
  // Several: the one the conversation is already happening on, among those the caller may see
  // (an agent's choice must not reveal a hidden conversation, or one it may not read).
  const recent = handles
    .map((handle) => {
      const found = store.getThread(handle);
      const visible = found && client ? core.agentThreadAccess(client, found) === null : true;
      const last = visible ? found?.lastMessage : null;
      return { handle, at: last ? (last.sentAt ?? last.receivedAt) : null };
    })
    .filter((h) => h.at !== null)
    .sort((a, b) => b.at! - a.at!);
  if (recent[0]) return recent[0].handle;
  throw new TincanError(
    "INVALID_INPUT",
    `The contact has ${handles.length} numbers or addresses; use one of them`,
  );
}

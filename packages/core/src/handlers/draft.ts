import {
  TincanError,
  draft,
  type AgentDraft,
  type AgentDraftState,
  type ClientInfo,
} from "@beyland/tincan-protocol";
import type { Core } from "../core.ts";
import { emitDraftChanged, presentDraft } from "../drafts.ts";
import type { CommandRegistry } from "../registry.ts";
import { resolveThreadTarget } from "./common.ts";
import { agentDisplayName, sendResult } from "./message.ts";

const OUTSTANDING: AgentDraftState[] = ["queued", "scheduled"];

export function draftHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(draft.list, (input, { core, client }) => {
      const store = core.requireStore();
      const agent = client.kind === "mcp";
      const to = input.threadKey ? recipientKey(core, client, input.threadKey) : undefined;
      return store
        .listAgentDrafts({
          states: input.states ?? OUTSTANDING,
          to,
          agentName: agent ? agentDisplayName(client.name) : undefined,
          limit: input.limit,
        })
        .map((d) => presentDraft(core, client, d));
    })
    .implement(draft.get, async (input, { core, client }) => {
      const found = requireDraft(core, client, input.id);
      const waitMs = (input.wait ?? 0) * 1000;
      if (waitMs > 0) await stateChange(core, found, waitMs);
      return presentDraft(core, client, requireDraft(core, client, input.id));
    })
    .implement(draft.update, (input, { core, client }) => {
      const store = core.requireStore();
      const found = requireDraft(core, client, input.id);
      if (found.state !== "queued")
        throw new TincanError("CONFLICT", `The draft is ${found.state}`);
      const updated = store.setAgentDraftText(found.id, input.text, { revision: input.revision });
      if (!updated) {
        throw new TincanError("CONFLICT", "The draft changed since it was loaded", {
          revision: store.getAgentDraft(found.id)?.revision,
        });
      }
      emitDraftChanged(core.events, updated);
      return updated;
    })
    .implement(draft.send, async (input, { core, client }) => {
      const store = core.requireStore();
      const found = requireDraft(core, client, input.id);
      if (found.state !== "queued")
        throw new TincanError("CONFLICT", `The draft is ${found.state}`);
      if (input.revision !== undefined && input.revision !== found.revision) {
        throw new TincanError("CONFLICT", "The draft changed since it was loaded", {
          revision: found.revision,
        });
      }
      const outbox = core.requireService("outbox");
      let current = found;
      const text = input.text ?? found.text ?? found.body;
      if (text !== found.text) {
        const updated = store.setAgentDraftText(found.id, text, { revision: found.revision });
        if (!updated) throw new TincanError("CONFLICT", "The draft changed since it was loaded");
        current = updated;
      }
      // It stays the agent's message, edited or not: it never counts as one the user sent
      // themselves (so it can't unlock `known` or `replied` for agents).
      const sent = await outbox.send(current.to, text, {
        byAgent: true,
        agent: { name: current.agentName, edited: current.edited, via: "user" },
        delayMs: core.agents.sendDelaySeconds * 1000,
        agentDraftId: current.id,
      });
      const after = store.getAgentDraft(current.id) ?? current;
      const result = sendResult(sent);
      return {
        outcome: result.outcome === "scheduled" ? ("scheduled" as const) : ("sent" as const),
        draft: after,
        message: sent,
        ...(result.sendAt ? { sendAt: result.sendAt } : {}),
      };
    })
    .implement(draft.discard, (input, { core, client }) => {
      const store = core.requireStore();
      const found = requireDraft(core, client, input.id);
      if (found.state === "discarded") return presentDraft(core, client, found);
      if (found.state !== "queued")
        throw new TincanError("CONFLICT", `The draft is ${found.state}`);
      const discarded = store.setAgentDraftState(found.id, "discarded", { from: ["queued"] });
      if (!discarded) throw new TincanError("CONFLICT", "The draft changed; try again");
      emitDraftChanged(core.events, discarded);
      core.events.emit("thread.changed", { keys: [discarded.to] });
      return presentDraft(core, client, discarded);
    })
    .implement(draft.restore, (input, { core, client }) => {
      const store = core.requireStore();
      const found = requireDraft(core, client, input.id);
      if (found.state === "queued") return found;
      const restored = store.setAgentDraftState(found.id, "queued", { from: ["discarded"] });
      if (!restored) throw new TincanError("CONFLICT", `The draft is ${found.state}`);
      emitDraftChanged(core.events, restored);
      core.events.emit("thread.changed", { keys: [restored.to] });
      return restored;
    });
}

/** The draft, or `NOT_FOUND`; an agent finds only its own. */
function requireDraft(core: Core, client: ClientInfo, id: string): AgentDraft {
  const found = core.requireStore().getAgentDraft(id.trim());
  if (!found || (client.kind === "mcp" && found.agentName !== agentDisplayName(client.name))) {
    throw new TincanError("NOT_FOUND", "No such draft");
  }
  return found;
}

/**
 * The recipient key a `threadKey` filter names. Agents' drafts are their own, so a conversation
 * they may not read still filters (their view never shows more than they wrote).
 */
function recipientKey(core: Core, client: ClientInfo, raw: string): string {
  return resolveThreadTarget(core, raw, client);
}

/** Resolves once the draft's state differs from `draft`'s, or after `waitMs`. */
function stateChange(core: Core, draft: AgentDraft, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => done(), waitMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    unsubscribe = core.events.subscribe((event) => {
      if (event.event === "draft.changed" && event.data.id === draft.id) {
        if (event.data.state !== draft.state) done();
      } else if (event.event === "daemon.stopping") done();
    });
  });
}

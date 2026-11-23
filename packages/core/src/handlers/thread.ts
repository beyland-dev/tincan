import { thread, type ClientInfo } from "@beyland/tincan-protocol";
import { redactForAgents } from "../agent-privacy.ts";
import type { Core } from "../core.ts";
import { syncDraftWithMessage } from "../drafts.ts";
import type { CommandRegistry } from "../registry.ts";
import type { Store } from "../store/store.ts";
import {
  assertAgentCanAccessThread,
  presentThread,
  requireThread,
  resolveThreadTarget,
} from "./common.ts";

export function threadHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(thread.list, (input, { core, client }) => {
      const store = core.requireStore();
      const agent = client.kind === "mcp";
      // For agents the scope is part of the query, so its LIMIT counts only what they may see.
      const threads = store.listThreads({
        limit: input.limit,
        before: input.before,
        excludeAgentHidden: agent,
        agentScope: agent ? core.agentScope(client) : undefined,
      });
      return threads.map((t) => presentThread(core, client, t));
    })
    .implement(thread.get, (input, { core, client }) => {
      const store = core.requireStore();
      const found = requireThread(core, resolveThreadTarget(core, input.key, client));
      assertAgentCanAccessThread(core, client, found);
      const rawGroup = store.getGroup(found.key);
      const group =
        rawGroup && core.maskHandles(client)
          ? core.handleMasker.maskGroup(rawGroup, core.settings.defaultRegion)
          : rawGroup;
      const rawDraft = store.getDraft(found.key);
      const draft =
        rawDraft !== null && core.hideCodes(client) ? redactForAgents(rawDraft) : rawDraft;
      // Agent drafts are for the user: agents see their own through draft.list.
      if (client.kind === "mcp")
        return { thread: presentThread(core, client, found), group, draft };
      return {
        thread: presentThread(core, client, found),
        group,
        draft,
        drafts: store.listAgentDrafts({ states: ["queued"], to: found.key, limit: 500 }),
      };
    })
    .implement(thread.markRead, async (input, { core, client }) => {
      const found = requireThread(core, resolveThreadTarget(core, input.key, client));
      assertAgentCanAccessThread(core, client, found);
      const key = found.key;
      const changes = core.requireStore().markThreadRead(key);
      if (changes.length === 0) return { marked: 0, onPhone: 0 };
      core.events.emit("message.changed", { threadKey: key, ids: changes.map((c) => c.id) });
      core.events.emit("thread.changed", { keys: [key] });
      const engine = core.services.sync;
      const onPhone = engine ? await engine.markReadOnPhone(changes) : 0;
      return { marked: changes.length, onPhone };
    })
    .implement(thread.mute, (input, { core, client }) =>
      setFlag(core, client, input.key, "muted", input.muted, (store, key) =>
        store.setThreadMuted(key, input.muted),
      ),
    )
    .implement(thread.pin, (input, { core, client }) =>
      setFlag(core, client, input.key, "pinned", input.pinned, (store, key) =>
        store.setThreadPinned(key, input.pinned),
      ),
    )
    .implement(thread.remove, (input, { core }) => {
      const key = requireThread(core, resolveThreadTarget(core, input.key)).key;
      const store = core.requireStore();
      const scheduled = store.scheduledInThread(key);
      const deleted = store.deleteThread(key);
      if (deleted) {
        // Its scheduled messages never go: their timers stop, and agent drafts sent as them are
        // cancelled.
        core.services.outbox?.dropThread(key);
        for (const id of scheduled) syncDraftWithMessage(store, core.events, id);
        core.events.emit("thread.changed", { keys: [key] });
        core.events.emit("message.changed", { threadKey: key, ids: [] });
      }
      return { key, deleted };
    });
}

function setFlag(
  core: Core,
  client: ClientInfo,
  raw: string,
  flag: "muted" | "pinned",
  value: boolean,
  set: (store: Store, key: string) => void,
): { key: string; changed: boolean } {
  const found = requireThread(core, resolveThreadTarget(core, raw, client));
  assertAgentCanAccessThread(core, client, found);
  const key = found.key;
  const changed = found[flag] !== value;
  if (changed) {
    set(core.requireStore(), key);
    core.events.emit("thread.changed", { keys: [key] });
  }
  return { key: core.maskHandles(client) ? core.handleMasker.mask(key) : key, changed };
}

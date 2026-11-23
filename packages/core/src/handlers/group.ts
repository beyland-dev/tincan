import { group, TincanError } from "@beyland/tincan-protocol";
import { handleFor } from "../keys.ts";
import type { CommandRegistry } from "../registry.ts";
import { presentMessage, resolveGroupTarget } from "./common.ts";

export function groupHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(group.list, (_input, { core, client }) => {
      const store = core.requireStore();
      const groups = store.listGroups();
      // A group whose conversation is gone still goes through the check, by its key.
      const visible =
        client.kind === "mcp"
          ? groups.filter(
              (g) =>
                core.agentThreadAccess(client, store.getThread(g.threadKey) ?? g.threadKey) ===
                null,
            )
          : groups;
      return core.maskHandles(client)
        ? visible.map((g) => core.handleMasker.maskGroup(g, core.settings.defaultRegion))
        : visible;
    })
    .implement(group.save, (input, { core, client }) => {
      const store = core.requireStore();
      const key = resolveGroupTarget(core, input.threadKey, client);
      const roster =
        input.roster === undefined || input.roster === null
          ? input.roster
          : input.roster.map((raw) => {
              const trimmed = raw.trim();
              if (trimmed.startsWith("handle:")) {
                const unmasked = core.handleMasker.unmask(trimmed, store);
                if (!unmasked) {
                  throw new TincanError("NOT_FOUND", "Unknown handle ID in group roster");
                }
                return unmasked;
              }
              const handle = handleFor(trimmed, core.settings.defaultRegion);
              if (!handle || handle.startsWith("sender:")) {
                throw new TincanError(
                  "INVALID_INPUT",
                  "Group members must be phone numbers or email addresses",
                );
              }
              return handle;
            });
      const saved = store.db.transaction(() => {
        if (input.title !== undefined) {
          store.ensureThread(key, "group");
          store.setThreadTitle(key, input.title);
        }
        if (roster !== undefined) return store.setGroupRoster(key, roster);
        if (!store.getGroup(key)) {
          store.recordGroup(key, {
            named: key.startsWith("group:name:"),
            name: null,
            participants: [],
          });
        }
        return store.getGroup(key)!;
      });
      core.events.emit("thread.changed", { keys: [key] });
      return core.maskHandles(client) ? core.handleMasker.maskGroup(saved) : saved;
    })
    .implement(group.remove, (input, { core, client }) => {
      const key = resolveGroupTarget(core, input.threadKey, client);
      const deleted = core.requireStore().deleteGroup(key);
      if (deleted) core.events.emit("thread.changed", { keys: [key] });
      return { deleted };
    })
    .implement(group.assignMessage, (input, { core, client }) => {
      const store = core.requireStore();
      const message = store.getMessage(input.id);
      if (!message) throw new TincanError("NOT_FOUND", "No such message");
      const from = message.threadKey;
      const to = resolveGroupTarget(core, input.threadKey, client);
      if (from === to) return presentMessage(core, client, message);
      store.db.transaction(() => {
        store.moveMessage(message.id, to, "group");
        if (message.sender && store.getGroup(to)) store.noteGroupSender(to, message.sender);
      });
      core.events.emit("message.changed", { threadKey: to, ids: [message.id] });
      core.events.emit("message.changed", { threadKey: from, ids: [message.id] });
      core.events.emit("thread.changed", { keys: [to, from] });
      return presentMessage(core, client, store.getMessage(message.id)!);
    });
}

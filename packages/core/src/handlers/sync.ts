import { sync } from "@beyland/tincan-protocol";
import type { CommandRegistry } from "../registry.ts";

export function syncHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(sync.status, (_input, { core }): sync.SyncStatus => {
      const { sync: engine, contacts, ancs } = core.services;
      const messages = engine?.status;
      const notifications = ancs?.state;
      return {
        messages: {
          state: messages?.link.kind ?? "off",
          syncing: messages?.syncing ?? false,
          lastSyncAt: messages?.lastSyncAt ?? null,
        },
        contacts: { state: contacts ? "on" : "off", lastSyncAt: contacts?.lastSyncAt ?? null },
        notifications: !notifications
          ? { state: "off" }
          : notifications.kind === "unavailable"
            ? { state: "unavailable", detail: notifications.reason }
            : notifications.kind === "waiting"
              ? { state: "waiting", detail: notifications.hint }
              : { state: notifications.kind },
      };
    })
    .implement(sync.now, async (input, { core }) => {
      const engine = core.requireService("sync");
      const contacts = input.contacts ? core.requireService("contacts") : null;
      const pass = await engine.sync();
      const result = contacts ? await contacts.sync({ force: true }) : null;
      return {
        synced: pass !== null,
        added: pass?.added.length ?? 0,
        contacts: result && {
          skipped: result.skipped,
          contacts: result.contacts,
          changed: result.changed,
          removed: result.removed,
        },
      };
    });
}

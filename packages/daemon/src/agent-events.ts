import { agentDisplayName, type Core } from "@beyland/tincan-core";
import type { ClientInfo, TincanEvent } from "@beyland/tincan-protocol";

/** Events an `mcp` client gets even with agents turned off: what `status`/`settings.get` show. */
const ALWAYS_ALLOWED = new Set<string>(["daemon.stopping", "settings.changed"]);

/** Events that name conversations or contacts, which agents only see when they may read. */
const READ_EVENTS = new Set<string>(["thread.changed", "message.changed", "contact.changed"]);

/** Events agents never get: pairing is the user's alone, and its state names nearby devices. */
const NEVER = new Set<string>(["pairing.changed"]);

/** What agents see for the phone's Bluetooth address, as in `status`. */
const REDACTED_ADDRESS = "00:00:00:00:00:00";

/**
 * The event as `client` may see it, or null to drop it. Desktop and CLI clients get every event
 * unchanged. For agents (`mcp`) this applies the same policy as their commands: nothing beyond
 * settings while agents are off (and of the settings only the agent policy), nothing about
 * conversations or contacts while they may not read, nothing about contacts hidden from them,
 * nothing about conversations they may not touch (hidden from agents, short codes with
 * `agents.hideCodes`, or outside `agents.read`'s scope), thread keys and message ids masked while
 * `agents.handles` is hidden, no pairing events, and the phone's address redacted as `status`
 * does. Each setting applies as `agents.access` caps it (`Core.agents`). Like the agent policy
 * itself this is a usability control, not a security boundary.
 */
export function eventForClient(
  core: Core,
  client: ClientInfo,
  event: TincanEvent,
): TincanEvent | null {
  if (client.kind !== "mcp") return event;
  // The policy as enforced: `agents.access` caps the rest.
  const agents = core.agents;
  // Agents see only the agent policy, as `settings.get` gives it to them.
  if (event.event === "settings.changed") {
    return { ...event, data: { agents: event.data.agents } };
  }
  if (ALWAYS_ALLOWED.has(event.event)) return event;
  if (agents.access === "off" || NEVER.has(event.event)) return null;
  if (READ_EVENTS.has(event.event) && agents.read === "off") return null;

  const mask = core.maskHandles(client);
  const visible = (key: string) =>
    core.agentThreadAccess(client, core.store?.getThread(key) ?? key) === null;
  const maskKey = (key: string) => (mask ? core.handleMasker.mask(key) : key);
  const maskId = (id: string) => (mask ? core.handleMasker.maskMessageId(id) : id);

  switch (event.event) {
    case "thread.changed": {
      const keys = event.data.keys.filter(visible);
      // An empty list means "something changed"; a list emptied by filtering means nothing for us.
      if (keys.length === 0 && event.data.keys.length > 0) return null;
      return { ...event, data: { keys: keys.map(maskKey) } };
    }
    case "message.changed": {
      if (!visible(event.data.threadKey)) return null;
      return {
        ...event,
        data: { threadKey: maskKey(event.data.threadKey), ids: event.data.ids.map(maskId) },
      };
    }
    case "message.sendStatus": {
      const message = core.store?.getMessage(event.data.id);
      if (message && !visible(message.threadKey)) return null;
      return { ...event, data: { ...event.data, id: maskId(event.data.id) } };
    }
    case "draft.changed": {
      // Only the agent's own drafts, and only what became of them: not even which conversation.
      const draft = core.store?.getAgentDraft(event.data.id);
      if (!draft || draft.agentName !== agentDisplayName(client.name)) return null;
      return { ...event, data: { id: event.data.id, state: event.data.state } };
    }
    case "contact.changed": {
      const ids = event.data.ids.filter((id) => !core.store?.isContactHiddenFromAgents(id));
      if (ids.length === 0 && event.data.ids.length > 0) return null;
      return { ...event, data: { ids } };
    }
    case "device.changed":
      return { ...event, data: { address: REDACTED_ADDRESS } };
    default:
      return event;
  }
}

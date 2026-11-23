import { TincanError, type ClientInfo, type Message, type Thread } from "@beyland/tincan-protocol";
import { redactCodeMessage } from "../agent-privacy.ts";
import type { AgentThreadTarget, Core } from "../core.ts";
import { normalizeThreadKey } from "../keys.ts";
import { agentDisplayName, resolveRecipient } from "./message.ts";

/** A thread key as the user typed it (`tel:2065550123`) or an opaque token, in canonical form. */
export function canonicalKey(core: Core, key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("handle:")) {
    const resolved = core.handleMasker.unmask(trimmed, core.store);
    if (!resolved) throw new TincanError("NOT_FOUND", "No such conversation");
    return resolved;
  }
  if (trimmed.startsWith("group:members:")) {
    const unmasked = core.handleMasker.unmask(trimmed, core.store);
    if (unmasked) return unmasked;
  }
  return normalizeThreadKey(trimmed, core.settings.defaultRegion) ?? trimmed;
}

/**
 * Resolves a thread key, opaque handle ID, phone number, email address or contact name to a
 * canonical thread key. When `agents.handles === "hidden"`, MCP read operations refuse raw phone
 * numbers and email addresses to prevent membership/existence probing.
 */
export function resolveThreadTarget(core: Core, raw: string, client?: ClientInfo): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("handle:")) return canonicalKey(core, trimmed);
  if (trimmed.startsWith("group:members:")) {
    const unmasked = core.handleMasker.unmask(trimmed, core.store);
    if (unmasked) return unmasked;
    if (client && core.maskHandles(client)) {
      throw new TincanError("NOT_FOUND", "No such conversation");
    }
    return trimmed;
  }
  const masked = Boolean(client && core.maskHandles(client));
  const direct = normalizeThreadKey(trimmed, core.settings.defaultRegion);
  if (direct) {
    if (masked && (direct.startsWith("tel:") || direct.startsWith("email:"))) {
      throw new TincanError(
        "PERMISSION_DENIED",
        "Use opaque handle IDs or contact names while agents.handles is hidden.",
      );
    }
    return direct;
  }
  if (masked && (trimmed.includes("@") || !/\p{L}/u.test(trimmed))) {
    throw new TincanError(
      "PERMISSION_DENIED",
      "Use opaque handle IDs or contact names while agents.handles is hidden.",
    );
  }
  return groupByTitle(core, trimmed, client) ?? resolveRecipient(core, trimmed, client);
}

/**
 * The group conversation called `name` (its title as `thread.list` shows it to the caller, ignoring
 * case), or null when none is. Agents only match conversations they may read, by the title they see.
 */
export function groupByTitle(core: Core, name: string, client?: ClientInfo): string | null {
  const store = core.store;
  if (!store || !/\p{L}/u.test(name)) return null;
  const wanted = name.trim().toLocaleLowerCase();
  const matches = store
    .groupThreadKeys()
    .map((key) => store.getThread(key))
    .filter((thread): thread is Thread => thread !== null)
    .filter((thread) => client?.kind !== "mcp" || core.agentThreadAccess(client, thread) === null)
    .filter((thread) => {
      const shown = client ? presentThread(core, client, thread) : thread;
      return shown.title.toLocaleLowerCase() === wanted;
    });
  if (matches.length > 1) {
    throw new TincanError(
      "INVALID_INPUT",
      `${matches.length} group conversations have that name; use a thread key (\`tincan threads --verbose\` shows them)`,
    );
  }
  return matches[0]?.key ?? null;
}

/**
 * A group conversation by its thread key or its name. Anything else (a phone number, a contact) is
 * `INVALID_INPUT`; a name no group has is `NOT_FOUND`.
 */
export function resolveGroupTarget(core: Core, raw: string, client?: ClientInfo): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("group:")) {
    const key = normalizeThreadKey(trimmed);
    if (!key) throw new TincanError("INVALID_INPUT", "Expected a group thread key or name");
    return key;
  }
  const looksLikeKey =
    normalizeThreadKey(trimmed, core.settings.defaultRegion) !== null ||
    trimmed.startsWith("handle:") ||
    trimmed.includes("@") ||
    !/\p{L}/u.test(trimmed);
  if (looksLikeKey) throw new TincanError("INVALID_INPUT", "Expected a group thread key or name");
  const key = groupByTitle(core, trimmed, client);
  if (!key) throw new TincanError("NOT_FOUND", "No group conversation has that name");
  return key;
}

/** The thread, or `NOT_FOUND`. Hidden threads count for non-agent clients. */
export function requireThread(core: Core, key: string): Thread {
  const found = core.requireStore().getThread(key);
  if (!found) throw new TincanError("NOT_FOUND", "No such conversation");
  return found;
}

/**
 * Refuses an agent a conversation it may not touch (hidden from agents, a short code while
 * `agents.hideCodes`, or outside `agents.read`'s scope) with `NOT_FOUND`, exactly as if it didn't
 * exist. See `Core.agentThreadAccess`.
 */
export function assertAgentCanAccessThread(
  core: Core,
  client: ClientInfo,
  thread: string | AgentThreadTarget,
): void {
  if (core.agentThreadAccess(client, thread) !== null) {
    throw new TincanError("NOT_FOUND", "No such conversation");
  }
}

/** Applies self-conversation tagging, code redaction and opaque handle masking to a thread. */
export function presentThread(core: Core, client: ClientInfo, thread: Thread): Thread {
  let out: Thread = core.ownHandles().has(thread.key) ? { ...thread, isSelf: true } : thread;
  if (client.kind === "mcp") {
    // Whether (and why) it's hidden from agents, and the user's own draft, are the user's alone.
    const {
      hiddenFromAgents: _hidden,
      hiddenBy: _by,
      hiddenPerson: _person,
      draft: _draft,
      ...rest
    } = out;
    out = rest;
  }
  if (core.hideCodes(client) && out.lastMessage) {
    out = { ...out, lastMessage: redactCodeMessage(out.lastMessage) };
  }
  if (client.kind === "mcp" && out.lastMessage) {
    out = { ...out, lastMessage: forAgent(out.lastMessage, client) };
  }
  return core.maskHandles(client)
    ? core.handleMasker.maskThread(out, core.settings.defaultRegion)
    : out;
}

/**
 * A message's agent details as an agent sees them: whether an agent message was edited and how it
 * went, never the agent's name; why a send failed only on the agent's own messages.
 */
function forAgent(message: Message, client: ClientInfo): Message {
  const { failure, agent, ...rest } = message;
  const out: Message = rest;
  if (agent) out.agent = { edited: agent.edited, via: agent.via };
  if (failure && agent && agent.name === agentDisplayName(client.name)) out.failure = failure;
  return out;
}

/**
 * Applies code redaction and opaque handle masking to a message. Agents see whether an agent
 * message was edited and how it went, never the agent's name, and why a send failed only on
 * their own messages.
 */
export function presentMessage(core: Core, client: ClientInfo, message: Message): Message {
  let out = core.hideCodes(client) ? redactCodeMessage(message) : message;
  if (client.kind === "mcp") out = forAgent(out, client);
  return core.maskHandles(client) ? core.handleMasker.maskMessage(out) : out;
}

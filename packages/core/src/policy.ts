import {
  effectiveAgents,
  TincanError,
  type AnyContract,
  type ClientInfo,
  type Settings,
} from "@beyland/tincan-protocol";

/** What agents may still use with agents turned off: enough to explain why and how to turn them on. */
const ALWAYS_ALLOWED = new Set(["status", "version", "commands", "settings.get"]);

/**
 * Checks a caller against a command's policy flags and the user's agent settings.
 *
 * This guards against agent mistakes. It is not a security boundary: anything
 * running as the user can reach the socket and claim to be any client.
 *
 * The settings apply as `agents.access` caps them (`effectiveAgents`): a stored value the level
 * doesn't expose has no effect. Returns `"approve"` when an agent's send must become an agent
 * draft for the user (`agents.send: approve`). Which conversations an agent may touch
 * (`agents.read`'s scope) is checked per conversation by the handlers.
 */
export function authorize(
  contract: AnyContract,
  client: ClientInfo,
  settings: Settings,
): "approve" | undefined {
  if (client.kind !== "mcp") return undefined;
  const agents = effectiveAgents(settings.agents);

  if (contract.internal) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `${contract.name} can only be used from the Tincan app or the tincan CLI.`,
    );
  }

  if (agents.access === "off" && !ALWAYS_ALLOWED.has(contract.name)) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `AI agents are turned off in Tincan. The user can turn them on in Tincan settings (agents.access).`,
    );
  }

  const scope = contract.agentScope;
  if (scope === "ownDrafts") {
    if (agents.read === "off" && agents.send === "never") {
      throw new TincanError(
        "PERMISSION_DENIED",
        `Agents may not read messages or send them, so they have no drafts. The user can change this in Tincan settings (agents.access).`,
      );
    }
  } else if (scope !== undefined && agents.read === "off") {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Agents may not read messages or contacts. The user can allow it in Tincan settings (agents.read).`,
    );
  }
  // Below `assistant`, drafts, inbox actions and sending aren't available at all, whatever is
  // stored for them: the access level is the setting to name.
  const limited = agents.access === "readOnly";
  // An agent draft asks the user to send one message, so it needs sending (and reading, above).
  if (scope === "drafts" && agents.send === "never") {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Agents may not save drafts with read-only access. The user can change this in Tincan settings (agents.access).`,
    );
  }
  if (scope === "manage" && !agents.manage) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Agents may not mark conversations read, mute or pin them. The user can allow it in Tincan settings (${limited ? "agents.access" : "agents.manage"}).`,
    );
  }

  if (contract.approval === "agent") {
    // Only read-only access stops sends here: `assistant` and `full` never leave `send` at `never`.
    if (agents.send === "never") {
      throw new TincanError(
        "PERMISSION_DENIED",
        `Agents may not use ${contract.name}. The user can change this in Tincan settings (agents.access).`,
      );
    }
    if (agents.send === "approve") return "approve";
  }
  return undefined;
}

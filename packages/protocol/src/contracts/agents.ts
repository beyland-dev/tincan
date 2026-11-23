import { z } from "zod";
import { defineContract } from "../contract.ts";
import { HiddenGroup, HiddenPerson } from "../entities.ts";

/** The AI agents Tincan can add its MCP server to. */
export const AgentClient = z.enum([
  "copilot",
  "claude",
  "codex",
  "antigravity",
  "muse",
  "cursor",
  "opencode",
  "pi",
]);
export type AgentClient = z.infer<typeof AgentClient>;

export const AgentConnection = z.object({
  client: AgentClient,
  /** The app's name, e.g. "Claude". */
  name: z.string(),
  /** Where the app keeps its MCP servers. */
  file: z.string(),
  /** Tincan is in the app's config. */
  configured: z.boolean(),
  /** …and starts this Tincan (false: another install, or an older path). */
  current: z.boolean(),
  /** The config to add by hand: a command for apps whose CLI owns it, else JSON to merge. */
  snippet: z.string(),
  /** The terminal command that sets the app up (`tincan connect <agent>`). */
  terminal: z.string(),
});
export type AgentConnection = z.infer<typeof AgentConnection>;

export const connections = defineContract({
  name: "agents.connections",
  title: "Agents",
  description:
    "The AI agents Tincan can add its MCP server to, whether each is set up, and how any other MCP client starts Tincan's server (`launch`).",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: z.object({
    clients: z.array(AgentConnection),
    launch: z.object({ command: z.string(), args: z.array(z.string()) }),
  }),
});

export const connect = defineContract({
  name: "agents.connect",
  title: "Connect an agent",
  description:
    "Add Tincan's MCP server to an agent's user-level config, keeping every other server, setting and comment. `CONFLICT` when the agent has a different Tincan entry, unless `force` replaces it.",
  kind: "mutation",
  internal: true,
  positional: ["client"],
  input: z.object({ client: AgentClient, force: z.boolean().optional() }),
  output: AgentConnection,
});

export const disconnect = defineContract({
  name: "agents.disconnect",
  title: "Disconnect an agent",
  description: "Remove Tincan's MCP server from an agent's user-level config.",
  kind: "mutation",
  internal: true,
  positional: ["client"],
  input: z.object({ client: AgentClient }),
  output: AgentConnection,
});

const HIDE_TARGET =
  "A contact name, phone number, email address, conversation key or group name (as `thread.list` shows it)";

export const HideFromAgentsResult = z.object({
  /** False when it was already hidden (a contact or handle may still have gained numbers). */
  changed: z.boolean(),
  /** The hidden person, when a contact or a number or address was hidden. */
  person: HiddenPerson.nullable(),
  /** The hidden group, when a group conversation was hidden. */
  group: HiddenGroup.nullable(),
  /**
   * Agents' direct sends to them that hadn't reached the phone yet (held for the agent send delay
   * or waiting for the phone): taken back and queued as agent drafts for the user.
   */
  requeued: z.number().int().nonnegative(),
});
export type HideFromAgentsResult = z.infer<typeof HideFromAgentsResult>;

export const hidden = defineContract({
  name: "agents.hidden",
  title: "Hidden from agents",
  description:
    "The people and group conversations hidden from AI agents. A person is a contact (with all their numbers and emails, and every group they're in) or a raw number or email address.",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: z.object({ people: z.array(HiddenPerson), groups: z.array(HiddenGroup) }),
});

export const hide = defineContract({
  name: "agents.hide",
  title: "Hide from agents",
  description:
    "Hide a person or a group conversation from AI agents until you show them again. A contact is hidden with every number and email it has, and keeps up as the iPhone's card changes; a number or address works with no conversation yet (if it's a saved contact's, the contact is hidden). Groups with a hidden person in them are hidden too. Agents' messages to them always become agent drafts, even with full access.",
  kind: "mutation",
  internal: true,
  positional: ["target"],
  input: z
    .object({
      target: z.string().min(1).max(2000).optional().describe(HIDE_TARGET),
      contactId: z.string().min(1).max(200).optional().describe("A saved contact's id"),
      handle: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("A phone number or email address (or its tel:/email: key)"),
      groupKey: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("A group conversation's thread key or name"),
    })
    .refine(
      (input) =>
        [input.target, input.contactId, input.handle, input.groupKey].filter((v) => v !== undefined)
          .length === 1,
      { message: "Give exactly one of target, contactId, handle or groupKey" },
    ),
  output: HideFromAgentsResult,
});

export const show = defineContract({
  name: "agents.show",
  title: "Show to agents",
  description:
    "Show a hidden person (with all their numbers and emails) or group conversation to AI agents again. A group hidden because a person in it is hidden stays hidden until that person is shown (`CONFLICT`).",
  kind: "mutation",
  internal: true,
  positional: ["target"],
  input: z
    .object({
      target: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(`A hidden person's id or label, or ${HIDE_TARGET.toLowerCase()}`),
      personId: z.string().min(1).max(200).optional().describe("A hidden person's id"),
      groupKey: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("A group conversation's thread key or name"),
    })
    .refine(
      (input) =>
        [input.target, input.personId, input.groupKey].filter((v) => v !== undefined).length === 1,
      { message: "Give exactly one of target, personId or groupKey" },
    ),
  output: z.object({ changed: z.boolean() }),
});

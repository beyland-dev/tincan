import { z } from "zod";

export type CommandKind = "query" | "mutation";

/**
 * `none`: anyone allowed by the agent policy may call it.
 * `agent`: an agent's call is governed by `agents.send`: it becomes an agent draft for the user to
 * review, or with `replied` or `always` may go directly (see the send policy).
 */
export type ApprovalMode = "none" | "agent";

/**
 * Which agent setting, besides `agents.access` not being `off`, lets an MCP client call a command
 * (each as `effectiveAgents` enforces it):
 * - `read`: `agents.read` isn't `off` (and the conversation must be in its scope).
 * - `drafts`: `read`, plus sending (`agents.send` isn't `never`): saving an agent draft is asking
 *   the user to send one message.
 * - `manage`: `read`, plus `agents.manage` (mark read, mute, pin).
 * - `ownDrafts`: the agent's own drafts and sends: `agents.read` isn't `off` or `agents.send`
 *   isn't `never`.
 */
export type AgentScope = "read" | "drafts" | "manage" | "ownDrafts";

export interface Contract<
  N extends string = string,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  /** Dotted name, e.g. `thread.list`. */
  name: N;
  title: string;
  description: string;
  /** Queries never change state on the phone or in the store. */
  kind: CommandKind;
  input: I;
  output: O;
  /** Input keys that the CLI accepts as positional arguments, in order. */
  positional?: string[];
  /** Only the desktop app or an interactive CLI may call it; never offered to agents. */
  internal?: boolean;
  /**
   * Returns message text, contacts or other personal data, which agents get framed as untrusted.
   * What gates it for agents is `agentScope` (or `approval`).
   */
  sensitive?: boolean;
  /** The agent setting that lets MCP clients call it; see `AgentScope`. */
  agentScope?: AgentScope;
  approval?: ApprovalMode;
  /** Deletes or forgets something the user can't easily get back. */
  destructive?: boolean;
}

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyContract = Contract<string, any, any>;

export function defineContract<const N extends string, I extends z.ZodType, O extends z.ZodType>(
  contract: Contract<N, I, O>,
): Contract<N, I, O> {
  return contract;
}

export interface ContractDescriptor {
  name: string;
  title: string;
  description: string;
  kind: CommandKind;
  positional: string[];
  internal: boolean;
  sensitive: boolean;
  /** Left out when no agent setting beyond `agents.access` gates it. */
  agentScope?: AgentScope;
  approval: ApprovalMode;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export function describeContract(contract: AnyContract): ContractDescriptor {
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    kind: contract.kind,
    positional: contract.positional ?? [],
    internal: contract.internal ?? false,
    sensitive: contract.sensitive ?? false,
    ...(contract.agentScope ? { agentScope: contract.agentScope } : {}),
    approval: contract.approval ?? "none",
    destructive: contract.destructive ?? false,
    inputSchema: z.toJSONSchema(contract.input, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(contract.output, {
      io: "output",
      unrepresentable: "any",
    }) as Record<string, unknown>,
  };
}

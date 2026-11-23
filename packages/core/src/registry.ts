import { z } from "zod";
import {
  describeContract,
  TincanError,
  type AgentDraftNote,
  type AnyContract,
  type ClientInfo,
  type Contract,
  type ContractDescriptor,
} from "@beyland/tincan-protocol";
import { agentActionFor, type RateLimitSlot } from "./agent-privacy.ts";
import { authorize } from "./policy.ts";
import type { Core } from "./core.ts";
import { resolveRecipient } from "./handlers/message.ts";
import { normalizeThreadKey } from "./keys.ts";

/** How the send policy decided an agent's `message.send`. */
export interface AgentSendDecision {
  /** Queue it as an agent draft for the user rather than sending it. */
  queue: boolean;
  /** Why it needs the user although the policy might have let it go; for the user alone. */
  note?: AgentDraftNote;
  /**
   * The recipient exactly as the agent typed it, when that was a raw number or address while
   * handles are hidden: what the agent is shown back, never the handle or contact it matched.
   */
  requestedAs?: string;
}

export interface HandlerContext {
  core: Core;
  client: ClientInfo;
  /** For an agent's `message.send`: what the send policy decided. */
  agentSend?: AgentSendDecision;
  /**
   * The agent's rate-limit reservation for this call, committed when the handler returns. A
   * handler that turns out to do nothing new (a repeat of a queued draft) releases it.
   */
  slot?: RateLimitSlot | null;
}

export type Handler<C extends AnyContract> = (
  input: z.output<C["input"]>,
  context: HandlerContext,
) => Promise<z.input<C["output"]>> | z.input<C["output"]>;

interface Implementation {
  contract: AnyContract;
  // oxlint-disable-next-line typescript/no-explicit-any
  handler: Handler<any>;
}

/**
 * Whether an agent's send to `key` becomes an agent draft for the user under `agents.send` (as
 * `agents.access` caps it), and what to tell the user about the recipient. `never` was refused
 * before this and `approve` always queues.
 * - `replied`: goes directly only to a conversation the agent may read that the user has sent a
 *   message in themselves (agent messages, even ones the user sent from a draft, don't count).
 * - `always`: goes directly, even outside what the agent may read or to someone new. With
 *   `assistant` access a short code while those are hidden still queues, and so does a raw number
 *   or address while handles are hidden (`requestedAs`), so sending at once can't reveal that a
 *   conversation with it exists. With `full` access (`guardHidden: false`) those don't queue.
 * Someone the user hid from agents (a person, or a group with them in it) always queues, with
 * `note: "hidden"`, at every access level: an explicit hide beats them all.
 * Under `replied` a raw number queues too, and hidden and short-code recipients take the same path
 * as a brand-new one, so an agent can't tell them apart.
 */
function sendDecision(
  core: Core,
  client: ClientInfo,
  key: string,
  requestedAs: boolean,
): { ask: boolean; note?: AgentDraftNote } {
  const store = core.requireStore();
  const policy = core.agents;
  const access = core.agentThreadAccess(client, store.getThread(key) ?? key);
  if (access === "hidden") return { ask: true, note: "hidden" };
  switch (policy.send) {
    case "always":
      if (!policy.guardHidden) return { ask: false };
      return {
        ask: requestedAs || access === "shortCode",
        note: access ?? undefined,
      };
    case "replied":
      return {
        ask: requestedAs || access !== null || !store.hasUserSentMessage(key),
        note: access ?? undefined,
      };
    default:
      return { ask: true, note: access ?? undefined };
  }
}

/** A phone number, email address or raw `tel:`/`email:` key rather than an opaque ID or a name. */
export function isRawAddress(core: Core, to: string): boolean {
  const text = to.trim();
  if (text.startsWith("handle:")) return false;
  const key = normalizeThreadKey(text, core.settings.defaultRegion);
  if (key) return key.startsWith("tel:") || key.startsWith("email:");
  return text.includes("@") || !/\p{L}/u.test(text);
}

/** Binds handlers to protocol contracts and runs them with validation and policy checks. */
export class CommandRegistry {
  #commands = new Map<string, Implementation>();

  implement<N extends string, I extends z.ZodType, O extends z.ZodType>(
    contract: Contract<N, I, O>,
    handler: Handler<Contract<N, I, O>>,
  ): this {
    if (this.#commands.has(contract.name)) {
      throw new Error(`Duplicate command: ${contract.name}`);
    }
    this.#commands.set(contract.name, { contract, handler });
    return this;
  }

  has(name: string): boolean {
    return this.#commands.has(name);
  }

  contracts(): AnyContract[] {
    return [...this.#commands.values()].map((c) => c.contract);
  }

  describe(options: { includeInternal?: boolean } = {}): ContractDescriptor[] {
    return this.contracts()
      .filter((c) => options.includeInternal || !c.internal)
      .map((c) => describeContract(c));
  }

  async run(name: string, rawInput: unknown, context: HandlerContext): Promise<unknown> {
    const command = this.#commands.get(name);
    if (!command) throw new TincanError("NOT_FOUND", `Unknown command ${JSON.stringify(name)}`);
    const { contract, handler } = command;

    const policy = authorize(contract, context.client, context.core.settings);

    const parsed = contract.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new TincanError(
        "INVALID_INPUT",
        `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`,
        parsed.error.issues,
      );
    }

    const { core, client } = context;
    const isAgent = client.kind === "mcp";

    // Decide what an agent's send does before reserving a slot.
    let agentSend: AgentSendDecision | undefined;
    if (isAgent && contract.approval === "agent" && name === "message.send" && core.store) {
      const to = (parsed.data as { to: string }).to;
      const target = resolveRecipient(core, to, client);
      const requestedAs =
        core.maskHandles(client) && isRawAddress(core, to) ? to.trim() : undefined;
      const decision = sendDecision(core, client, target, requestedAs !== undefined);
      agentSend = {
        queue: policy === "approve" || decision.ask,
        ...(decision.note ? { note: decision.note } : {}),
        ...(requestedAs !== undefined ? { requestedAs } : {}),
      };
    }

    // Reserve rate-limit slots synchronously so concurrent calls cannot bypass the caps. A send
    // counts when it's queued too, and discarding or cancelling it doesn't give the slot back.
    const slot = isAgent
      ? core.agentRateLimiter.reserveAll(agentActionFor(name, parsed.data), core.now())
      : null;
    try {
      const output = await handler(parsed.data, { ...context, agentSend, slot });
      slot?.commit(core.now());
      const checked = contract.output.safeParse(output);
      if (!checked.success) {
        throw new TincanError(
          "INTERNAL",
          `${name} returned output that doesn't match its contract: ${z.prettifyError(checked.error)}`,
        );
      }
      return checked.data;
    } catch (error) {
      slot?.release();
      throw error;
    }
  }
}

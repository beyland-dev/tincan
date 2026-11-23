import { z } from "zod";
import { defineContract } from "../contract.ts";
import { AgentDraft, AgentDraftState, Message, Timestamp } from "../entities.ts";
import { SendOutcome } from "./message.ts";

const DraftId = z.string().min(1).max(100);

const ThreadRef = z
  .string()
  .min(1)
  .max(200)
  .describe("A thread key, opaque handle ID, phone number, email address or contact name");

/** How long `draft.get` may wait for a change, in seconds. */
export const DRAFT_WAIT_MAX_SECONDS = 60;

export const list = defineContract({
  name: "draft.list",
  title: "List agent drafts",
  description:
    "Messages AI agents wrote: queued in a conversation's composer for the user, held for the send delay (`scheduled`), or (with `states`) resolved. Oldest first. An agent sees only its own.",
  kind: "query",
  sensitive: true,
  agentScope: "ownDrafts",
  input: z.object({
    states: z
      .array(AgentDraftState)
      .min(1)
      .optional()
      .describe("Only drafts in these states (default: queued and scheduled)"),
    threadKey: ThreadRef.optional().describe("Only this conversation or recipient"),
    limit: z.number().int().min(1).max(500).optional().describe("At most this many (default 100)"),
  }),
  output: z.array(AgentDraft),
});

export const get = defineContract({
  name: "draft.get",
  title: "Show an agent draft",
  description:
    "An agent draft and what became of it: `queued` (waiting for the user), `scheduled`, `sent` (possibly `edited` by the user), `failed`, `discarded` or `cancelled`. With `wait`, waits up to that many seconds for its state to change first; don't poll faster than that. An agent sees only its own.",
  kind: "query",
  sensitive: true,
  agentScope: "ownDrafts",
  positional: ["id"],
  input: z.object({
    id: DraftId,
    wait: z
      .number()
      .int()
      .min(0)
      .max(DRAFT_WAIT_MAX_SECONDS)
      .optional()
      .describe("Seconds to wait for the state to change (0-60)"),
  }),
  output: AgentDraft,
});

export const update = defineContract({
  name: "draft.update",
  title: "Edit an agent draft",
  description:
    "Save the user's edit to a queued agent draft. `revision` must be the draft's current one (`CONFLICT` otherwise).",
  kind: "mutation",
  internal: true,
  sensitive: true,
  input: z.object({
    id: DraftId,
    text: z.string().max(10_000),
    revision: z.number().int().nonnegative(),
  }),
  output: AgentDraft,
});

export const send = defineContract({
  name: "draft.send",
  title: "Send an agent draft",
  description:
    "Send a queued agent draft, with the text shown (`text`, saved as an edit when it differs). It counts as the agent's message, edited or not, and waits for the agent send delay. `revision`, when given, must be the draft's current one (`CONFLICT` otherwise).",
  kind: "mutation",
  internal: true,
  sensitive: true,
  positional: ["id"],
  input: z.object({
    id: DraftId,
    text: z.string().min(1).max(10_000).optional(),
    revision: z.number().int().nonnegative().optional(),
  }),
  output: z.object({
    outcome: SendOutcome.exclude(["queued"]),
    draft: AgentDraft,
    message: Message,
    sendAt: Timestamp.optional(),
  }),
});

export const discard = defineContract({
  name: "draft.discard",
  title: "Discard an agent draft",
  description:
    "Throw away a queued agent draft. An agent may discard only its own, while still queued.",
  kind: "mutation",
  sensitive: true,
  agentScope: "ownDrafts",
  positional: ["id"],
  input: z.object({ id: DraftId }),
  output: AgentDraft,
});

export const restore = defineContract({
  name: "draft.restore",
  title: "Restore an agent draft",
  description:
    "Put a discarded agent draft back in its conversation's queue (the desktop's Undo after Discard).",
  kind: "mutation",
  internal: true,
  sensitive: true,
  positional: ["id"],
  input: z.object({ id: DraftId }),
  output: AgentDraft,
});

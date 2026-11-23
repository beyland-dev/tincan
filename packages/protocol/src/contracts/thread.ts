import { z } from "zod";
import { defineContract } from "../contract.ts";
import { AgentDraft, Group, Thread, ThreadKey, Timestamp } from "../entities.ts";

const Limit = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("At most this many (default 50)");

export const list = defineContract({
  name: "thread.list",
  title: "List conversations",
  description: "Conversations, most recent first, with their last message and unread count.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  input: z.object({
    limit: Limit,
    before: Timestamp.optional().describe("Only conversations last active before this time"),
  }),
  output: z.array(Thread),
});

const ThreadRef = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "A thread key, opaque handle ID, phone number, email address, contact name or group name",
  );

export const get = defineContract({
  name: "thread.get",
  title: "Show a conversation",
  description:
    "A conversation with its group details and your saved draft (`draft`). The desktop app and CLI also get its queued agent drafts (`drafts`), oldest first.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  positional: ["key"],
  input: z.object({ key: ThreadRef }),
  output: z.object({
    thread: Thread,
    group: Group.nullable(),
    /** The user's own draft (an agent's are in `drafts`). */
    draft: z.string().nullable(),
    /** Queued agent drafts, oldest first. Only for the desktop app and CLI; agents never get it. */
    drafts: z.array(AgentDraft).optional(),
  }),
});

export const markRead = defineContract({
  name: "thread.markRead",
  title: "Mark read",
  description: "Mark every message in a conversation read, here and on the phone.",
  kind: "mutation",
  sensitive: true,
  agentScope: "manage",
  positional: ["key"],
  input: z.object({ key: ThreadRef }),
  output: z.object({
    marked: z.number().int().nonnegative(),
    /** How many the phone was also told about (it must be connected). */
    onPhone: z.number().int().nonnegative(),
  }),
});

const FlagResult = z.object({ key: ThreadKey, changed: z.boolean() });

export const mute = defineContract({
  name: "thread.mute",
  title: "Mute a conversation",
  description: "Stop desktop notifications for a conversation (--no-muted turns them back on).",
  kind: "mutation",
  sensitive: true,
  agentScope: "manage",
  positional: ["key"],
  input: z.object({ key: ThreadRef, muted: z.boolean().default(true) }),
  output: FlagResult,
});

export const pin = defineContract({
  name: "thread.pin",
  title: "Pin a conversation",
  description: "Pin a conversation to the top of the list (--no-pinned unpins it).",
  kind: "mutation",
  sensitive: true,
  agentScope: "manage",
  positional: ["key"],
  input: z.object({ key: ThreadRef, pinned: z.boolean().default(true) }),
  output: FlagResult,
});

export const remove = defineContract({
  name: "thread.delete",
  title: "Delete a conversation",
  description:
    "Delete a conversation and its messages from Tincan (not from the phone). A new message starts it again.",
  kind: "mutation",
  internal: true,
  destructive: true,
  positional: ["key"],
  input: z.object({ key: ThreadRef }),
  output: z.object({ key: ThreadKey, deleted: z.boolean() }),
});

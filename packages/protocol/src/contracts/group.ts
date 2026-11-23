import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Group, Message } from "../entities.ts";

/** A group conversation: its thread key, or its name as `thread.list` shows it. */
const GroupRef = z
  .string()
  .min(1)
  .max(2000)
  .describe("A group conversation's thread key (`group:…`) or its name");

export const list = defineContract({
  name: "group.list",
  title: "List groups",
  description: "Group conversations Tincan has pieced together from Messages notifications.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  input: z.object({}),
  output: z.array(Group),
});

export const save = defineContract({
  name: "group.save",
  title: "Save a group",
  description:
    "Name a group conversation and/or save who is in it (phone numbers or email addresses).",
  kind: "mutation",
  internal: true,
  positional: ["threadKey"],
  input: z.object({
    threadKey: GroupRef,
    title: z.string().max(200).nullable().optional().describe("Display name; null clears it"),
    roster: z
      .array(z.string().min(1).max(200))
      .max(100)
      .nullable()
      .optional()
      .describe("Members' phone numbers or email addresses; null forgets them"),
  }),
  output: Group,
});

export const remove = defineContract({
  name: "group.delete",
  title: "Forget a group",
  description: "Forget a group's name and saved members. Its messages stay.",
  kind: "mutation",
  internal: true,
  destructive: true,
  positional: ["threadKey"],
  input: z.object({
    threadKey: GroupRef,
  }),
  output: z.object({ deleted: z.boolean() }),
});

export const assignMessage = defineContract({
  name: "group.assignMessage",
  title: "Move a message to a group",
  description: "Move a message Tincan filed in the wrong conversation into a group conversation.",
  kind: "mutation",
  internal: true,
  positional: ["id", "threadKey"],
  input: z.object({
    id: z.string().min(1).max(200),
    threadKey: GroupRef,
  }),
  output: Message,
});

import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Contact } from "../entities.ts";

export const list = defineContract({
  name: "contact.list",
  title: "List contacts",
  description: "Contacts from the phone, favourites first, then by name.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  input: z.object({
    limit: z.number().int().min(1).max(500).optional().describe("At most this many (default 50)"),
    offset: z.number().int().nonnegative().optional(),
    favoritesOnly: z.boolean().optional(),
  }),
  output: z.array(Contact),
});

export const search = defineContract({
  name: "contact.search",
  title: "Search contacts",
  description: "Find contacts by name, phone number or email address.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  positional: ["query"],
  input: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.array(Contact),
});

export const get = defineContract({
  name: "contact.get",
  title: "Show a contact",
  description: "One contact by id.",
  kind: "query",
  sensitive: true,
  agentScope: "read",
  positional: ["id"],
  input: z.object({ id: z.string().min(1).max(200) }),
  output: Contact,
});

export const sync = defineContract({
  name: "contact.sync",
  title: "Sync contacts",
  description: "Re-read the phone's contacts now (only if they changed, unless --force).",
  kind: "mutation",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({
    skipped: z.boolean(),
    contacts: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
  }),
});

export const photo = defineContract({
  name: "contact.photo",
  title: "Show a contact's photo",
  description: "A contact's photo from the phone, base64-encoded; null when it has none.",
  kind: "query",
  sensitive: true,
  internal: true,
  positional: ["id"],
  input: z.object({ id: z.string().min(1).max(200) }),
  output: z
    .object({
      contactId: z.string(),
      mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
      data: z.string().describe("The image, base64"),
    })
    .nullable(),
});

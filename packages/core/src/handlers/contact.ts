import { contact, TincanError, type ClientInfo, type Contact } from "@beyland/tincan-protocol";
import type { Core } from "../core.ts";
import type { CommandRegistry } from "../registry.ts";

export function contactHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(contact.list, (input, { core, client }) =>
      core
        .requireStore()
        .listContacts({
          limit: input.limit,
          offset: input.offset,
          favoritesOnly: input.favoritesOnly,
          // People hidden from agents aren't there for them at all.
          excludeAgentHidden: client.kind === "mcp",
        })
        .map((c) => presentContact(core, client, c)),
    )
    .implement(contact.search, (input, { core, client }) =>
      core
        .requireStore()
        .searchContacts(input.query, {
          limit: input.limit,
          nameOnly: core.maskHandles(client),
          excludeAgentHidden: client.kind === "mcp",
        })
        .map((c) => presentContact(core, client, c)),
    )
    .implement(contact.get, (input, { core, client }) => {
      const found = core
        .requireStore()
        .getContact(input.id, { excludeAgentHidden: client.kind === "mcp" });
      if (!found) throw new TincanError("NOT_FOUND", "No such contact");
      return presentContact(core, client, found);
    })
    .implement(contact.sync, (input, { core }) =>
      core.requireService("contacts").sync({ force: input.force }),
    )
    .implement(contact.photo, (input, { core, client }) => {
      // Internal, so agents never get here; still, a hidden contact has no photo for them.
      if (client.kind === "mcp" && core.store?.isContactHiddenFromAgents(input.id)) return null;
      // Straight from the store, so cached photos show without a phone.
      const photo = core.store?.getContactPhoto(input.id);
      if (!photo) return null;
      const bytes = Buffer.from(photo.data.buffer, photo.data.byteOffset, photo.data.byteLength);
      const mediaType = imageType(bytes);
      if (!mediaType) return null;
      return { contactId: input.id, mediaType, data: bytes.toString("base64") };
    });
}

/** A contact as `client` may see it: masked handles for agents, and never whether it's hidden. */
function presentContact(core: Core, client: ClientInfo, found: Contact): Contact {
  if (client.kind !== "mcp") return found;
  const { hiddenFromAgents: _hidden, ...rest } = found;
  return core.maskHandles(client)
    ? core.handleMasker.maskContact(rest, core.settings.defaultRegion)
    : rest;
}

/** The image type from a photo's first bytes; null for anything else. */
function imageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

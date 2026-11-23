import type { Contact, Thread } from "@beyland/tincan-protocol";
import type { FormatContext, Lookup } from "./format.ts";

/** The most `contact.list` and `thread.list` return at once. */
const PAGE = 500;
/** Beyond this many contacts, the rest are shown by number. */
const MAX_CONTACT_PAGES = 20;

interface Caller {
  call(method: string, params?: unknown): Promise<unknown>;
}

/**
 * Names for one CLI run: contacts by handle and conversations by key, each fetched at most once
 * and in batches (`contact.list`, `thread.list`), never one call per row. They come back as the
 * daemon shows them to this client, so in an AI agent's shell the handles are opaque `handle:` IDs:
 * they're matched as they are and never turned back into numbers.
 */
export class Directory {
  readonly #client: Caller;
  #people?: Promise<ReadonlyMap<string, string>>;
  #conversations?: Promise<ReadonlyMap<string, string>>;

  constructor(client: Caller) {
    this.#client = client;
  }

  /** Contact names by handle (empty when the client may not list contacts). */
  people(): Promise<ReadonlyMap<string, string>> {
    this.#people ??= this.#loadPeople();
    return this.#people;
  }

  /** Conversation titles by thread key, for the most recent conversations. */
  conversations(): Promise<ReadonlyMap<string, string>> {
    this.#conversations ??= this.#loadConversations();
    return this.#conversations;
  }

  /** The context a formatter needs, looking up only what `lookup` asks for. */
  async context(
    lookup: Lookup,
    options: Pick<FormatContext, "verbose" | "input">,
  ): Promise<FormatContext> {
    const [people, conversations] = await Promise.all([
      lookup.people ? this.people() : new Map<string, string>(),
      lookup.conversations ? this.conversations() : new Map<string, string>(),
    ]);
    return { ...options, people, conversations };
  }

  async #loadPeople(): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    try {
      for (let page = 0; page < MAX_CONTACT_PAGES; page++) {
        const contacts = (await this.#client.call("contact.list", {
          limit: PAGE,
          offset: page * PAGE,
        })) as Contact[];
        // Favourites come first, as the daemon picks a conversation's title.
        for (const c of contacts)
          for (const h of c.handles) if (!names.has(h)) names.set(h, c.name);
        if (contacts.length < PAGE) break;
      }
    } catch {
      // No contacts to name people by (say, an agent that may not read them): numbers it is.
    }
    return names;
  }

  async #loadConversations(): Promise<ReadonlyMap<string, string>> {
    try {
      const threads = (await this.#client.call("thread.list", { limit: PAGE })) as Thread[];
      return new Map(threads.map((t) => [t.key, t.title]));
    } catch {
      return new Map();
    }
  }
}

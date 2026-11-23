import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { type ContactDetails, errorCodeOf, TincanError } from "@beyland/tincan-protocol";
import type { EventBus } from "./events.ts";
import { normalizeEmail, normalizePhone } from "./keys.ts";
import type { ParsedVCard, PbapSessionHandle, PhonebookVersion, PhonePort } from "./phone.ts";
import { phoneContactId } from "./store/ids.ts";
import type { ContactInput, Store } from "./store/store.ts";

export interface ContactSyncOptions {
  store: Store;
  /** Only `PbapSession` is used. */
  port: Pick<PhonePort, "PbapSession">;
  /** The phone's Bluetooth address. */
  address: string;
  events: EventBus;
  /** Pull contact photos into the store (default true). */
  photos?: boolean;
  /** The settings' default region, read at each use. */
  defaultRegion?: () => string | undefined;
  /**
   * How often a connect may check the phonebook: each `sync.changed` → `connected` after this long
   * runs `sync()`. 0: only explicit syncs. Default 1 h.
   */
  autoIntervalMs?: number;
  /**
   * Pull again after this long even if the phone's version counters haven't moved (iOS may not
   * bump them for every edit). Default 24 h.
   */
  maxAgeMs?: number;
  transferTimeoutMs?: number;
  now?: () => number;
  /** Failures the sync recovered from. `context` names the step; never contact data. */
  onError?: (context: string, error: unknown) => void;
}

export interface ContactSyncResult {
  /** True when the phonebook hadn't changed and nothing was pulled. */
  skipped: boolean;
  /** Live contacts after the sync. */
  contacts: number;
  changed: number;
  removed: number;
  /** Contacts whose photo was added, replaced or cleared. */
  photos: number;
}

/** Local, per-phone bookkeeping kept in settings. */
interface PbapState {
  version: PhonebookVersion | null;
  syncedAt: number;
  /** The owner card's handles (entry 0 of `pb`): the user's own addresses. */
  ownHandles: string[];
}

const STATE_PREFIX = "pbap.";

/**
 * The user's own addresses from the owner card of the last contact sync, read from the store, so
 * they're known before (or without) a contact sync running: for the phone at `address`, or every
 * phone Tincan has synced when it isn't known.
 */
export function storedOwnHandles(store: Store, address?: string | null): string[] {
  const states = address
    ? [store.getSetting(`${STATE_PREFIX}${address.toUpperCase()}`)]
    : store.db
        .query<{ value: string }>("SELECT value FROM settings WHERE key LIKE 'pbap.%'")
        .map((row) => {
          try {
            return JSON.parse(row.value) as unknown;
          } catch {
            return null;
          }
        });
  const handles = new Set<string>();
  for (const state of states) {
    const own = (state as Partial<PbapState> | null)?.ownHandles;
    if (Array.isArray(own)) for (const h of own) if (typeof h === "string") handles.add(h);
  }
  return [...handles];
}

const DEFAULT_AUTO_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
const PHOTO_NAME = /^[0-9a-f]{64}\.(jpg|png|gif|webp)$/;
/** Larger files in the old photo folder aren't contact photos Tincan wrote. */
const MAX_PHOTO_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Mirrors the phone's address book over PBAP into `contacts` and `handles`.
 *
 * A sync pulls `pb` without photos first (about a second for hundreds of contacts), then `fav`
 * for favourites, then `pb` again with photos, which are kept in the store once each, named by
 * their hash.
 * It skips the pull when the phonebook's version counters haven't changed since the last one.
 * Syncs run one at a time; a sync requested while one runs joins it.
 */
export class ContactSync {
  readonly address: string;
  readonly #store: Store;
  readonly #port: Pick<PhonePort, "PbapSession">;
  readonly #events: EventBus;
  readonly #photos: boolean;
  readonly #defaultRegion: () => string | undefined;
  readonly #autoIntervalMs: number;
  readonly #maxAgeMs: number;
  readonly #transferTimeoutMs: number;
  readonly #now: () => number;
  readonly #onError: (context: string, error: unknown) => void;
  readonly #unsubscribe: () => void;
  #running: Promise<ContactSyncResult> | null = null;
  #lastError: { code: string; at: number } | null = null;
  #lastAutoAt: number | null = null;
  #stopped = false;

  constructor(options: ContactSyncOptions) {
    this.address = options.address.toUpperCase();
    this.#store = options.store;
    this.#port = options.port;
    this.#events = options.events;
    this.#photos = options.photos ?? true;
    this.#defaultRegion = options.defaultRegion ?? (() => undefined);
    this.#autoIntervalMs = options.autoIntervalMs ?? DEFAULT_AUTO_INTERVAL_MS;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
    this.#unsubscribe = this.#events.subscribe((event) => {
      if (event.event === "sync.changed" && event.data.state === "connected") this.#auto();
    });
  }

  /** When the last full pull finished, or null. */
  get lastSyncAt(): number | null {
    return this.#state()?.syncedAt ?? null;
  }

  /** Why the last pull failed (a `TincanError` code); cleared by the next one that works. */
  get lastError(): { code: string; at: number } | null {
    return this.#lastError;
  }

  /** The user's own addresses from the phone's owner card. */
  get ownHandles(): string[] {
    return this.#state()?.ownHandles ?? [];
  }

  /** Pulls the phonebook if it changed (or always, with `force`). */
  sync(options: { force?: boolean } = {}): Promise<ContactSyncResult> {
    if (this.#stopped)
      return Promise.reject(new TincanError("NOT_CONNECTED", "Tincan is shutting down"));
    if (this.#running) return this.#running;
    const running = this.#sync(options.force ?? false)
      .then(
        (result) => {
          this.#lastError = null;
          return result;
        },
        (error: unknown) => {
          this.#lastError = { code: errorCodeOf(error), at: this.#now() };
          throw error;
        },
      )
      .finally(() => {
        this.#running = null;
      });
    this.#running = running;
    return running;
  }

  /** Resolves once no sync is running. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running.catch(() => {});
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
  }

  #auto(): void {
    if (this.#stopped || this.#autoIntervalMs <= 0 || this.#running) return;
    const now = this.#now();
    if (this.#lastAutoAt !== null && now - this.#lastAutoAt < this.#autoIntervalMs) return;
    this.#lastAutoAt = now;
    this.sync().catch((error: unknown) => this.#onError("contacts.auto", error));
  }

  async #sync(force: boolean): Promise<ContactSyncResult> {
    const session = await this.#port.PbapSession.open(this.address, {
      transferTimeoutMs: this.#transferTimeoutMs,
    });
    try {
      const state = this.#state();
      const version = await session.version("pb").catch((error: unknown) => {
        this.#onError("contacts.version", error);
        return null;
      });
      const fresh = state !== null && this.#now() - state.syncedAt < this.#maxAgeMs;
      if (!force && fresh && version && sameVersion(version, state.version)) {
        return { skipped: true, contacts: this.#liveCount(), changed: 0, removed: 0, photos: 0 };
      }

      const [owner, ...cards] = await session.pull("pb", { photos: false });
      const favorites = await session.pull("fav", { photos: false }).catch((error: unknown) => {
        this.#onError("contacts.favorites", error);
        return [];
      });
      const favoriteIds = new Set(this.#identify(favorites).map((c) => c.id));
      const inputs = this.#identify(cards).map((c) => ({
        ...c.input,
        favorite: favoriteIds.has(c.id),
      }));
      const replaced = this.#store.replaceContacts(inputs);
      this.#announce([...replaced.changed, ...replaced.removed], replaced.handles);

      let photosDone = true;
      const photos = await this.#syncPhotos(session).catch((error: unknown) => {
        this.#onError("contacts.photos", error);
        photosDone = false;
        return 0;
      });

      this.#store.setSetting(this.#stateKey(), {
        // Without photos, the next sync pulls again rather than skipping.
        version: photosDone ? version : null,
        syncedAt: this.#now(),
        ownHandles: owner ? this.#handles(owner).map((h) => h.handle) : [],
      } satisfies PbapState);
      return {
        skipped: false,
        contacts: this.#liveCount(),
        changed: replaced.changed.length,
        removed: replaced.removed.length,
        photos,
      };
    } finally {
      await session.close().catch(() => {});
    }
  }

  async #syncPhotos(session: PbapSessionHandle): Promise<number> {
    if (!this.#photos) return 0;
    const [, ...cards] = await session.pull("pb", { photos: true });
    const store = this.#store;
    const identified = this.#identify(cards);
    const changed = store.db.transaction(() => {
      const ids: string[] = [];
      for (const { id, card } of identified) {
        const photo = card.photo?.data ? rasterPhoto(Buffer.from(card.photo.data, "base64")) : null;
        if (photo) store.putContactPhoto(photo.name, photo.mediaType, photo.bytes);
        if (store.setContactPhoto(id, photo?.name ?? null)) ids.push(id);
      }
      store.pruneContactPhotos();
      return ids;
    });
    this.#announce(changed, []);
    return changed.length;
  }

  /** Stable ids for cards, counting repeats of the same card. Cards with no name or no handles are dropped. */
  #identify(
    cards: readonly ParsedVCard[],
  ): Array<{ id: string; card: ParsedVCard; input: ContactInput }> {
    const seen = new Map<string, number>();
    const out: Array<{ id: string; card: ParsedVCard; input: ContactInput }> = [];
    for (const card of cards) {
      const handles = this.#handles(card);
      if (handles.length === 0) continue;
      const name = displayName(card, handles);
      if (!name) continue;
      const identity = {
        device: this.address,
        name,
        tels: card.tels.map((t) => t.value),
        emails: card.emails.map((e) => e.value),
      };
      const fingerprint = JSON.stringify([
        identity.name,
        [...identity.tels].sort(),
        [...identity.emails].sort(),
      ]);
      const occurrence = seen.get(fingerprint) ?? 0;
      seen.set(fingerprint, occurrence + 1);
      const id = phoneContactId(identity, occurrence);
      out.push({
        id,
        card,
        input: { id, name, favorite: card.favorite, handles, details: details(card) },
      });
    }
    return out;
  }

  #handles(card: ParsedVCard): ContactInput["handles"] {
    const region = this.#defaultRegion();
    const out: ContactInput["handles"] = [];
    for (const tel of card.tels) {
      const number = normalizePhone(tel.value, region);
      if (number) out.push({ handle: `tel:${number}`, label: label(tel.types) });
    }
    for (const email of card.emails) {
      const address = normalizeEmail(email.value);
      if (address) out.push({ handle: `email:${address}`, label: label(email.types) });
    }
    return out;
  }

  #announce(ids: string[], handles: string[]): void {
    if (ids.length > 0) this.#events.emit("contact.changed", { ids });
    const keys = this.#store.liveThreadKeys(handles);
    if (keys.length > 0) this.#events.emit("thread.changed", { keys });
  }

  #liveCount(): number {
    return (
      this.#store.db.query<{ n: number }>(
        "SELECT count(*) AS n FROM contacts WHERE deleted_at IS NULL",
      )[0]?.n ?? 0
    );
  }

  #stateKey(): string {
    return `${STATE_PREFIX}${this.address}`;
  }

  #state(): PbapState | null {
    const value = this.#store.getSetting(this.#stateKey());
    return value && typeof value === "object" ? (value as PbapState) : null;
  }
}

function sameVersion(a: PhonebookVersion, b: PhonebookVersion | null): boolean {
  if (!b || !a.primaryCounter || !a.databaseIdentifier) return false;
  return (
    a.databaseIdentifier === b.databaseIdentifier &&
    a.primaryCounter === b.primaryCounter &&
    a.secondaryCounter === b.secondaryCounter
  );
}

/** The card's name, else its first address as written. */
function displayName(card: ParsedVCard, handles: ContactInput["handles"]): string {
  const name = card.name.trim() || [card.given, card.family].filter(Boolean).join(" ").trim();
  if (name) return name;
  return card.tels[0]?.value.trim() || card.emails[0]?.value.trim() || (handles[0]?.handle ?? "");
}

/** The card's fields beyond name, handles and photo. Missing fields (older addons) count as empty. */
function details(card: ParsedVCard): ContactDetails {
  const text = (value: string | undefined) => value?.trim() || undefined;
  const labeled = (values: ParsedVCard["urls"] | undefined) =>
    (values ?? [])
      .filter((v) => v.value.trim())
      .map((v) => ({ label: label(v.types), value: v.value.trim() }));
  return {
    nickname: text(card.nickname),
    company: text(card.organization),
    department: text(card.department),
    jobTitle: text(card.title),
    birthday: text(card.birthday),
    note: text(card.note),
    addresses: labeled(card.addresses),
    urls: labeled(card.urls),
  };
}

/** The most specific vCard type (`cell`, `home`, `work`), without `pref`/`voice`/`internet`. */
function label(types: readonly string[]): string | null {
  const generic = new Set(["pref", "voice", "internet", "x400"]);
  return types.map((t) => t.toLowerCase()).find((t) => !generic.has(t)) ?? null;
}

/**
 * Moves the contact photos older versions of Tincan kept as plain files in `dir` (the data
 * folder's `photos/`) into the store: each valid photo a contact uses is imported, then every file
 * in `dir` is deleted and `dir` removed. Photos that were missing or unreadable come back with the
 * next contact sync. Null when there's no such folder.
 */
export function importPhotoFiles(
  store: Store,
  dir: string,
): { imported: number; deleted: number } | null {
  try {
    // A symlink isn't the folder Tincan made: leave it, and whatever it points at, alone.
    if (!lstatSync(dir).isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const used = store.contactPhotos();
  const names = readdirSync(dir);
  let imported = 0;
  for (const name of names) {
    if (!PHOTO_NAME.test(name) || !used.has(name) || store.hasContactPhoto(name)) continue;
    const photo = rasterPhoto(readPhotoFile(join(dir, name)));
    // The name is the content's hash: a file that doesn't match it isn't one Tincan wrote whole.
    if (photo?.name === name && store.putContactPhoto(name, photo.mediaType, photo.bytes)) {
      imported++;
    }
  }
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  rmdirSync(dir);
  return { imported, deleted: names.length };
}

/** A regular file's bytes, without following a symlink; null for anything else or too large. */
function readPhotoFile(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PHOTO_FILE_BYTES) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * A photo as the store keeps it, named by its content hash. Null if it's empty or isn't a raster
 * image `contact.photo` serves (JPEG, PNG, GIF or WebP): the declared type is ignored, so an SVG
 * (which can carry script) or anything else is never kept.
 */
function rasterPhoto(
  bytes: Buffer | null,
): { name: string; mediaType: string; bytes: Buffer } | null {
  if (!bytes || bytes.length === 0) return null;
  const extension = rasterExtension(bytes);
  if (!extension) return null;
  return {
    name: `${createHash("sha256").update(bytes).digest("hex")}.${extension}`,
    mediaType: MEDIA_TYPES[extension],
    bytes,
  };
}

const MEDIA_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
} as const;

/** The file extension for a raster image, from its first bytes; null for anything else. */
function rasterExtension(bytes: Uint8Array): keyof typeof MEDIA_TYPES | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "\x89PNG") return "png";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

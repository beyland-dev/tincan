import type { Message } from "@beyland/tincan-protocol";
import type { EventBus } from "./events.ts";
import { handleFor, normalizeThreadKey } from "./keys.ts";
import { parseTapback } from "./reactions.ts";
import type {
  MapEvent,
  MapLinkEvent,
  MapLinkHandle,
  MapLinkOptions,
  MapLinkState,
  MapListing,
  MapTrigger,
  ParsedBMessage,
  PhonePort,
} from "./phone.ts";
import type { NewMessage, ReadChange, Store } from "./store/store.ts";

export interface SyncEngineOptions {
  store: Store;
  /** Only `MapLink` is used. */
  port: Pick<PhonePort, "MapLink">;
  /** The phone's Bluetooth address. */
  address: string;
  events: EventBus;
  /** The settings' default region, read at each use. */
  defaultRegion?: () => string | undefined;
  /** The user's own handles from PBAP's owner card, to suppress self-thread MAP echoes. */
  ownHandles?: () => readonly string[];
  /** How often to re-list the inbox while connected, for read changes made on the phone. 0: never. */
  relistIntervalMs?: number;
  /** How many inbox messages the phone lists (iOS: 10). A full window with no overlap may hide a gap. */
  inboxWindow?: number;
  linkOptions?: MapLinkOptions | null;
  now?: () => number;
  /** Failures the engine recovered from. `context` names the step; never message content. */
  onError?: (context: string, error: unknown) => void;
  /**
   * Messages a pass stored, before its events go out. They may have moved since: re-read them
   * for their thread.
   */
  onAdded?: (messages: readonly Message[]) => void;
}

export type PassKind = "first" | "reconnect" | "relist" | "live";

/** What one sync pass did. */
export interface PassResult {
  kind: PassKind;
  listed: number;
  /** Messages stored for the first time. */
  added: Message[];
  /** Messages whose read state the phone changed. */
  readChanged: string[];
  /** Messages a tapback was added to or removed from. */
  reacted: string[];
  /** Listed messages Tincan couldn't fetch or key; they are tried again next pass. */
  skipped: number;
  gap: { fromAt: number; toAt: number } | null;
}

export interface SyncStatus {
  link: MapLinkState;
  syncing: boolean;
  lastSyncAt: number | null;
  /** Why the last attempt to open MAP failed (a `TincanError` code); cleared once connected. */
  lastError: { code: string; at: number } | null;
  /** Attempts to open MAP that failed in a row; reset once connected. */
  failures: number;
}

const INBOX = "inbox";

/**
 * Keeps the store in step with the phone's MAP inbox ([ADR 0006](../../../docs/decisions/0006-map-sync-model.md)).
 *
 * - After every connect it lists the inbox, fetches messages it hasn't seen and merges read flags:
 *   the first pass backfills, later ones catch up and look for gaps.
 * - A `notification` event is a live arrival: the only kind that raises a desktop notification.
 * - While connected it re-lists periodically, since iOS sends no read events.
 *
 * Work runs one step at a time, so passes and arrivals never interleave.
 */
export class SyncEngine {
  readonly address: string;
  readonly #store: Store;
  readonly #events: EventBus;
  readonly #defaultRegion: () => string | undefined;
  readonly #ownHandles: () => readonly string[];
  readonly #relistIntervalMs: number;
  readonly #inboxWindow: number;
  readonly #now: () => number;
  readonly #onError: (context: string, error: unknown) => void;
  readonly #onAdded: (messages: readonly Message[]) => void;
  #link: MapLinkHandle | null = null;
  #state: MapLinkState = { kind: "connecting", attempt: 1 };
  #lastError: SyncStatus["lastError"] = null;
  #failures = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #syncing = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  /** Paths are only valid in the session that listed them. */
  #paths = new Map<string, string>();
  /** Handles the phone reported as live arrivals that no pass has stored yet. */
  readonly #arriving = new Set<string>();

  private constructor(options: SyncEngineOptions) {
    this.address = options.address.toUpperCase();
    this.#store = options.store;
    this.#events = options.events;
    this.#defaultRegion = options.defaultRegion ?? (() => undefined);
    this.#ownHandles = options.ownHandles ?? (() => []);
    this.#relistIntervalMs = options.relistIntervalMs ?? 60_000;
    this.#inboxWindow = options.inboxWindow ?? 10;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
    this.#onAdded = options.onAdded ?? (() => {});
  }

  /** Starts the phone's MAP link. Syncing begins when it connects. */
  static async start(options: SyncEngineOptions): Promise<SyncEngine> {
    const engine = new SyncEngine(options);
    const started = options.port.MapLink.start(
      options.address,
      options.linkOptions ?? null,
      (event) => engine.#onLinkEvent(event),
    );
    // Events can arrive before `start` resolves; queued work waits for the handle.
    engine.#queue = started.then(
      (link) => {
        engine.#link = link;
      },
      () => {},
    );
    engine.#link = await started;
    return engine;
  }

  get status(): SyncStatus {
    return {
      link: this.#state,
      syncing: this.#syncing > 0,
      lastSyncAt: this.#store.getSyncState(this.address, INBOX)?.lastSyncAt ?? null,
      lastError: this.#lastError,
      failures: this.#failures,
    };
  }

  /** The MAP link while the phone is connected, for sending; null otherwise. */
  get mapLink(): MapLinkHandle | null {
    return this.#connected();
  }

  /** Re-lists the inbox now. Null when the phone isn't connected. */
  sync(): Promise<PassResult | null> {
    return this.#enqueue(() => this.#pass("relist"));
  }

  /** Passes a power or adapter change to the link's reconnect supervisor. */
  trigger(trigger: MapTrigger): void {
    this.#link?.trigger(trigger);
  }

  /**
   * Mirrors read changes made in Tincan to the phone. Returns how many it set; the rest (another
   * phone's, no handle, or not in the current listing) are skipped.
   */
  markReadOnPhone(changes: readonly ReadChange[], read = true): Promise<number> {
    return this.#enqueue(async () => {
      const link = this.#connected();
      if (!link) return 0;
      const state = this.#store.getSyncState(this.address, INBOX);
      let done = 0;
      for (const change of changes) {
        if (change.mapHandle === null || change.device?.toUpperCase() !== this.address) continue;
        const path = this.#paths.get(change.mapHandle);
        if (!path) continue;
        try {
          await link.setRead(path, read);
        } catch (error) {
          this.#onError("setRead", error);
          continue;
        }
        // So the next listing doesn't read this as a change made on the phone.
        if (state && change.mapHandle in state.lastListing) {
          state.lastListing[change.mapHandle] = read;
        }
        done++;
      }
      if (state && done > 0) this.#store.setSyncState(this.address, INBOX, state);
      return done;
    });
  }

  /** Resolves when queued work has finished. */
  async idle(): Promise<void> {
    let tail: Promise<unknown>;
    do {
      tail = this.#queue;
      await tail;
    } while (tail !== this.#queue);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopTimer();
    await this.idle();
    await this.#link?.shutdown();
  }

  // --- Events --------------------------------------------------------------

  #onLinkEvent(event: MapLinkEvent): void {
    switch (event.kind) {
      case "state":
        this.#onState(event.state);
        return;
      case "map":
        this.#onMapEvent(event.event);
        return;
      case "openFailed":
        this.#lastError = { code: event.code, at: this.#now() };
        this.#failures++;
        this.#onError("open", Object.assign(new Error(event.message), { code: event.code }));
        return;
      case "systemWatchFailed":
        this.#onError("systemWatch", Object.assign(new Error(event.message), { code: event.code }));
        return;
    }
  }

  #onState(state: MapLinkState): void {
    this.#state = state;
    this.#events.emit("sync.changed", { state: state.kind });
    if (state.kind !== "connected") {
      this.#stopTimer();
      this.#paths.clear();
      return;
    }
    this.#paths.clear();
    this.#lastError = null;
    this.#failures = 0;
    const kind: PassKind =
      this.#store.getSyncState(this.address, INBOX)?.lastSyncAt == null ? "first" : "reconnect";
    void this.#enqueue(() => this.#pass(kind));
    this.#startTimer();
  }

  #onMapEvent(event: MapEvent): void {
    switch (event.kind) {
      // An arrival. `messageAdded` alone is also raised for listed objects, so it never counts.
      case "statusChanged":
        if (event.status === "notification") {
          const live = { handle: event.handle, path: event.path };
          // An earlier pass may list this one before its own pass runs; it is still live.
          this.#arriving.add(event.handle);
          void this.#enqueue(() => this.#pass("live", live));
        }
        return;
      case "readChanged":
        void this.#enqueue(async () => this.#applyRead(event.handle, event.read));
        return;
      // The store is the history: nothing leaves it because the phone dropped it.
      case "messageAdded":
      case "folderChanged":
      case "messageRemoved":
      case "sessionClosed":
        return;
    }
  }

  // --- Passes --------------------------------------------------------------

  async #pass(kind: PassKind, live?: { handle: string; path: string }): Promise<PassResult | null> {
    const link = this.#connected();
    if (!link) return null;
    this.#syncing++;
    if (this.#syncing === 1) this.#events.emit("sync.changed", { state: "syncing" });
    try {
      return await this.#runPass(link, kind, live);
    } finally {
      this.#syncing--;
      if (this.#syncing === 0 && this.#state.kind === "connected") {
        this.#events.emit("sync.changed", { state: "connected" });
      }
    }
  }

  async #runPass(
    link: MapLinkHandle,
    kind: PassKind,
    live: { handle: string; path: string } | undefined,
  ): Promise<PassResult | null> {
    const store = this.#store;
    const previous = store.getSyncState(this.address, INBOX);
    const lastSeenAt = store.lastMessageAt(this.address);
    let listing: MapListing[];
    try {
      listing = await link.listMessages(INBOX, null);
    } catch (error) {
      this.#onError("list", error);
      return null;
    }
    const result: PassResult = {
      kind,
      listed: listing.length,
      added: [],
      readChanged: [],
      reacted: [],
      skipped: 0,
      gap: null,
    };
    for (const entry of listing) this.#paths.set(entry.handle, entry.path);

    let overlap = false;
    const fresh: MapListing[] = [];
    for (const entry of listing) {
      const known = store.mapHandleState(this.address, entry.handle);
      if (!known) {
        fresh.push(entry);
        continue;
      }
      overlap = true;
      this.#arriving.delete(entry.handle);
      if (known.deleted) continue;
      const before = previous?.lastListing[entry.handle];
      // Only a change on the phone counts: a read in Tincan not yet mirrored mustn't be undone.
      const changed =
        before === undefined
          ? entry.read && !known.read
          : before !== entry.read && entry.read !== known.read;
      if (changed && store.setMessageRead(known.id, entry.read)) result.readChanged.push(known.id);
    }

    // Oldest first, so identical texts in the same second number the same on every computer.
    const record = (stored: Stored) => {
      if (stored.kind === "skipped") result.skipped++;
      else if (stored.kind === "known") overlap = true;
      if (stored.message) result.added.push(stored.message);
      if (stored.reacted) result.reacted.push(stored.reacted);
    };
    for (const entry of oldestFirst(listing, fresh)) {
      const arriving = this.#arriving.delete(entry.handle) || entry.handle === live?.handle;
      record(await this.#fetchAndStore(link, entry.path, entry, arriving));
    }
    if (live && !listing.some((e) => e.handle === live.handle)) {
      this.#arriving.delete(live.handle);
      if (!store.mapHandleState(this.address, live.handle)) {
        const stored = await this.#fetchAndStore(link, live.path, null, true, live.handle);
        if (stored.kind !== "known") record(stored);
      }
    }

    if (
      kind === "reconnect" &&
      !overlap &&
      lastSeenAt !== null &&
      listing.length >= this.#inboxWindow
    ) {
      const toAt = Math.min(...listing.map((e) => e.timestamp * 1000));
      if (toAt > lastSeenAt) {
        store.recordGap({ device: this.address, threadKey: null, fromAt: lastSeenAt, toAt });
        result.gap = { fromAt: lastSeenAt, toAt };
      }
    }

    store.setSyncState(this.address, INBOX, {
      lastSyncAt: this.#now(),
      lastListing: Object.fromEntries(listing.map((e) => [e.handle, e.read])),
    });
    if (result.added.length > 0) {
      try {
        this.#onAdded(result.added);
      } catch (error) {
        this.#onError("added", error);
      }
    }
    this.#announce(result);
    return result;
  }

  /**
   * Fetches and stores one message, attaching a tapback to the message it quotes. `known`: the
   * store already had it (by content); `skipped`: it couldn't be fetched or keyed.
   */
  async #fetchAndStore(
    link: MapLinkHandle,
    path: string,
    entry: MapListing | null,
    notify: boolean,
    handle: string | null = entry?.handle ?? null,
  ): Promise<Stored> {
    let parsed: ParsedBMessage;
    try {
      parsed = await link.getMessage(path);
    } catch (error) {
      this.#onError("fetch", error);
      return { kind: "skipped" };
    }
    const input = toNewMessage(parsed, entry, {
      device: this.address,
      handle,
      now: this.#now(),
      region: this.#defaultRegion(),
    });
    if (!input) {
      this.#onError("key", new Error("Message has no usable address"));
      return { kind: "skipped" };
    }
    const store = this.#store;
    // Messaging yourself creates a MAP incoming echo right after Tincan's local outgoing copy.
    // Match it onto the outgoing row (adopting the MAP handle) so it doesn't show up twice.
    if (
      input.direction === "incoming" &&
      this.#ownHandles().includes(input.threadKey) &&
      store.matchSelfEcho(input)
    ) {
      return { kind: "known" };
    }
    const tapback = parseTapback(input.body);
    if (tapback) input.reactionKind = tapback.kind;
    const { message, inserted } = store.insertMessage({ ...input, notify });
    if (!inserted || !message) return { kind: "known" };
    if (!tapback) return { kind: "added", message };
    // Filed with the message it quotes, which may have been moved into a group. A removal
    // is stored and tombstoned, so it dedupes and never comes back.
    const placed = store.placeTapback(message.id);
    const target = placed?.target;
    if (placed?.removed) return target ? { kind: "added", reacted: target.id } : { kind: "added" };
    const stored = store.getMessage(message.id) ?? message;
    return target
      ? { kind: "added", message: stored, reacted: target.id }
      : { kind: "added", message: stored };
  }

  #applyRead(handle: string, read: boolean): void {
    const known = this.#store.mapHandleState(this.address, handle);
    if (!known || known.deleted || known.read === read) return;
    if (this.#store.setMessageRead(known.id, read)) {
      this.#announce({
        kind: "live",
        listed: 0,
        added: [],
        readChanged: [known.id],
        reacted: [],
        skipped: 0,
        gap: null,
      });
    }
  }

  /** Coarse events: one `message.changed` per thread, then `thread.changed` for all of them. */
  #announce(result: PassResult): void {
    const byThread = new Map<string, string[]>();
    const add = (threadKey: string, id: string) => {
      const ids = byThread.get(threadKey) ?? [];
      ids.push(id);
      byThread.set(threadKey, ids);
    };
    // Re-read: tapbacks and moves to a group change messages after they are stored.
    for (const id of [...result.added.map((m) => m.id), ...result.readChanged, ...result.reacted]) {
      const message = this.#store.getMessage(id);
      if (message && !byThread.get(message.threadKey)?.includes(id)) add(message.threadKey, id);
    }
    for (const [threadKey, ids] of byThread)
      this.#events.emit("message.changed", { threadKey, ids });
    if (byThread.size > 0) this.#events.emit("thread.changed", { keys: [...byThread.keys()] });
  }

  // --- Plumbing ------------------------------------------------------------

  #connected(): MapLinkHandle | null {
    return !this.#stopped && this.#state.kind === "connected" ? this.#link : null;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch((error: unknown) => this.#onError("sync", error));
    return run;
  }

  #startTimer(): void {
    this.#stopTimer();
    if (this.#relistIntervalMs <= 0 || this.#stopped) return;
    this.#timer = setInterval(() => void this.sync().catch(() => {}), this.#relistIntervalMs);
    this.#timer.unref?.();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

type Stored =
  | { kind: "added"; message?: Message; reacted?: string }
  | { kind: "known"; message?: undefined; reacted?: undefined }
  | { kind: "skipped"; message?: undefined; reacted?: undefined };

/** Listed entries to fetch, oldest first; ties keep the phone's order, oldest last in the list. */
function oldestFirst(listing: readonly MapListing[], fresh: readonly MapListing[]): MapListing[] {
  const position = new Map(listing.map((e, i) => [e.handle, i]));
  return fresh.toSorted(
    (a, b) => a.timestamp - b.timestamp || position.get(b.handle)! - position.get(a.handle)!,
  );
}

/**
 * A fetched MAP message as the store takes it, keyed canonically. Null when neither the message
 * nor its listing has an address Tincan can key.
 */
export function toNewMessage(
  parsed: ParsedBMessage,
  entry: MapListing | null,
  context: { device: string; handle: string | null; now: number; region?: string },
): NewMessage | null {
  const folder = (entry?.folder || parsed.folder).replace(/^\/?(telecom\/msg\/)?/, "");
  const outgoing = folder === "sent" || folder === "outbox";
  const senderRaw = parsed.originator.tel || parsed.originator.email || entry?.senderAddress || "";
  const sender = outgoing ? null : handleFor(senderRaw, context.region);
  const threadKey = normalizeThreadKey(parsed.threadKey, context.region) ?? sender;
  if (!threadKey) return null;
  const { body, attachmentHint } = extractAttachmentPlaceholders(parsed.body);
  return {
    threadKey,
    direction: outgoing ? "outgoing" : "incoming",
    sender,
    body,
    // MAP reports whole seconds. A live arrival missing from the listing takes the second it came.
    sentAt: entry ? entry.timestamp * 1000 : Math.floor(context.now / 1000) * 1000,
    receivedAt: context.now,
    source: "map",
    status: outgoing ? "sent" : "received",
    read: entry?.read ?? parsed.read,
    device: context.device,
    mapHandle: context.handle,
    folder,
    ...(attachmentHint ? { attachmentHint } : {}),
  };
}

/**
 * Strips Apple's U+FFFC object-replacement characters (inline attachment placeholders in iMessage
 * bMessages) from `raw` and records their count as an `attachmentHint`.
 */
function extractAttachmentPlaceholders(raw: string): {
  body: string;
  attachmentHint?: { count: number };
} {
  if (!raw.includes("\uFFFC")) return { body: raw };
  let count = 0;
  for (const ch of raw) if (ch === "\uFFFC") count++;
  const body = raw.replaceAll("\uFFFC", "").trim();
  return { body, attachmentHint: { count } };
}

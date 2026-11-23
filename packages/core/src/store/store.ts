import { createHash, randomUUID } from "node:crypto";
import {
  ContactDetails,
  SendFailureCode,
  TincanError,
  parseTapback,
} from "@beyland/tincan-protocol";
import type {
  HiddenGroup,
  HiddenPerson,
  AgentDraft,
  AgentDraftNote,
  AgentDraftState,
  AttachmentHint,
  Contact,
  Group,
  Message,
  MessageStatus,
  Reaction,
  Thread,
  device,
} from "@beyland/tincan-protocol";
import { formatLocalIso } from "../agent-privacy.ts";
import type { Db, SqlParam } from "./db.ts";
import { HybridClock } from "./hlc.ts";
import { phoneMessageId, uuidv7 } from "./ids.ts";
import { migrate } from "./migrations.ts";

export type ReactionKind = Reaction["kind"];

export type ConnectionEvent = device.ConnectionEvent;

/** How many connection log entries the store keeps. */
export const CONNECTION_LOG_LIMIT = 500;

/** A message as the sync engine, outbox or tests hand it to the store. */
export interface NewMessage {
  threadKey: string;
  threadKind?: Thread["kind"];
  direction: Message["direction"];
  sender: string | null;
  body: string;
  /** The phone's timestamp for MAP and ANCS messages; part of their id. */
  sentAt: number | null;
  receivedAt: number;
  source: Message["source"];
  status: MessageStatus;
  read: boolean;
  /** The phone's address, with `mapHandle` the dedupe key. */
  device?: string | null;
  mapHandle?: string | null;
  folder?: string | null;
  /** Apple's message GUID, when a backup import knows it. */
  appleGuid?: string | null;
  /**
   * Queue a desktop notification for it. Only for messages that arrive live on this computer;
   * catch-up passes and other computers' messages count as already notified.
   */
  notify?: boolean;
  reactionKind?: ReactionKind | null;
  reactionTo?: string | null;
  attachmentHint?: AttachmentHint | null;
  /** Sent by an AI agent (only for messages Tincan sends). */
  sentByAgent?: boolean;
  /** For an agent's message: its name, whether the user edited it, and how it was sent. */
  agent?: { name: string; edited: boolean; via: "user" | "policy" } | null;
}

export interface InsertResult {
  /** The stored message, or null if it was stored before and has since been deleted. */
  message: Message | null;
  /** False when the message was already stored (by handle, GUID or content). */
  inserted: boolean;
}

export interface ThreadListOptions {
  limit?: number;
  /** Only threads whose last activity is before this time (pagination). */
  before?: number;
  /**
   * Leave out conversations hidden from AI agents: groups the user hid, and conversations with a
   * hidden person in them (see `isThreadHiddenFromAgents`).
   */
  excludeAgentHidden?: boolean;
  /**
   * Only threads after this one in the list's order (activity time, then key): a stable cursor
   * that doesn't skip threads sharing a timestamp. `at` is the thread's activity time.
   */
  after?: { at: number | null; key: string };
  /** Only conversations an AI agent may read under this scope (see {@link AgentScopeFilter}). */
  agentScope?: AgentScopeFilter;
}

/**
 * Which conversations an AI agent may read, as `agents.read` and `agents.hideCodes` set it:
 * - `contacts`: the conversation has at least one member and every member is a saved contact or
 *   one of `ownHandles` (a one-to-one key with no members is checked itself).
 * - `known`: those, plus conversations the user has sent a message in themselves.
 * - `all`: every conversation.
 * With `hideCodes`, short codes and alphanumeric senders are left out whatever `read` says.
 * Hidden conversations are a separate check (`excludeAgentHidden`, `isThreadHiddenFromAgents`),
 * which always wins: a hidden person counts as a contact here, and is still never read.
 */
export interface AgentScopeFilter {
  read: "off" | "contacts" | "known" | "all";
  hideCodes: boolean;
  /** The user's own addresses, which count as contacts (the self conversation). */
  ownHandles: readonly string[];
}

/** The user's own saved draft. */
export interface DraftInfo {
  body: string;
  updatedAt: number;
}

/** A new agent draft, as the handlers hand it to the store. */
export interface NewAgentDraft {
  to: string;
  requestedAs?: string | null;
  agentName: string;
  intent: AgentDraft["intent"];
  text: string;
  state?: "queued" | "scheduled";
  note?: AgentDraftNote | null;
}

export interface AgentDraftQuery {
  states?: readonly AgentDraftState[];
  /** Only drafts to this recipient (the conversation's key). */
  to?: string;
  /** Only this agent's (by its cleaned-up name). */
  agentName?: string;
  limit?: number;
}

export interface MessageListOptions {
  limit?: number;
  /** Only messages before this time (pagination). */
  before?: number;
}

export interface SearchOptions {
  threadKey?: string;
  limit?: number;
  /** Skip this many matches first (pagination). */
  offset?: number;
  /** Only matches in conversations an AI agent may read, hidden ones left out too. */
  agentScope?: AgentScopeFilter;
}

/** A message whose read state changed locally, for mirroring it to the phone. */
export interface ReadChange {
  id: string;
  device: string | null;
  mapHandle: string | null;
}

export interface MapHandleState {
  id: string;
  threadKey: string;
  read: boolean;
  deleted: boolean;
}

/** Where the sync engine left off with one of the phone's folders. Local only. */
export interface SyncState {
  lastSyncAt: number | null;
  /** Read flags by handle, as the phone last listed them. */
  lastListing: Record<string, boolean>;
}

/** A stretch of time whose messages may not have reached Tincan. Local only. */
export interface Gap {
  id: number;
  device: string;
  /** Null when it may affect every thread. */
  threadKey: string | null;
  fromAt: number;
  toAt: number;
  detectedAt: number;
}

/** A contact as the phone has it, ready to mirror into the store. */
export interface ContactInput {
  /** Stable across computers: see `phoneContactId`. */
  id: string;
  name: string;
  favorite: boolean;
  handles: Array<{ handle: string; label: string | null }>;
  /** Extra card fields; omitted or empty when the card has none. */
  details?: ContactDetails;
}

/** What `replaceContacts` changed. */
export interface ContactsReplaced {
  /** Contacts added, changed or revived. */
  changed: string[];
  /** Contacts tombstoned because the phone no longer has them. */
  removed: string[];
  /** Every handle whose contact changed, before or after: their threads' titles may differ. */
  handles: string[];
}

export interface ContactListOptions {
  limit?: number;
  offset?: number;
  favoritesOnly?: boolean;
  /** Leave out contacts hidden from AI agents (`isContactHiddenFromAgents`). */
  excludeAgentHidden?: boolean;
}

/** What hiding someone from agents changed. */
export interface HiddenChange {
  /** The person, after the change. */
  person: HiddenPerson;
  /** Whether anything changed: a new person, or new handles for one. */
  changed: boolean;
  /** Handles hidden by this change. */
  added: string[];
}

/** A message Tincan is sending or has tried to send. Local only. */
export interface OutboxEntry {
  messageId: string;
  /** Addresses as the phone takes them: `+15550100001` or `ada@example.com`. */
  recipients: string[];
  attempts: number;
  /** The `TincanError` code of the last failure, if any. */
  lastError: string | null;
  /** When the running push started; null when none is running. */
  pushingSince: number | null;
  updatedAt: number;
  /** When a `scheduled` message goes to the phone. */
  sendAt: number | null;
  /** The agent draft it was sent from, if any. */
  agentDraftId: string | null;
}

interface MessageRow {
  id: string;
  thread_key: string;
  device: string | null;
  direction: Message["direction"];
  sender: string | null;
  body: string;
  sent_at: number | null;
  received_at: number;
  source: Message["source"];
  status: MessageStatus;
  read: number;
  map_handle: string | null;
  apple_guid: string | null;
  reaction_kind: ReactionKind | null;
  reaction_to: string | null;
  attachment_hint: string | null;
  deleted_at: number | null;
  sent_by_agent: number;
  agent_edited: number;
  agent_name: string | null;
  agent_via: string | null;
}

interface AgentDraftRow {
  id: string;
  recipient: string;
  thread_key: string | null;
  requested_as: string | null;
  agent_name: string;
  intent: AgentDraft["intent"];
  body: string;
  text: string;
  edited: number;
  revision: number;
  state: AgentDraftState;
  message_id: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface GroupRow {
  thread_key: string;
  name: string | null;
  named: number;
  participants: string;
  roster: string | null;
  route_invalidated: number;
}

interface ContactRow {
  id: string;
  name: string;
  photo_path: string | null;
  favorite: number;
  details: string | null;
  deleted_at: number | null;
}

interface HandleRow {
  contact_id: string;
  handle: string;
  label: string | null;
  deleted_at: number | null;
}

interface ThreadRow {
  key: string;
  kind: Thread["kind"];
  title: string | null;
  muted: number;
  /** Only in `SELECT *` rows; see `moveMessage`. */
  hidden?: number;
  agent_hidden: number;
  pinned: number;
  last_message_at: number | null;
  contact_name: string | null;
  group_name: string | null;
  group_participants?: string | null;
  unread: number;
  draft_text?: string | null;
  draft_at?: number | null;
}

/** Provenance for one local change to syncable rows (ADR 0007). */
interface Stamp {
  origin: string;
  updatedAt: string;
  changeSeq: number;
}

type ThreadFlag = "muted" | "hidden" | "agent_hidden" | "pinned";

const MESSAGE_COLUMNS = `id, thread_key, device, direction, sender, body, sent_at, received_at, source,
  status, read, map_handle, apple_guid, reaction_kind, reaction_to, attachment_hint, deleted_at,
  sent_by_agent, agent_edited, agent_name, agent_via`;

const CONTACT_COLUMNS = "id, name, photo_path, favorite, details, deleted_at";

const ORIGIN_KEY = "store.origin";
const CLOCK_KEY = "store.clock";
const CHANGE_SEQ_KEY = "store.changeSeq";

/**
 * The message store: every query Tincan runs, over a {@link Db}. Synchronous.
 *
 * Shaped for syncing between computers later (ADR 0007): stable message ids, a stamp (origin,
 * hybrid logical clock, change sequence) on every change to a syncable row, and tombstones instead
 * of deletes. Nothing here syncs.
 */
export class Store {
  readonly db: Db;
  /** This computer's id, created once per install. */
  readonly origin: string;
  readonly #now: () => number;
  readonly #clock: HybridClock;
  #changeSeq: number;

  private constructor(db: Db, now: () => number) {
    this.db = db;
    this.#now = now;
    let origin = this.getSetting(ORIGIN_KEY);
    if (typeof origin !== "string") {
      origin = randomUUID();
      this.setSetting(ORIGIN_KEY, origin);
    }
    this.origin = origin as string;
    const last = this.getSetting(CLOCK_KEY);
    this.#clock = new HybridClock(this.origin, now, typeof last === "string" ? last : undefined);
    this.#changeSeq = Number(this.getSetting(CHANGE_SEQ_KEY) ?? 0);
  }

  /** Migrates `db` to the current schema and wraps it. */
  static open(db: Db, options: { now?: () => number } = {}): Store {
    migrate(db);
    const store = new Store(db, options.now ?? Date.now);
    // Tapback spellings Tincan learned after storing them (`Kaia liked “…”`).
    store.reparseTapbacks();
    return store;
  }

  /** The newest local change sequence: rows with a higher `change_seq` changed after it. */
  get changeSeq(): number {
    return this.#changeSeq;
  }

  // --- Settings (local) ----------------------------------------------------

  getSetting(key: string): unknown {
    const row = this.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?", [
      key,
    ])[0];
    return row ? JSON.parse(row.value) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, JSON.stringify(value)],
    );
  }

  // --- Threads -------------------------------------------------------------

  /** Creates the thread, or revives a deleted one. Returns whether it did either. */
  ensureThread(key: string, kind: Thread["kind"] = inferKind(key)): boolean {
    return this.#write(() => {
      const row = this.db.query<{ deleted_at: number | null }>(
        "SELECT deleted_at FROM threads WHERE key = ?",
        [key],
      )[0];
      if (row && row.deleted_at === null) return false;
      const s = this.#stamp();
      if (row) {
        this.db.exec(
          `UPDATE threads SET deleted_at = NULL, hidden = 0, origin = ?, updated_at = ?, change_seq = ?
           WHERE key = ?`,
          [s.origin, s.updatedAt, s.changeSeq, key],
        );
      } else {
        this.db.exec(
          `INSERT INTO threads (key, kind, created_at, origin, updated_at, change_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [key, kind, this.#now(), s.origin, s.updatedAt, s.changeSeq],
        );
      }
      if (kind === "direct") this.#addMember(key, key, s);
      return true;
    });
  }

  setThreadMembers(key: string, handles: readonly string[]): void {
    this.#write(() => {
      const wanted = new Set(handles);
      const current = this.db
        .query<{ handle: string }>(
          "SELECT handle FROM thread_members WHERE thread_key = ? AND deleted_at IS NULL",
          [key],
        )
        .map((r) => r.handle);
      const removed = current.filter((h) => !wanted.has(h));
      const added = [...wanted].filter((h) => !current.includes(h));
      if (removed.length === 0 && added.length === 0) return;
      const s = this.#stamp();
      for (const handle of removed) {
        this.db.exec(
          `UPDATE thread_members SET deleted_at = ?, origin = ?, updated_at = ?, change_seq = ?
           WHERE thread_key = ? AND handle = ?`,
          [this.#now(), s.origin, s.updatedAt, s.changeSeq, key, handle],
        );
      }
      for (const handle of added) this.#addMember(key, handle, s);
    });
  }

  setThreadTitle(key: string, title: string | null): boolean {
    return this.#setThreadField(key, "title", title);
  }

  setThreadMuted(key: string, muted: boolean): boolean {
    return this.#setThreadField(key, "muted", muted);
  }

  /**
   * Hides the conversation from AI agents until the user shows it to them again. New messages
   * don't clear it, and neither does deleting the conversation.
   */
  setThreadHiddenFromAgents(key: string, hidden: boolean): boolean {
    return this.#setThreadField(key, "agent_hidden", hidden);
  }

  setThreadPinned(key: string, pinned: boolean): boolean {
    return this.#setThreadField(key, "pinned", pinned);
  }

  /** Tombstones the thread with its members, group and messages, and drops its draft. */
  deleteThread(key: string): boolean {
    return this.#write(() => {
      if (!this.#liveThread(key)) return false;
      const s = this.#stamp();
      const now = this.#now();
      const params = [now, s.origin, s.updatedAt, s.changeSeq, key];
      const tombstone = `deleted_at = ?, origin = ?, updated_at = ?, change_seq = ?`;
      this.db.exec(
        "DELETE FROM unnotified WHERE message_id IN (SELECT id FROM messages WHERE thread_key = ?)",
        [key],
      );
      this.db.exec(
        `UPDATE messages SET ${tombstone}, body = '', attachment_hint = NULL
         WHERE thread_key = ? AND deleted_at IS NULL`,
        params,
      );
      for (const table of ["thread_members", "groups"]) {
        this.db.exec(
          `UPDATE ${table} SET ${tombstone} WHERE thread_key = ? AND deleted_at IS NULL`,
          params,
        );
      }
      this.db.exec(`UPDATE threads SET ${tombstone}, last_message_at = NULL WHERE key = ?`, params);
      this.db.exec("DELETE FROM drafts WHERE thread_key = ?", [key]);
      return true;
    });
  }

  getThread(key: string): Thread | null {
    const row = this.db.query<ThreadRow>(
      `${THREAD_SELECT} WHERE t.key = ? AND t.deleted_at IS NULL`,
      [key],
    )[0];
    return row ? this.#thread(row) : null;
  }

  listThreads(options: ThreadListOptions = {}): Thread[] {
    const params: SqlParam[] = [];
    // `hidden`: an empty conversation left behind by moving its messages (see `moveMessage`).
    const where = ["t.deleted_at IS NULL", "t.hidden = 0"];
    if (options.excludeAgentHidden) where.push(`NOT ${agentHiddenSql("t.key")}`);
    if (options.before !== undefined) {
      where.push("t.last_message_at < ?");
      params.push(options.before);
    }
    if (options.agentScope) {
      const scope = agentScopeSql("t.key", options.agentScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const after = options.after;
    if (after) {
      // The list's own order: active threads newest first, then ones without messages, by key.
      if (after.at === null) {
        where.push("t.last_message_at IS NULL AND t.key > ?");
        params.push(after.key);
      } else {
        where.push(
          "(t.last_message_at IS NULL OR t.last_message_at < ? OR (t.last_message_at = ? AND t.key > ?))",
        );
        params.push(after.at, after.at, after.key);
      }
    }
    const rows = this.db.query<ThreadRow>(
      `${THREAD_SELECT} WHERE ${where.join(" AND ")}
       ORDER BY t.last_message_at IS NULL, t.last_message_at DESC, t.key
       LIMIT ?`,
      [...params, clampLimit(options.limit)],
    );
    return rows.map((row) => this.#thread(row));
  }

  /** Marks every unread incoming message in the thread read. */
  markThreadRead(key: string): ReadChange[] {
    return this.#write(() => {
      const rows = this.db.query<{ id: string; device: string | null; map_handle: string | null }>(
        `SELECT id, device, map_handle FROM messages
         WHERE thread_key = ? AND direction = 'incoming' AND read = 0 AND deleted_at IS NULL`,
        [key],
      );
      if (rows.length === 0) return [];
      const s = this.#stamp();
      this.db.exec(
        `UPDATE messages SET read = 1, origin = ?, updated_at = ?, change_seq = ?
         WHERE thread_key = ? AND direction = 'incoming' AND read = 0 AND deleted_at IS NULL`,
        [s.origin, s.updatedAt, s.changeSeq, key],
      );
      return rows.map((r) => ({ id: r.id, device: r.device, mapHandle: r.map_handle }));
    });
  }

  #thread(row: ThreadRow): Thread {
    const members = this.db
      .query<{ handle: string }>(
        "SELECT handle FROM thread_members WHERE thread_key = ? AND deleted_at IS NULL ORDER BY handle",
        [row.key],
      )
      .map((m) => m.handle);
    const last = this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE thread_key = ? AND reaction_to IS NULL AND deleted_at IS NULL
       ORDER BY sort_at DESC, rowid DESC LIMIT 1`,
      [row.key],
    )[0];
    return {
      key: row.key,
      kind: row.kind,
      title: threadTitle(row),
      members,
      lastMessage: last ? this.#messages([last])[0]! : null,
      unread: row.unread,
      muted: row.muted === 1,
      ...this.#hiddenFields(row, members),
      pinned: row.pinned === 1,
      ...(row.draft_text != null && row.draft_at != null
        ? { draft: { text: row.draft_text, updatedAt: row.draft_at } }
        : {}),
    };
  }

  /**
   * Whether a thread is hidden from agents and why, from the same rules as
   * `isThreadHiddenFromAgents`: the group itself, or a hidden person in it (its key, a member or
   * someone on its roster). An empty conversation left by moving its messages isn't shown as hidden.
   */
  #hiddenFields(
    row: ThreadRow,
    members: readonly string[],
  ): Pick<Thread, "hiddenFromAgents" | "hiddenBy" | "hiddenPerson"> {
    const roster = row.kind === "group" ? (this.getGroup(row.key)?.roster ?? []) : [];
    const handles = [...new Set([row.key, ...members, ...roster])];
    const person = this.db.query<{ id: string; label: string }>(
      `SELECT p.id, p.label FROM agent_hidden_handles ah
       JOIN agent_hidden_people p ON p.id = ah.person_id
       WHERE ah.handle IN (${handles.map(() => "?").join(", ")})
       ORDER BY ah.handle = ? DESC, ah.handle LIMIT 1`,
      [...handles, row.key],
    )[0];
    const byGroup = row.agent_hidden === 1;
    if (!byGroup && !person) return { hiddenFromAgents: false };
    return {
      hiddenFromAgents: true,
      hiddenBy: byGroup ? "group" : "person",
      ...(person ? { hiddenPerson: { id: person.id, label: person.label } } : {}),
    };
  }

  #liveThread(key: string): ThreadRow | undefined {
    return this.db.query<ThreadRow>("SELECT * FROM threads WHERE key = ? AND deleted_at IS NULL", [
      key,
    ])[0];
  }

  #setThreadField(
    key: string,
    column: "title" | ThreadFlag,
    value: string | boolean | null,
  ): boolean {
    return this.#write(() => {
      const row = this.#liveThread(key);
      if (!row) return false;
      const stored = typeof value === "boolean" ? (value ? 1 : 0) : value;
      if (row[column] === stored) return true;
      const s = this.#stamp();
      this.db.exec(
        `UPDATE threads SET ${column} = ?, origin = ?, updated_at = ?, change_seq = ? WHERE key = ?`,
        [stored, s.origin, s.updatedAt, s.changeSeq, key],
      );
      return true;
    });
  }

  #addMember(key: string, handle: string, s: Stamp): void {
    this.db.exec(
      `INSERT INTO thread_members (thread_key, handle, origin, updated_at, change_seq)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (thread_key, handle) DO UPDATE SET deleted_at = NULL, origin = excluded.origin,
         updated_at = excluded.updated_at, change_seq = excluded.change_seq
       WHERE thread_members.deleted_at IS NOT NULL`,
      [key, handle, s.origin, s.updatedAt, s.changeSeq],
    );
  }

  /** Recomputes the thread's activity time, which is derived and never merged. */
  #refreshActivity(key: string): void {
    this.db.exec(
      `UPDATE threads SET last_message_at = (
         SELECT max(sort_at) FROM messages
         WHERE thread_key = ? AND reaction_to IS NULL AND deleted_at IS NULL)
       WHERE key = ?`,
      [key, key],
    );
  }

  // --- Messages ------------------------------------------------------------

  /**
   * Stores a message unless it is already there: by `(device, mapHandle)`, by Apple GUID, else by
   * content (an earlier copy without a handle adopts this one's). A message that was deleted stays
   * deleted. Creates or revives the thread, keeps its activity time and brings it back into the
   * list if moving its messages had left it empty.
   */
  insertMessage(input: NewMessage): InsertResult {
    return this.#write(() => {
      const device = input.device ? input.device.toUpperCase() : null;
      const mapHandle = input.mapHandle ?? null;
      const appleGuid = input.appleGuid ?? null;
      if (device !== null && mapHandle !== null) {
        const existing = this.#messageRow("device = ? AND map_handle = ?", [device, mapHandle]);
        if (existing) return this.#existing(existing);
      }
      if (appleGuid !== null) {
        const existing = this.#messageRow("apple_guid = ?", [appleGuid]);
        if (existing) return this.#existing(existing);
      }

      const hash = contentHash(input);
      // A copy with a handle only matches one without (an earlier ANCS or Tincan copy), so two
      // identical texts listed by MAP stay two messages.
      // Every send from Tincan is its own message, however alike.
      const twin =
        input.source === "local"
          ? undefined
          : this.#messageRow(
              mapHandle === null
                ? "content_hash = ? AND status <> 'scheduled'"
                : "content_hash = ? AND map_handle IS NULL AND status <> 'scheduled'",
              [hash],
            );
      if (twin) {
        // The handle is a local dedupe key, so adopting it isn't a syncable change.
        if (mapHandle !== null && twin.map_handle === null) {
          this.db.exec("UPDATE messages SET device = ?, map_handle = ? WHERE id = ?", [
            device,
            mapHandle,
            twin.id,
          ]);
        }
        if (appleGuid !== null && twin.apple_guid === null) {
          const s = this.#stamp();
          this.db.exec(
            "UPDATE messages SET apple_guid = ?, origin = ?, updated_at = ?, change_seq = ? WHERE id = ?",
            [appleGuid, s.origin, s.updatedAt, s.changeSeq, twin.id],
          );
        }
        return this.#existing(twin);
      }

      this.ensureThread(input.threadKey, input.threadKind);
      const sortAt = input.sentAt ?? input.receivedAt;
      const id =
        input.source === "local" ? uuidv7(this.#now()) : this.#phoneId(input, device, sortAt);
      const s = this.#stamp();
      this.db.exec(
        `INSERT INTO messages (id, thread_key, device, direction, sender, body, sent_at, received_at,
           sort_at, source, status, read, map_handle, folder, content_hash, apple_guid, reaction_kind,
           reaction_to, attachment_hint, sent_by_agent, agent_edited, agent_name, agent_via, origin,
           updated_at, change_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.threadKey,
          device,
          input.direction,
          input.sender,
          input.body,
          input.sentAt,
          input.receivedAt,
          sortAt,
          input.source,
          input.status,
          input.read,
          mapHandle,
          input.folder ?? null,
          hash,
          appleGuid,
          input.reactionKind ?? null,
          input.reactionTo ?? null,
          input.attachmentHint ? JSON.stringify(input.attachmentHint) : null,
          (input.sentByAgent === true || Boolean(input.agent)) && input.direction === "outgoing",
          input.agent?.edited === true,
          input.agent?.name ?? null,
          input.agent?.via ?? null,
          s.origin,
          s.updatedAt,
          s.changeSeq,
        ],
      );
      if (input.notify) this.db.exec("INSERT INTO unnotified (message_id) VALUES (?)", [id]);
      this.#refreshActivity(input.threadKey);
      this.#setThreadField(input.threadKey, "hidden", false);
      if (!input.reactionKind) this.#adoptTapbacks(id);
      return { message: this.getMessage(id)!, inserted: true };
    });
  }

  /**
   * Matches an incoming MAP echo on a self-conversation to a recent local outgoing message with the
   * same body, adopting its `(device, mapHandle)` so future syncs skip it. Returns true if matched.
   */
  matchSelfEcho(input: NewMessage, windowMs = 120_000): boolean {
    const at = input.sentAt ?? input.receivedAt;
    const match = this.db.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE thread_key = ? AND direction = 'outgoing' AND source = 'local'
         AND status <> 'scheduled'
         AND body = ? AND map_handle IS NULL AND deleted_at IS NULL
         AND abs(sort_at - ?) <= ?
       ORDER BY abs(sort_at - ?) ASC LIMIT 1`,
      [input.threadKey, input.body, at, windowMs, at],
    )[0];
    if (!match) return false;
    if (input.device && input.mapHandle) {
      this.db.exec("UPDATE messages SET device = ?, map_handle = ? WHERE id = ?", [
        input.device.toUpperCase(),
        input.mapHandle,
        match.id,
      ]);
    }
    return true;
  }

  /**
   * Whether the user has sent anything in the thread themselves: from the phone or a Tincan app,
   * not an AI agent. The phone's copy of an agent's send (the same text, within a few minutes of
   * it) doesn't count; an agent message the user deleted is no longer there to explain one.
   */
  hasUserSentMessage(threadKey: string): boolean {
    return (
      this.db.query(`SELECT 1 FROM (SELECT ? AS k) q WHERE ${userSentSql("q.k")}`, [threadKey])
        .length > 0
    );
  }

  /** Whether an AI agent may read the thread under `scope`, short codes included (hidden aside). */
  inAgentScope(threadKey: string, scope: AgentScopeFilter): boolean {
    const { sql, params } = agentScopeSql("q.k", scope);
    return (
      this.db.query(`SELECT 1 FROM (SELECT ? AS k) q WHERE ${sql}`, [threadKey, ...params]).length >
      0
    );
  }

  /**
   * Whether a conversation is hidden from AI agents: its key is a hidden handle (with or without a
   * conversation yet), the user hid the group, or a hidden person is a member or on its roster.
   * That outlasts deleting it: a new message brings it back still hidden from them. An empty
   * conversation left behind by moving its messages (`hidden`) counts too, until a message
   * arrives. Display names in groups Tincan knows only from notifications aren't matched.
   */
  isThreadHiddenFromAgents(threadKey: string): boolean {
    return (
      this.db.query(`SELECT 1 FROM (SELECT ? AS k) q WHERE ${agentHiddenSql("q.k")}`, [threadKey])
        .length > 0
    );
  }

  /** Records that an AI agent sent the message (an outgoing one), not the user. */
  markSentByAgent(id: string): void {
    this.db.exec(
      "UPDATE messages SET sent_by_agent = 1 WHERE id = ? AND direction = 'outgoing' AND sent_by_agent = 0",
      [id],
    );
  }

  /** Whether an AI agent sent the message. */
  isSentByAgent(id: string): boolean {
    return (
      this.db.query<{ v: number }>("SELECT sent_by_agent AS v FROM messages WHERE id = ?", [id])[0]
        ?.v === 1
    );
  }

  getMessage(id: string): Message | null {
    const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
    return row ? this.#messages([row])[0]! : null;
  }

  findByMapHandle(device: string, mapHandle: string): Message | null {
    const row = this.#messageRow("device = ? AND map_handle = ? AND deleted_at IS NULL", [
      device.toUpperCase(),
      mapHandle,
    ]);
    return row ? this.#messages([row])[0]! : null;
  }

  /** A thread's messages, newest first. Tapbacks attached to a message are folded into it. */
  listMessages(threadKey: string, options: MessageListOptions = {}): Message[] {
    const before = options.before !== undefined;
    const rows = this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE thread_key = ? AND reaction_to IS NULL AND deleted_at IS NULL ${before ? "AND sort_at < ?" : ""}
       ORDER BY sort_at DESC, rowid DESC LIMIT ?`,
      before
        ? [threadKey, options.before, clampLimit(options.limit)]
        : [threadKey, clampLimit(options.limit)],
    );
    return this.#messages(rows);
  }

  /** Full-text search over message bodies, newest first. Never throws on odd input. */
  search(query: string, options: SearchOptions = {}): Message[] {
    const match = ftsQuery(query);
    if (!match) return [];
    // A message still held for its send delay isn't sent yet, and may never be.
    const where = ["messages_fts MATCH ?", "m.deleted_at IS NULL", "m.status <> 'scheduled'"];
    const params: SqlParam[] = [match];
    if (options.threadKey) {
      where.push("m.thread_key = ?");
      params.push(options.threadKey);
    }
    let join = "";
    if (options.agentScope) {
      join = "JOIN threads st ON st.key = m.thread_key";
      where.push(`st.hidden = 0 AND NOT ${agentHiddenSql("m.thread_key")}`);
      const scope = agentScopeSql("m.thread_key", options.agentScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const rows = this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS.replace(/(^|,\s*)/g, "$1m.")} FROM messages_fts f
       JOIN messages m ON m.rowid = f.rowid ${join}
       WHERE ${where.join(" AND ")}
       ORDER BY m.sort_at DESC, m.rowid DESC LIMIT ? OFFSET ?`,
      [...params, clampLimit(options.limit), Math.max(0, Math.trunc(options.offset ?? 0))],
    );
    return this.#messages(rows);
  }

  setMessageStatus(id: string, status: MessageStatus): boolean {
    return this.#setMessageField(id, "status", status);
  }

  /** Returns whether the read state changed. */
  setMessageRead(id: string, read: boolean): boolean {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
      if (!row || row.read === (read ? 1 : 0)) return false;
      return this.#setMessageField(id, "read", read);
    });
  }

  /** Moves a message to another thread (the user moving it to a group). */
  moveMessage(id: string, threadKey: string, threadKind?: Thread["kind"]): boolean {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
      if (!row) return false;
      if (row.thread_key === threadKey) return true;
      this.ensureThread(threadKey, threadKind);
      this.#setThreadField(threadKey, "hidden", false);
      this.#setMessageField(id, "thread_key", threadKey);
      this.#refreshActivity(row.thread_key);
      this.#refreshActivity(threadKey);
      // A message is stored under its sender before it's moved: don't leave that conversation
      // behind empty in the list. Hidden (`hidden`, which only this sets), not deleted: the next
      // message there shows it again.
      const left = this.db.query(
        "SELECT 1 FROM messages WHERE thread_key = ? AND deleted_at IS NULL LIMIT 1",
        [row.thread_key],
      );
      if (left.length === 0) this.#setThreadField(row.thread_key, "hidden", true);
      return true;
    });
  }

  /**
   * Attaches a stored tapback Tincan couldn't place to the message it reacts to, in that message's
   * thread. Returns whether it changed.
   */
  attachReaction(id: string, targetId: string): boolean {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
      const target = this.#messageRow("id = ? AND deleted_at IS NULL", [targetId]);
      if (!row || !target || row.reaction_kind === null || row.reaction_to === targetId)
        return false;
      if (target.reaction_kind !== null) return false;
      this.moveMessage(id, target.thread_key);
      return this.#setMessageField(id, "reaction_to", targetId);
    });
  }

  /**
   * The message a tapback quotes: the newest one at or before `before` whose text is `text`, or
   * starts with it when iOS cut the quote short with `…`. Looks in `threadKey`, then in the
   * groups `sender` is a member of.
   */
  findReactionTarget(input: {
    threadKey: string;
    sender: string | null;
    text: string;
    before: number;
  }): Message | null {
    const truncated = input.text.endsWith("…");
    const prefix = truncated ? input.text.slice(0, -1) : input.text;
    if (!prefix) return null;
    const keys = [input.threadKey];
    if (input.sender) {
      for (const row of this.db.query<{ thread_key: string }>(
        `SELECT m.thread_key FROM thread_members m JOIN threads t ON t.key = m.thread_key
         WHERE m.handle = ? AND m.deleted_at IS NULL AND t.kind = 'group' AND t.deleted_at IS NULL`,
        [input.sender],
      )) {
        if (!keys.includes(row.thread_key)) keys.push(row.thread_key);
      }
    }
    for (const key of keys) {
      const rows = this.db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE thread_key = ? AND reaction_kind IS NULL AND deleted_at IS NULL AND sort_at <= ?
           AND ${truncated ? "substr(body, 1, length(?)) = ?" : "body = ?"}
         ORDER BY sort_at DESC, rowid DESC LIMIT 1`,
        truncated ? [key, input.before, prefix, prefix] : [key, input.before, prefix],
      );
      if (rows[0]) return this.#messages(rows)[0]!;
    }
    return null;
  }

  /**
   * Tombstones the newest live tapback of `kind` from `sender` on `targetId` (iOS sent its
   * removal). Returns its id, or null if there was none.
   */
  removeReaction(targetId: string, sender: string | null, kind: ReactionKind): string | null {
    return this.#write(() => {
      const row = this.db.query<{ id: string }>(
        `SELECT id FROM messages
         WHERE reaction_to = ? AND sender IS ? AND reaction_kind = ? AND deleted_at IS NULL
         ORDER BY sort_at DESC, rowid DESC LIMIT 1`,
        [targetId, sender, kind],
      )[0];
      if (!row) return null;
      this.deleteMessage(row.id);
      return row.id;
    });
  }

  /**
   * Files a stored message that spells out a tapback: marks it as one and attaches it to the
   * message it quotes. A removal tombstones the tapback it takes back (placed or not) and itself.
   * A tapback whose message Tincan doesn't have stays unplaced, until that message arrives.
   */
  placeTapback(id: string): { target: Message | null; removed: boolean } | null {
    return this.#write(() => {
      const message = this.getMessage(id);
      const tapback = message && parseTapback(message.body);
      if (!message || !tapback) return null;
      if (message.reaction !== tapback.kind)
        this.#setMessageField(id, "reaction_kind", tapback.kind);
      const target = this.findReactionTarget({
        threadKey: message.threadKey,
        sender: message.sender,
        text: tapback.target,
        before: message.sentAt ?? message.receivedAt,
      });
      if (tapback.removed) {
        if (target) this.removeReaction(target.id, message.sender, tapback.kind);
        else this.#removeUnplacedTapback(message, tapback.kind, tapback.target);
        this.deleteMessage(id);
        return { target, removed: true };
      }
      if (target) this.attachReaction(id, target.id);
      return { target, removed: false };
    });
  }

  /**
   * Turns stored messages that spell out a tapback, which an older Tincan read as text, into
   * tapbacks. Returns how many it changed.
   */
  reparseTapbacks(): number {
    return this.#write(() => {
      const rows = this.db.query<{ id: string; body: string }>(
        `SELECT id, body FROM messages
         WHERE reaction_kind IS NULL AND deleted_at IS NULL AND substr(body, -1) IN ('”', '"')`,
      );
      let changed = 0;
      for (const row of rows) {
        if (parseTapback(row.body) && this.placeTapback(row.id)) changed++;
      }
      return changed;
    });
  }

  #removeUnplacedTapback(message: Message, kind: ReactionKind, text: string): void {
    const rows = this.db.query<{ id: string; body: string }>(
      `SELECT id, body FROM messages
       WHERE thread_key = ? AND sender IS ? AND reaction_kind = ? AND reaction_to IS NULL
         AND deleted_at IS NULL AND id != ? AND sort_at <= ?
       ORDER BY sort_at DESC, rowid DESC`,
      [message.threadKey, message.sender, kind, message.id, message.sentAt ?? message.receivedAt],
    );
    const match = rows.find((r) => {
      const t = parseTapback(r.body);
      return t && !t.removed && t.target === text;
    });
    if (match) this.deleteMessage(match.id);
  }

  /**
   * Attaches unplaced tapbacks to a message that has just arrived, when they quote it: the
   * message reached Tincan after its tapbacks (a later sync or a backup import). Looks in its
   * thread and, for a group, in its members' own threads, where a relayed tapback lands.
   */
  #adoptTapbacks(id: string): void {
    const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
    if (!row || row.reaction_kind !== null || !row.body) return;
    const keys = [row.thread_key];
    if (row.thread_key.startsWith("group:")) {
      for (const member of this.db.query<{ handle: string }>(
        "SELECT handle FROM thread_members WHERE thread_key = ? AND deleted_at IS NULL",
        [row.thread_key],
      )) {
        keys.push(member.handle);
      }
    }
    const tapbacks = this.db.query<{ id: string; body: string }>(
      `SELECT id, body FROM messages
       WHERE thread_key IN (${keys.map(() => "?").join(", ")}) AND reaction_kind IS NOT NULL
         AND reaction_to IS NULL AND deleted_at IS NULL AND sort_at >= ?`,
      [...keys, row.sent_at ?? row.received_at],
    );
    for (const tapback of tapbacks) {
      const parsed = parseTapback(tapback.body);
      if (parsed && !parsed.removed && quotes(parsed.target, row.body)) {
        this.attachReaction(tapback.id, id);
      }
    }
  }

  /** Tombstones a message and the tapbacks on it, clearing their text. */
  deleteMessage(id: string): boolean {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL", [id]);
      if (!row) return false;
      const s = this.#stamp();
      this.db.exec(
        "DELETE FROM unnotified WHERE message_id IN (SELECT id FROM messages WHERE id = ? OR reaction_to = ?)",
        [id, id],
      );
      this.db.exec("DELETE FROM outbox WHERE message_id = ?", [id]);
      this.db.exec(
        `UPDATE messages SET deleted_at = ?, body = '', attachment_hint = NULL,
           origin = ?, updated_at = ?, change_seq = ?
         WHERE (id = ? OR reaction_to = ?) AND deleted_at IS NULL`,
        [this.#now(), s.origin, s.updatedAt, s.changeSeq, id, id],
      );
      this.#refreshActivity(row.thread_key);
      return true;
    });
  }

  /** Messages waiting for a desktop notification on this computer, oldest first. */
  pendingNotifications(): Message[] {
    const rows = this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS.replace(/(^|,\s*)/g, "$1m.")} FROM unnotified u
       JOIN messages m ON m.id = u.message_id
       WHERE m.deleted_at IS NULL
       ORDER BY m.sort_at, m.rowid`,
    );
    return this.#messages(rows);
  }

  /** Records that the message was shown (or deliberately not) as a notification. Local only. */
  markNotified(id: string): void {
    this.db.exec("DELETE FROM unnotified WHERE message_id = ?", [id]);
  }

  // --- Groups --------------------------------------------------------------

  getGroup(threadKey: string): Group | null {
    const row = this.db.query<GroupRow>(
      "SELECT * FROM groups WHERE thread_key = ? AND deleted_at IS NULL",
      [threadKey],
    )[0];
    return row ? toGroup(row) : null;
  }

  /** Every group conversation's key, for finding one by its title. */
  groupThreadKeys(): string[] {
    return this.db
      .query<{ key: string }>(
        "SELECT key FROM threads WHERE kind = 'group' AND deleted_at IS NULL AND hidden = 0",
      )
      .map((row) => row.key);
  }

  listGroups(): Group[] {
    return this.db
      .query<GroupRow>(
        `SELECT g.* FROM groups g JOIN threads t ON t.key = g.thread_key
         WHERE g.deleted_at IS NULL AND t.deleted_at IS NULL
         ORDER BY t.last_message_at IS NULL, t.last_message_at DESC, g.thread_key`,
      )
      .map(toGroup);
  }

  /**
   * Creates a group's thread and group, or updates its name and members. Keeps a saved roster.
   * Returns whether anything changed.
   */
  recordGroup(
    threadKey: string,
    info: { named: boolean; name: string | null; participants: readonly string[] },
  ): boolean {
    if (!threadKey.startsWith("group:")) {
      throw new TincanError("INVALID_INPUT", "Not a group thread key");
    }
    return this.#write(() => {
      let changed = this.ensureThread(threadKey, "group");
      const participants = JSON.stringify([...info.participants]);
      const row = this.db.query<GroupRow & { deleted_at: number | null }>(
        "SELECT * FROM groups WHERE thread_key = ?",
        [threadKey],
      )[0];
      const live = row && row.deleted_at === null;
      if (
        live &&
        row.name === info.name &&
        row.named === (info.named ? 1 : 0) &&
        row.participants === participants
      ) {
        return changed;
      }
      const s = this.#stamp();
      this.db.exec(
        `INSERT INTO groups (thread_key, name, named, participants, origin, updated_at, change_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_key) DO UPDATE SET name = excluded.name, named = excluded.named,
           participants = excluded.participants, origin = excluded.origin,
           updated_at = excluded.updated_at, change_seq = excluded.change_seq,
           roster = CASE WHEN groups.deleted_at IS NULL THEN groups.roster END,
           route_invalidated = CASE WHEN groups.deleted_at IS NULL THEN groups.route_invalidated ELSE 0 END,
           deleted_at = NULL`,
        [
          threadKey,
          info.name,
          info.named ? 1 : 0,
          participants,
          s.origin,
          s.updatedAt,
          s.changeSeq,
        ],
      );
      changed = true;
      return changed;
    });
  }

  /**
   * Saves the group's members as the user confirmed them (null forgets them), makes them the
   * thread's members and clears a route warning. Creates the group if Tincan hasn't seen it.
   */
  setGroupRoster(threadKey: string, roster: readonly string[] | null): Group {
    const handles = roster === null ? null : [...new Set(roster)];
    if (handles && !handles.every(isRosterHandle)) {
      throw new TincanError("INVALID_INPUT", "Roster entries must be tel: or email: handles");
    }
    return this.#write(() => {
      if (!this.getGroup(threadKey)) {
        this.recordGroup(threadKey, {
          named: threadKey.startsWith("group:name:"),
          name: null,
          participants: [],
        });
      }
      const s = this.#stamp();
      this.db.exec(
        `UPDATE groups SET roster = ?, route_invalidated = 0, origin = ?, updated_at = ?,
           change_seq = ?
         WHERE thread_key = ?`,
        [handles && JSON.stringify(handles), s.origin, s.updatedAt, s.changeSeq, threadKey],
      );
      if (handles) this.setThreadMembers(threadKey, handles);
      return this.getGroup(threadKey)!;
    });
  }

  /**
   * Notes that `sender` wrote in the group: adds them to its members, and flags the group when it
   * has a roster they aren't on, since replies may no longer reach everyone. Returns whether it
   * flagged it.
   */
  noteGroupSender(threadKey: string, sender: string): boolean {
    return this.#write(() => {
      const group = this.getGroup(threadKey);
      if (!group) return false;
      const known = this.db.query(
        "SELECT 1 FROM thread_members WHERE thread_key = ? AND handle = ? AND deleted_at IS NULL",
        [threadKey, sender],
      );
      if (known.length === 0) this.#addMember(threadKey, sender, this.#stamp());
      if (!group.roster || group.roster.includes(sender) || group.routeInvalidated) return false;
      const s = this.#stamp();
      this.db.exec(
        `UPDATE groups SET route_invalidated = 1, origin = ?, updated_at = ?, change_seq = ?
         WHERE thread_key = ?`,
        [s.origin, s.updatedAt, s.changeSeq, threadKey],
      );
      return true;
    });
  }

  /** Forgets the group's name and roster. Its thread and messages stay. */
  deleteGroup(threadKey: string): boolean {
    return this.#write(() => {
      if (!this.getGroup(threadKey)) return false;
      const s = this.#stamp();
      this.db.exec(
        `UPDATE groups SET deleted_at = ?, origin = ?, updated_at = ?, change_seq = ?
         WHERE thread_key = ?`,
        [this.#now(), s.origin, s.updatedAt, s.changeSeq, threadKey],
      );
      return true;
    });
  }

  // --- Contacts ------------------------------------------------------------

  /**
   * Mirrors the phone's address book: adds and updates `contacts`, and tombstones contacts and
   * handles it no longer has. Rows that didn't change keep their clocks. Photos are left alone,
   * except that ones only removed contacts used are forgotten.
   */
  replaceContacts(contacts: readonly ContactInput[]): ContactsReplaced {
    return this.#write(() => {
      const existing = new Map(
        this.db
          .query<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM contacts`)
          .map((row) => [row.id, row]),
      );
      const handlesOf = new Map<string, HandleRow[]>();
      for (const row of this.db.query<HandleRow>(
        "SELECT contact_id, handle, label, deleted_at FROM handles",
      )) {
        const list = handlesOf.get(row.contact_id) ?? [];
        list.push(row);
        handlesOf.set(row.contact_id, list);
      }
      const changed = new Set<string>();
      const removed: string[] = [];
      const touched = new Set<string>();
      const seen = new Set<string>();
      const now = this.#now();

      for (const contact of contacts) {
        if (seen.has(contact.id)) continue;
        seen.add(contact.id);
        const row = existing.get(contact.id);
        const favorite = contact.favorite ? 1 : 0;
        const details = detailsJson(contact.details);
        if (!row) {
          const st = this.#stamp();
          this.db.exec(
            `INSERT INTO contacts (id, name, favorite, details, origin, updated_at, change_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [contact.id, contact.name, favorite, details, st.origin, st.updatedAt, st.changeSeq],
          );
          changed.add(contact.id);
        } else if (
          row.deleted_at !== null ||
          row.name !== contact.name ||
          row.favorite !== favorite ||
          row.details !== details
        ) {
          const st = this.#stamp();
          this.db.exec(
            `UPDATE contacts SET name = ?, favorite = ?, details = ?, deleted_at = NULL,
               origin = ?, updated_at = ?, change_seq = ?
             WHERE id = ?`,
            [contact.name, favorite, details, st.origin, st.updatedAt, st.changeSeq, contact.id],
          );
          changed.add(contact.id);
        }

        const old = new Map((handlesOf.get(contact.id) ?? []).map((h) => [h.handle, h]));
        const wanted = new Map<string, string | null>();
        for (const h of contact.handles) if (!wanted.has(h.handle)) wanted.set(h.handle, h.label);
        for (const [handle, label] of wanted) {
          const prev = old.get(handle);
          if (prev && prev.deleted_at === null && prev.label === label) continue;
          const st = this.#stamp();
          this.db.exec(
            `INSERT INTO handles (contact_id, handle, label, origin, updated_at, change_seq)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (contact_id, handle) DO UPDATE SET label = excluded.label,
               deleted_at = NULL, origin = excluded.origin, updated_at = excluded.updated_at,
               change_seq = excluded.change_seq`,
            [contact.id, handle, label, st.origin, st.updatedAt, st.changeSeq],
          );
          changed.add(contact.id);
          touched.add(handle);
        }
        for (const prev of old.values()) {
          if (prev.deleted_at !== null || wanted.has(prev.handle)) continue;
          this.#tombstoneHandle(contact.id, prev.handle, now);
          changed.add(contact.id);
          touched.add(prev.handle);
        }
        if (changed.has(contact.id)) for (const handle of wanted.keys()) touched.add(handle);
      }

      for (const row of existing.values()) {
        if (row.deleted_at !== null || seen.has(row.id)) continue;
        const st = this.#stamp();
        this.db.exec(
          `UPDATE contacts SET deleted_at = ?, origin = ?, updated_at = ?, change_seq = ?
           WHERE id = ?`,
          [now, st.origin, st.updatedAt, st.changeSeq, row.id],
        );
        for (const h of handlesOf.get(row.id) ?? []) {
          if (h.deleted_at !== null) continue;
          this.#tombstoneHandle(row.id, h.handle, now);
          touched.add(h.handle);
        }
        removed.push(row.id);
      }
      // Last, so hidden people follow the cards as they are now (and fail closed: nothing that
      // was hidden is shown).
      for (const handle of this.#reconcileHidden()) touched.add(handle);
      // Photos only removed contacts used go with them.
      this.pruneContactPhotos();
      return { changed: [...changed], removed, handles: [...touched] };
    });
  }

  /**
   * Keeps a photo's bytes under `name` (`<sha256>.<ext>`, as `contacts.photo_path` names it). A
   * photo already kept is left alone, so an unchanged one writes nothing. True if it was added.
   */
  putContactPhoto(name: string, mediaType: string, data: Uint8Array): boolean {
    return this.#write(
      () =>
        this.db.exec(
          "INSERT OR IGNORE INTO contact_photos (name, media_type, data) VALUES (?, ?, ?)",
          [name, mediaType, data],
        ).changes > 0,
    );
  }

  /** Whether a photo's bytes are kept under `name`. */
  hasContactPhoto(name: string): boolean {
    return this.db.query("SELECT 1 FROM contact_photos WHERE name = ?", [name]).length > 0;
  }

  /** Forgets photos no live contact uses. Returns how many went. */
  pruneContactPhotos(): number {
    return this.#write(
      () =>
        this.db.exec(
          `DELETE FROM contact_photos WHERE name NOT IN (
             SELECT photo_path FROM contacts WHERE photo_path IS NOT NULL AND deleted_at IS NULL)`,
        ).changes,
    );
  }

  /** A live contact's photo, if its bytes are here. */
  getContactPhoto(contactId: string): { mediaType: string; data: Uint8Array } | null {
    const row = this.db.query<{ media_type: string; data: Uint8Array }>(
      `SELECT p.media_type, p.data FROM contacts c JOIN contact_photos p ON p.name = c.photo_path
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      [contactId],
    )[0];
    return row ? { mediaType: row.media_type, data: row.data } : null;
  }

  /** Sets a contact's photo (a name in `contact_photos`), or clears it. */
  setContactPhoto(id: string, photoPath: string | null): boolean {
    return this.#write(() => {
      const row = this.db.query<{ photo_path: string | null }>(
        "SELECT photo_path FROM contacts WHERE id = ? AND deleted_at IS NULL",
        [id],
      )[0];
      if (!row || row.photo_path === photoPath) return false;
      const st = this.#stamp();
      this.db.exec(
        `UPDATE contacts SET photo_path = ?, origin = ?, updated_at = ?, change_seq = ?
         WHERE id = ?`,
        [photoPath, st.origin, st.updatedAt, st.changeSeq, id],
      );
      return true;
    });
  }

  /** The name of a contact's photo, or null. */
  contactPhoto(id: string): string | null {
    return (
      this.db.query<{ photo_path: string | null }>(
        "SELECT photo_path FROM contacts WHERE id = ? AND deleted_at IS NULL",
        [id],
      )[0]?.photo_path ?? null
    );
  }

  /** Every photo name a live contact uses. */
  contactPhotos(): Set<string> {
    return new Set(
      this.db
        .query<{ photo_path: string }>(
          "SELECT DISTINCT photo_path FROM contacts WHERE photo_path IS NOT NULL AND deleted_at IS NULL",
        )
        .map((row) => row.photo_path),
    );
  }

  /** How much Tincan keeps: live conversations, messages (tapbacks included) and contacts. */
  counts(): { threads: number; messages: number; contacts: number } {
    const count = (table: string) =>
      this.db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL`)[0]
        ?.n ?? 0;
    return { threads: count("threads"), messages: count("messages"), contacts: count("contacts") };
  }

  getContact(id: string, options: { excludeAgentHidden?: boolean } = {}): Contact | null {
    const rows = this.db.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE id = ? AND deleted_at IS NULL
       ${options.excludeAgentHidden ? `AND NOT ${contactHiddenSql("c.id")}` : ""}`,
      [id],
    );
    return this.#contacts(rows)[0] ?? null;
  }

  /**
   * Whether a contact is hidden from AI agents: a hidden person is linked to it, or one of its
   * numbers or emails is hidden.
   */
  isContactHiddenFromAgents(id: string): boolean {
    return (
      this.db.query(`SELECT 1 FROM (SELECT ? AS k) q WHERE ${contactHiddenSql("q.k")}`, [id])
        .length > 0
    );
  }

  /** Contacts by name, favourites first. */
  listContacts(options: ContactListOptions = {}): Contact[] {
    const rows = this.db.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts c
       WHERE deleted_at IS NULL ${options.favoritesOnly ? "AND favorite = 1" : ""}
       ${options.excludeAgentHidden ? `AND NOT ${contactHiddenSql("c.id")}` : ""}
       ORDER BY favorite DESC, name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
      [clampLimit(options.limit), Math.max(0, Math.trunc(options.offset ?? 0))],
    );
    return this.#contacts(rows);
  }

  /**
   * Contacts whose name contains every word of `query`, or (unless `nameOnly`) with a handle that
   * contains it (digits alone match phone numbers however they're written). With `nameOnly`, words
   * with digits or `@` are ignored, so a number or address written into a name can't be probed.
   */
  searchContacts(
    query: string,
    options: { limit?: number; nameOnly?: boolean; excludeAgentHidden?: boolean } = {},
  ): Contact[] {
    const words = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !options.nameOnly || !/[\p{N}@]/u.test(w));
    if (words.length === 0) return [];
    const nameMatch = words.map(() => "lower(c.name) LIKE ? ESCAPE '\\'").join(" AND ");
    const visible = options.excludeAgentHidden ? `AND NOT ${contactHiddenSql("c.id")}` : "";
    const params: SqlParam[] = words.map((w) => `%${likeEscape(w)}%`);
    if (options.nameOnly) {
      const rows = this.db.query<ContactRow>(
        `SELECT ${CONTACT_COLUMNS.replace(/(^|,\s*)/g, "$1c.")} FROM contacts c
         WHERE c.deleted_at IS NULL AND (${nameMatch}) ${visible}
         ORDER BY c.favorite DESC, c.name COLLATE NOCASE, c.id LIMIT ?`,
        [...params, clampLimit(options.limit)],
      );
      return this.#contacts(rows);
    }
    const handleTerms = ["lower(h.handle) LIKE ? ESCAPE '\\'"];
    params.push(`%${likeEscape(query.trim().toLowerCase())}%`);
    const digits = query.replace(/[\s\-().+]/g, "");
    if (/^[0-9]{3,}$/.test(digits)) {
      handleTerms.push("h.handle LIKE ?");
      params.push(`tel:%${digits}%`);
    }
    const rows = this.db.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS.replace(/(^|,\s*)/g, "$1c.")} FROM contacts c
       WHERE c.deleted_at IS NULL AND ((${nameMatch}) OR EXISTS (
         SELECT 1 FROM handles h WHERE h.contact_id = c.id AND h.deleted_at IS NULL
           AND (${handleTerms.join(" OR ")}))) ${visible}
       ORDER BY c.favorite DESC, c.name COLLATE NOCASE, c.id LIMIT ?`,
      [...params, clampLimit(options.limit)],
    );
    return this.#contacts(rows);
  }

  /** The contact a handle belongs to (a favourite first, if several have it). */
  contactForHandle(handle: string): Contact | null {
    const rows = this.db.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS.replace(/(^|,\s*)/g, "$1c.")} FROM handles h
       JOIN contacts c ON c.id = h.contact_id
       WHERE h.handle = ? AND h.deleted_at IS NULL AND c.deleted_at IS NULL
       ORDER BY c.favorite DESC, c.name LIMIT 1`,
      [handle],
    );
    return this.#contacts(rows)[0] ?? null;
  }

  /** The keys among `keys` that are live threads. */
  liveThreadKeys(keys: readonly string[]): string[] {
    const live = new Set(
      this.db
        .query<{ key: string }>("SELECT key FROM threads WHERE deleted_at IS NULL")
        .map((row) => row.key),
    );
    return [...new Set(keys)].filter((key) => live.has(key));
  }

  #tombstoneHandle(contactId: string, handle: string, now: number): void {
    const st = this.#stamp();
    this.db.exec(
      `UPDATE handles SET deleted_at = ?, origin = ?, updated_at = ?, change_seq = ?
       WHERE contact_id = ? AND handle = ?`,
      [now, st.origin, st.updatedAt, st.changeSeq, contactId, handle],
    );
  }

  #contacts(rows: ContactRow[]): Contact[] {
    return rows.map((row) => {
      const handles = this.db.query<{ handle: string; label: string | null }>(
        "SELECT handle, label FROM handles WHERE contact_id = ? AND deleted_at IS NULL ORDER BY handle",
        [row.id],
      );
      const hidden = this.isContactHiddenFromAgents(row.id);
      const labels: Record<string, string> = {};
      for (const h of handles) if (h.label) labels[h.handle] = h.label;
      const details = parseDetails(row.details);
      return {
        id: row.id,
        name: row.name,
        handles: handles.map((h) => h.handle),
        hasPhoto: row.photo_path !== null,
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
        ...(details ? { details } : {}),
        ...(hidden ? { hiddenFromAgents: true } : {}),
      };
    });
  }

  // --- Hidden from agents (local) ------------------------------------------

  /** The hidden person a handle belongs to, if any. */
  hiddenPersonForHandle(handle: string): HiddenPerson | null {
    const row = this.db.query<{ person_id: string }>(
      "SELECT person_id FROM agent_hidden_handles WHERE handle = ?",
      [handle],
    )[0];
    return row ? this.getHiddenPerson(row.person_id) : null;
  }

  getHiddenPerson(id: string): HiddenPerson | null {
    return this.#hiddenPeople("WHERE p.id = ?", [id])[0] ?? null;
  }

  /** Everyone hidden from agents, by label. */
  listHiddenPeople(): HiddenPerson[] {
    return this.#hiddenPeople("ORDER BY p.label COLLATE NOCASE, p.id", []);
  }

  /** Live group conversations the user hid from agents themselves, by title. */
  listHiddenGroups(): HiddenGroup[] {
    return this.db
      .query<{ key: string }>(
        "SELECT key FROM threads WHERE kind = 'group' AND agent_hidden = 1 AND deleted_at IS NULL",
      )
      .map((row) => this.getThread(row.key))
      .filter((thread): thread is Thread => thread !== null)
      .map((thread) => ({ threadKey: thread.key, title: thread.title }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Hides a contact from agents with every number and email it has (and any other card sharing
   * one of them): it joins the hidden person who already has one of them, else a new one. Null
   * when there's no such contact.
   */
  hideContact(contactId: string): HiddenChange | null {
    return this.#write(() => {
      const contact = this.getContact(contactId);
      if (!contact) return null;
      const result = this.#absorb(contact.handles, { id: contact.id, label: contact.name });
      const reconciled = this.#reconcileHidden();
      return this.#hiddenChange(result.personId, result.changed, [...result.added, ...reconciled]);
    });
  }

  /**
   * Hides a raw number or email address (or sender) from agents, conversation or not. One a live
   * contact has hides that contact (all of it) instead.
   */
  hideHandle(handle: string, label: string): HiddenChange {
    return this.#write(() => {
      const contact = this.contactForHandle(handle);
      if (contact) {
        const result = this.#absorb([handle, ...contact.handles], {
          id: contact.id,
          label: contact.name,
        });
        const reconciled = this.#reconcileHidden();
        return this.#hiddenChange(result.personId, result.changed, [
          ...result.added,
          ...reconciled,
        ]);
      }
      const result = this.#absorb([handle], null, label);
      return this.#hiddenChange(result.personId, result.changed, result.added);
    });
  }

  /** Shows a hidden person to agents again, with all their handles. Returns the handles shown. */
  showPerson(id: string): string[] | null {
    return this.#write(() => {
      const person = this.getHiddenPerson(id);
      if (!person) return null;
      this.db.exec("DELETE FROM agent_hidden_handles WHERE person_id = ?", [id]);
      this.db.exec("DELETE FROM agent_hidden_people WHERE id = ?", [id]);
      return person.handles;
    });
  }

  /** Live threads that have any of `handles` as their key, a member or on their roster. */
  threadsWithHandles(handles: readonly string[]): string[] {
    if (handles.length === 0) return [];
    const list = handles.map(() => "?").join(", ");
    return this.db
      .query<{ key: string }>(
        `SELECT t.key FROM threads t WHERE t.deleted_at IS NULL AND (t.key IN (${list})
           OR EXISTS (SELECT 1 FROM thread_members m WHERE m.thread_key = t.key
             AND m.deleted_at IS NULL AND m.handle IN (${list}))
           OR EXISTS (SELECT 1 FROM groups g, json_each(${rosterJson("g.roster")}) r
             WHERE g.thread_key = t.key AND g.deleted_at IS NULL AND r.value IN (${list})))`,
        [...handles, ...handles, ...handles],
      )
      .map((row) => row.key);
  }

  /** Live contacts that have any of `handles`. */
  contactsWithHandles(handles: readonly string[]): string[] {
    if (handles.length === 0) return [];
    return this.db
      .query<{ id: string }>(
        `SELECT DISTINCT c.id FROM handles h JOIN contacts c ON c.id = h.contact_id
         WHERE h.deleted_at IS NULL AND c.deleted_at IS NULL
           AND h.handle IN (${handles.map(() => "?").join(", ")})`,
        [...handles],
      )
      .map((row) => row.id);
  }

  #hiddenChange(personId: string, changed: boolean, added: string[]): HiddenChange {
    return {
      person: this.getHiddenPerson(personId)!,
      changed: changed || added.length > 0,
      added: [...new Set(added)],
    };
  }

  /**
   * Adds `handles` to the hidden person who has one of them (merging several into the oldest), or
   * to a new one. With `contact`, the person follows that card. Returns the handles it added.
   */
  #absorb(
    handles: readonly string[],
    contact: { id: string; label: string } | null,
    label?: string,
  ): { personId: string; changed: boolean; added: string[] } {
    const wanted = [...new Set(handles)];
    const people =
      wanted.length === 0
        ? []
        : this.db
            .query<{ id: string }>(
              `SELECT DISTINCT p.id, p.created_at FROM agent_hidden_handles ah
               JOIN agent_hidden_people p ON p.id = ah.person_id
               WHERE ah.handle IN (${wanted.map(() => "?").join(", ")})
               ORDER BY p.created_at, p.id`,
              wanted,
            )
            .map((row) => row.id);
    if (contact) {
      // Linked to the card already, by an earlier version of it that shares no handle now.
      const linked = this.db.query<{ id: string }>(
        "SELECT id FROM agent_hidden_people WHERE contact_id = ? ORDER BY created_at, id",
        [contact.id],
      );
      for (const row of linked) if (!people.includes(row.id)) people.push(row.id);
    }
    let changed = false;
    let personId = people[0];
    if (personId === undefined) {
      personId = uuidv7(this.#now());
      this.db.exec(
        "INSERT INTO agent_hidden_people (id, contact_id, label, created_at) VALUES (?, ?, ?, ?)",
        [personId, contact?.id ?? null, contact?.label ?? label ?? wanted[0] ?? "", this.#now()],
      );
      changed = true;
    } else {
      for (const other of people.slice(1)) {
        this.db.exec("UPDATE agent_hidden_handles SET person_id = ? WHERE person_id = ?", [
          personId,
          other,
        ]);
        this.db.exec("DELETE FROM agent_hidden_people WHERE id = ?", [other]);
        changed = true;
      }
      if (contact) {
        changed =
          this.db.exec(
            `UPDATE agent_hidden_people SET contact_id = ?, label = ?
             WHERE id = ? AND (contact_id IS NOT ? OR label <> ?)`,
            [contact.id, contact.label, personId, contact.id, contact.label],
          ).changes > 0 || changed;
      }
    }
    const added: string[] = [];
    for (const handle of wanted) {
      const inserted = this.db.exec(
        `INSERT INTO agent_hidden_handles (handle, person_id, source) VALUES (?, ?, ?)
         ON CONFLICT (handle) DO NOTHING`,
        [handle, personId, contact ? "contact" : "manual"],
      ).changes;
      if (inserted > 0) added.push(handle);
    }
    return { personId, changed, added };
  }

  /**
   * Brings hidden people in line with the contacts: a live card that shares a number or email
   * with a hidden person joins them, with all its handles (several people it joins merge); a
   * person whose card is gone keeps its label and handles, unlinked. Nothing is ever unhidden.
   * Returns the handles it hid.
   */
  #reconcileHidden(): string[] {
    const added: string[] = [];
    const done = new Set<string>();
    // Joining one card can hide a handle another card has: repeat until nothing new joins.
    for (;;) {
      const cards = this.db
        .query<{ id: string; name: string }>(
          `SELECT DISTINCT c.id, c.name, c.favorite FROM contacts c
           WHERE c.deleted_at IS NULL AND (EXISTS (
             SELECT 1 FROM handles h JOIN agent_hidden_handles ah ON ah.handle = h.handle
             WHERE h.contact_id = c.id AND h.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM agent_hidden_people p WHERE p.contact_id = c.id))
           ORDER BY c.favorite, c.name COLLATE NOCASE DESC, c.id DESC`,
        )
        .filter((card) => !done.has(card.id));
      if (cards.length === 0) break;
      for (const card of cards) {
        done.add(card.id);
        const handles = this.db
          .query<{ handle: string }>(
            "SELECT handle FROM handles WHERE contact_id = ? AND deleted_at IS NULL",
            [card.id],
          )
          .map((row) => row.handle);
        added.push(...this.#absorb(handles, { id: card.id, label: card.name }).added);
      }
    }
    // Cards that are gone: their people stay hidden, unlinked.
    this.db.exec(
      `UPDATE agent_hidden_people SET contact_id = NULL
       WHERE contact_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.id = agent_hidden_people.contact_id AND c.deleted_at IS NULL)`,
    );
    return added;
  }

  #hiddenPeople(rest: string, params: SqlParam[]): HiddenPerson[] {
    const rows = this.db.query<{
      id: string;
      contact_id: string | null;
      label: string;
      created_at: number;
    }>(
      `SELECT p.id, CASE WHEN EXISTS (SELECT 1 FROM contacts c WHERE c.id = p.contact_id
           AND c.deleted_at IS NULL) THEN p.contact_id END AS contact_id, p.label, p.created_at
       FROM agent_hidden_people p ${rest}`,
      params,
    );
    return rows.map((row) => {
      const handles = this.db.query<{ handle: string; source: string }>(
        "SELECT handle, source FROM agent_hidden_handles WHERE person_id = ? ORDER BY handle",
        [row.id],
      );
      return {
        id: row.id,
        label: row.label,
        contactId: row.contact_id,
        contactRemoved: row.contact_id === null && handles.some((h) => h.source === "contact"),
        handles: handles.map((h) => h.handle),
        createdAt: row.created_at,
      };
    });
  }

  // --- Sync bookkeeping (local) --------------------------------------------

  /**
   * What the store knows about a MAP handle, deleted messages included: a handle Tincan has seen
   * never needs fetching again.
   */
  mapHandleState(device: string, mapHandle: string): MapHandleState | null {
    const row = this.#messageRow("device = ? AND map_handle = ?", [
      device.toUpperCase(),
      mapHandle,
    ]);
    return row
      ? {
          id: row.id,
          threadKey: row.thread_key,
          read: row.read === 1,
          deleted: row.deleted_at !== null,
        }
      : null;
  }

  /** The newest phone time among the device's stored messages, or null if it has none. */
  lastMessageAt(device: string): number | null {
    const row = this.db.query<{ at: number | null }>(
      "SELECT max(sort_at) AS at FROM messages WHERE device = ? AND deleted_at IS NULL",
      [device.toUpperCase()],
    )[0];
    return row?.at ?? null;
  }

  getSyncState(device: string, folder: string): SyncState | null {
    const row = this.db.query<{ last_sync_at: number | null; last_listing: string }>(
      "SELECT last_sync_at, last_listing FROM sync_state WHERE device = ? AND folder = ?",
      [device.toUpperCase(), folder],
    )[0];
    if (!row) return null;
    const listing: unknown = JSON.parse(row.last_listing);
    return {
      lastSyncAt: row.last_sync_at,
      lastListing:
        listing && typeof listing === "object" && !Array.isArray(listing)
          ? (listing as Record<string, boolean>)
          : {},
    };
  }

  setSyncState(device: string, folder: string, state: SyncState): void {
    this.db.exec(
      `INSERT INTO sync_state (device, folder, last_sync_at, last_listing) VALUES (?, ?, ?, ?)
       ON CONFLICT (device, folder) DO UPDATE SET last_sync_at = excluded.last_sync_at,
         last_listing = excluded.last_listing`,
      [device.toUpperCase(), folder, state.lastSyncAt, JSON.stringify(state.lastListing)],
    );
  }

  /** Records a stretch of time whose messages may be missing. Returns its id. */
  recordGap(gap: {
    device: string;
    threadKey: string | null;
    fromAt: number;
    toAt: number;
  }): number {
    return this.db.exec(
      "INSERT INTO gaps (device, thread_key, from_at, to_at, detected_at) VALUES (?, ?, ?, ?, ?)",
      [gap.device.toUpperCase(), gap.threadKey, gap.fromAt, gap.toAt, this.#now()],
    ).lastInsertRowid;
  }

  /** Unresolved gaps, oldest first: those for `threadKey` and those for every thread. */
  openGaps(threadKey?: string): Gap[] {
    const rows = this.db.query<{
      id: number;
      device: string;
      thread_key: string | null;
      from_at: number;
      to_at: number;
      detected_at: number;
    }>(
      `SELECT id, device, thread_key, from_at, to_at, detected_at FROM gaps
       WHERE resolved_at IS NULL ${threadKey === undefined ? "" : "AND (thread_key = ? OR thread_key IS NULL)"}
       ORDER BY from_at, id`,
      threadKey === undefined ? [] : [threadKey],
    );
    return rows.map((r) => ({
      id: r.id,
      device: r.device,
      threadKey: r.thread_key,
      fromAt: r.from_at,
      toAt: r.to_at,
      detectedAt: r.detected_at,
    }));
  }

  resolveGap(id: number): boolean {
    return (
      this.db.exec("UPDATE gaps SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL", [
        this.#now(),
        id,
      ]).changes > 0
    );
  }

  /** Appends to the connection log, keeping only the newest {@link CONNECTION_LOG_LIMIT} entries. */
  logConnection(event: ConnectionEvent): void {
    this.db.transaction(() => {
      this.db.exec(
        "INSERT INTO connection_log (at, kind, state, address, code) VALUES (?, ?, ?, ?, ?)",
        [event.at, event.kind, event.state, event.address, event.code],
      );
      this.db.exec(
        `DELETE FROM connection_log WHERE id <= (
           SELECT id FROM connection_log ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [CONNECTION_LOG_LIMIT],
      );
    });
  }

  /** The newest `limit` connection log entries, oldest first. */
  connectionLog(limit: number = CONNECTION_LOG_LIMIT): ConnectionEvent[] {
    const rows = this.db.query<{
      at: number;
      kind: ConnectionEvent["kind"];
      state: string;
      address: string | null;
      code: string | null;
    }>(
      `SELECT at, kind, state, address, code FROM (
         SELECT id, at, kind, state, address, code FROM connection_log ORDER BY id DESC LIMIT ?)
       ORDER BY id`,
      [limit],
    );
    return rows.map((r) => ({
      at: r.at,
      kind: r.kind,
      state: r.state,
      address: r.address,
      code: r.code,
    }));
  }

  #messageRow(where: string, params: SqlParam[]): MessageRow | undefined {
    return this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where} LIMIT 1`,
      params,
    )[0];
  }

  #existing(row: MessageRow): InsertResult {
    return { message: row.deleted_at === null ? this.getMessage(row.id) : null, inserted: false };
  }

  /** The stable id, counting identical messages already stored to tell them apart. */
  #phoneId(input: NewMessage, device: string | null, phoneTime: number): string {
    const identity = { ...input, device, phoneTime };
    for (let occurrence = 0; ; occurrence++) {
      const id = phoneMessageId(identity, occurrence);
      if (this.db.query("SELECT 1 FROM messages WHERE id = ?", [id]).length === 0) return id;
    }
  }

  #setMessageField(
    id: string,
    column: "status" | "read" | "thread_key" | "reaction_to" | "reaction_kind",
    value: SqlParam,
  ): boolean {
    return this.#write(() => {
      const s = this.#stamp();
      return (
        this.db.exec(
          `UPDATE messages SET ${column} = ?, origin = ?, updated_at = ?, change_seq = ?
           WHERE id = ? AND deleted_at IS NULL`,
          [value, s.origin, s.updatedAt, s.changeSeq, id],
        ).changes > 0
      );
    });
  }

  #messages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const reactionRows = this.db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE reaction_to IN (${ids.map(() => "?").join(", ")}) AND deleted_at IS NULL
       ORDER BY sort_at, rowid`,
      ids,
    );
    const reactions = new Map<string, Reaction[]>();
    for (const r of reactionRows) {
      const list = reactions.get(r.reaction_to!) ?? [];
      list.push({ kind: r.reaction_kind ?? "other", from: r.sender, text: r.body });
      reactions.set(r.reaction_to!, list);
    }
    // The outbox has when a scheduled message goes and why a failed one didn't.
    const queued = rows
      .filter((r) => r.status === "scheduled" || r.status === "failed")
      .map((r) => r.id);
    const sendAts = new Map<string, number>();
    const failures = new Map<string, SendFailureCode>();
    if (queued.length > 0) {
      for (const row of this.db.query<{
        message_id: string;
        send_at: number | null;
        last_error: string | null;
      }>(
        `SELECT message_id, send_at, last_error FROM outbox WHERE message_id IN (${queued.map(() => "?").join(", ")})`,
        queued,
      )) {
        if (row.send_at !== null) sendAts.set(row.message_id, row.send_at);
        if (row.last_error !== null) {
          const code = SendFailureCode.safeParse(row.last_error);
          failures.set(row.message_id, code.success ? code.data : "INTERNAL");
        }
      }
    }
    return rows.map((r) => {
      const message: Message = {
        id: r.id,
        threadKey: r.thread_key,
        direction: r.direction,
        sender: r.sender,
        body: r.body,
        sentAt: r.sent_at,
        sentAtIso: r.sent_at !== null ? formatLocalIso(r.sent_at) : null,
        receivedAt: r.received_at,
        receivedAtIso: formatLocalIso(r.received_at),
        source: r.source,
        status: r.status,
        read: r.read === 1,
        reactions: reactions.get(r.id) ?? [],
      };
      if (r.reaction_kind !== null) message.reaction = r.reaction_kind;
      if (r.reaction_to !== null) message.reactionTo = r.reaction_to;
      if (r.map_handle !== null) message.mapHandle = r.map_handle;
      if (r.attachment_hint !== null) message.attachmentHint = JSON.parse(r.attachment_hint);
      const sendAt = sendAts.get(r.id);
      if (sendAt !== undefined && r.status === "scheduled") message.sendAt = sendAt;
      const failure = failures.get(r.id);
      if (failure !== undefined && r.status === "failed") message.failure = { code: failure };
      if (r.sent_by_agent === 1 && r.direction === "outgoing") {
        message.agent = {
          name: r.agent_name ?? "An AI agent",
          edited: r.agent_edited === 1,
          via: r.agent_via === "user" ? "user" : "policy",
        };
      }
      return message;
    });
  }

  // --- Drafts (local) ------------------------------------------------------

  getDraft(threadKey: string): string | null {
    return this.draftInfo(threadKey)?.body ?? null;
  }

  /** The user's own saved draft. */
  draftInfo(threadKey: string): DraftInfo | null {
    const row = this.db.query<{ body: string; updated_at: number }>(
      "SELECT body, updated_at FROM drafts WHERE thread_key = ?",
      [threadKey],
    )[0];
    return row ? { body: row.body, updatedAt: row.updated_at } : null;
  }

  /**
   * The user's own drafts to recipients with no conversation listed yet (saved with
   * `message.draft.save` and `to`), newest first.
   */
  newRecipientDrafts(limit = 50): Array<{ to: string; text: string; updatedAt: number }> {
    return this.db
      .query<{ thread_key: string; body: string; updated_at: number }>(
        `SELECT d.thread_key, d.body, d.updated_at FROM drafts d
         WHERE d.body != ''
           AND (substr(d.thread_key, 1, 4) = 'tel:' OR substr(d.thread_key, 1, 6) = 'email:')
           AND NOT EXISTS (
           SELECT 1 FROM threads t
           WHERE t.key = d.thread_key AND t.deleted_at IS NULL AND t.hidden = 0
         )
         ORDER BY d.updated_at DESC, d.thread_key LIMIT ?`,
        [limit],
      )
      .map((r) => ({ to: r.thread_key, text: r.body, updatedAt: r.updated_at }));
  }

  /** Saves the user's own draft; an empty body deletes it. */
  saveDraft(threadKey: string, body: string): void {
    if (body === "") {
      this.db.exec("DELETE FROM drafts WHERE thread_key = ?", [threadKey]);
      return;
    }
    this.db.exec(
      `INSERT INTO drafts (thread_key, body, updated_at, by_agent, agent_name) VALUES (?, ?, ?, 0, NULL)
       ON CONFLICT (thread_key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      [threadKey, body, this.#now()],
    );
  }

  // --- Agent drafts (local) ------------------------------------------------

  /** Stores a new agent draft (`queued` unless given), at the back of its recipient's queue. */
  insertAgentDraft(input: NewAgentDraft): AgentDraft {
    const now = this.#now();
    const id = `drf_${uuidv7(now)}`;
    this.db.exec(
      `INSERT INTO agent_drafts (id, recipient, requested_as, agent_name, intent, body, text, state,
         note, created_at, updated_at, queue_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.to,
        input.requestedAs ?? null,
        input.agentName,
        input.intent,
        input.text,
        input.text,
        input.state ?? "queued",
        input.note ?? null,
        now,
        now,
        now,
      ],
    );
    return this.getAgentDraft(id)!;
  }

  getAgentDraft(id: string): AgentDraft | null {
    return this.#agentDrafts("WHERE d.id = ?", [id])[0] ?? null;
  }

  /** The agent draft a message was sent from. */
  agentDraftForMessage(messageId: string): AgentDraft | null {
    return (
      this.#agentDrafts("WHERE d.message_id = ? ORDER BY d.updated_at DESC LIMIT 1", [
        messageId,
      ])[0] ?? null
    );
  }

  /** Agent drafts, in queue order (oldest first). */
  listAgentDrafts(query: AgentDraftQuery = {}): AgentDraft[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (query.states && query.states.length > 0) {
      where.push(`d.state IN (${query.states.map(() => "?").join(", ")})`);
      params.push(...query.states);
    }
    if (query.to !== undefined) {
      where.push("d.recipient = ?");
      params.push(query.to);
    }
    if (query.agentName !== undefined) {
      where.push("d.agent_name = ?");
      params.push(query.agentName);
    }
    return this.#agentDrafts(
      `${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY d.queue_at, d.created_at, d.rowid LIMIT ?`,
      [...params, Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500)],
    );
  }

  /** How many agent drafts are queued, to a recipient or by an agent. */
  countQueuedAgentDrafts(query: { to?: string; agentName?: string }): number {
    const where = ["state = 'queued'"];
    const params: SqlParam[] = [];
    if (query.to !== undefined) {
      where.push("recipient = ?");
      params.push(query.to);
    }
    if (query.agentName !== undefined) {
      where.push("agent_name = ?");
      params.push(query.agentName);
    }
    return Number(
      this.db.query<{ n: number }>(
        `SELECT count(*) AS n FROM agent_drafts WHERE ${where.join(" AND ")}`,
        params,
      )[0]?.n ?? 0,
    );
  }

  /**
   * Changes a queued draft's text. `byAgent`: the agent rewrote its own untouched draft (its
   * original text changes too); otherwise it's the user's edit. Null when `revision` is stale or
   * the draft isn't queued.
   */
  setAgentDraftText(
    id: string,
    text: string,
    options: { revision?: number; byAgent?: boolean } = {},
  ): AgentDraft | null {
    const changed = this.db.exec(
      `UPDATE agent_drafts SET
         body = CASE WHEN ? THEN ? ELSE body END,
         text = ?,
         edited = CASE WHEN ? THEN 0 ELSE (? <> body) END,
         revision = revision + 1,
         updated_at = ?
       WHERE id = ? AND state = 'queued' AND (? IS NULL OR revision = ?)`,
      [
        options.byAgent === true,
        text,
        text,
        options.byAgent === true,
        text,
        this.#now(),
        id,
        options.revision ?? null,
        options.revision ?? null,
      ],
    ).changes;
    return changed > 0 ? this.getAgentDraft(id) : null;
  }

  /**
   * Moves an agent draft to `state`. `front` puts a requeued draft at the front of its queue.
   * Returns the draft, or null when it isn't in one of `from` (when given).
   */
  setAgentDraftState(
    id: string,
    state: AgentDraftState,
    options: {
      from?: readonly AgentDraftState[];
      messageId?: string | null;
      front?: boolean;
      /** Why it needs the user (null clears it). */
      note?: AgentDraftNote | null;
    } = {},
  ): AgentDraft | null {
    const now = this.#now();
    const terminal = state !== "queued" && state !== "scheduled";
    const from = options.from ?? [];
    const sets = ["state = ?", "updated_at = ?", "resolved_at = ?"];
    const params: SqlParam[] = [state, now, terminal ? now : null];
    if (options.messageId !== undefined) {
      sets.push("message_id = ?");
      params.push(options.messageId);
    }
    if (options.note !== undefined) {
      sets.push("note = ?");
      params.push(options.note);
    }
    if (options.front) {
      sets.push(
        `queue_at = COALESCE((SELECT min(q.queue_at) FROM agent_drafts q
           WHERE q.recipient = agent_drafts.recipient AND q.state = 'queued' AND q.id <> agent_drafts.id) - 1, queue_at)`,
      );
    }
    const changed = this.db.exec(
      `UPDATE agent_drafts SET ${sets.join(", ")} WHERE id = ?${
        from.length ? ` AND state IN (${from.map(() => "?").join(", ")})` : ""
      }`,
      [...params, id, ...from],
    ).changes;
    return changed > 0 ? this.getAgentDraft(id) : null;
  }

  /** Removes an agent draft entirely (a send that never got going). */
  deleteAgentDraft(id: string): void {
    this.db.exec("DELETE FROM agent_drafts WHERE id = ?", [id]);
  }

  #agentDrafts(rest: string, params: SqlParam[]): AgentDraft[] {
    const rows = this.db.query<AgentDraftRow>(
      `SELECT d.id, d.recipient, d.requested_as, d.agent_name, d.intent, d.body, d.text, d.edited,
         d.revision, d.state, d.message_id, d.note, d.created_at, d.updated_at, d.resolved_at,
         (SELECT t.key FROM threads t WHERE t.key = d.recipient AND t.deleted_at IS NULL) AS thread_key
       FROM agent_drafts d ${rest}`,
      params,
    );
    return rows.map((r) => {
      const draft: AgentDraft = {
        id: r.id,
        threadKey: r.thread_key,
        to: r.recipient,
        agentName: r.agent_name,
        intent: r.intent,
        body: r.body,
        text: r.text,
        edited: r.edited === 1,
        revision: r.revision,
        state: r.state,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        resolvedAt: r.resolved_at,
      };
      if (r.requested_as !== null) draft.requestedAs = r.requested_as;
      if (r.message_id !== null) draft.messageId = r.message_id;
      if (isDraftNote(r.note)) draft.note = r.note;
      return draft;
    });
  }

  // --- Outbox (local) ------------------------------------------------------

  /**
   * Stores an outgoing message with its outbox entry: `pending`, or with `sendAt` `scheduled`
   * (sorted at `sendAt`) until it's dispatched. With `agentDraftId` the draft is linked to it and
   * moves to `scheduled`.
   */
  queueOutgoing(input: {
    threadKey: string;
    body: string;
    recipients: string[];
    byAgent?: boolean;
    agent?: NewMessage["agent"];
    sendAt?: number | null;
    agentDraftId?: string | null;
  }): Message {
    return this.#write(() => {
      const now = this.#now();
      const sendAt = input.sendAt ?? null;
      const { message } = this.insertMessage({
        threadKey: input.threadKey,
        direction: "outgoing",
        sender: null,
        body: input.body,
        sentAt: sendAt ?? now,
        receivedAt: now,
        source: "local",
        status: sendAt === null ? "pending" : "scheduled",
        read: true,
        sentByAgent: input.byAgent === true || Boolean(input.agent),
        agent: input.agent ?? null,
      });
      this.db.exec(
        `INSERT INTO outbox (message_id, recipients, attempts, updated_at, send_at, agent_draft_id)
         VALUES (?, ?, 0, ?, ?, ?)`,
        [message!.id, JSON.stringify(input.recipients), now, sendAt, input.agentDraftId ?? null],
      );
      if (input.agentDraftId) {
        this.setAgentDraftState(input.agentDraftId, "scheduled", { messageId: message!.id });
      }
      return this.getMessage(message!.id)!;
    });
  }

  /**
   * A scheduled message's delay is over: it becomes `pending`, stamped with the time it really
   * goes (which also restarts the offline hold). False when it wasn't scheduled.
   */
  dispatchScheduled(messageId: string): boolean {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL AND status = 'scheduled'", [
        messageId,
      ]);
      if (!row) return false;
      const now = this.#now();
      const s = this.#stamp();
      this.db.exec(
        `UPDATE messages SET status = 'pending', sent_at = ?, sort_at = ?, origin = ?,
           updated_at = ?, change_seq = ?
         WHERE id = ?`,
        [now, now, s.origin, s.updatedAt, s.changeSeq, messageId],
      );
      this.db.exec("UPDATE outbox SET send_at = NULL, updated_at = ? WHERE message_id = ?", [
        now,
        messageId,
      ]);
      this.#refreshActivity(row.thread_key);
      return true;
    });
  }

  /**
   * Takes back a message that never reached the phone: one still `scheduled`, or `pending` with
   * no push running (waiting for the phone). It's deleted outright, outbox entry and all.
   * Returns what it was, `"busy"` when it's already going to the phone, or null when there's no
   * such outgoing message.
   */
  cancelOutgoing(
    messageId: string,
  ): { threadKey: string; body: string; agentDraftId: string | null } | "busy" | null {
    return this.#write(() => {
      const row = this.#messageRow("id = ? AND deleted_at IS NULL AND direction = 'outgoing'", [
        messageId,
      ]);
      const entry = this.outboxEntry(messageId);
      if (!row || !entry) return null;
      const cancellable =
        row.status === "scheduled" || (row.status === "pending" && entry.pushingSince === null);
      if (!cancellable) return "busy";
      this.db.exec("DELETE FROM unnotified WHERE message_id = ?", [messageId]);
      this.db.exec("DELETE FROM outbox WHERE message_id = ?", [messageId]);
      this.db.exec("DELETE FROM messages WHERE id = ? OR reaction_to = ?", [messageId, messageId]);
      this.#refreshActivity(row.thread_key);
      return { threadKey: row.thread_key, body: row.body, agentDraftId: entry.agentDraftId };
    });
  }

  outboxEntry(messageId: string): OutboxEntry | null {
    return this.#outbox("WHERE o.message_id = ?", [messageId])[0] ?? null;
  }

  /** Outbox entries whose message is in `status`, oldest first. */
  outboxEntries(status?: MessageStatus): OutboxEntry[] {
    return status === undefined
      ? this.#outbox("", [])
      : this.#outbox("WHERE m.status = ?", [status]);
  }

  /** Ids of a thread's messages still held for their send delay. */
  scheduledInThread(threadKey: string): string[] {
    return this.db
      .query<{ id: string }>(
        "SELECT id FROM messages WHERE thread_key = ? AND status = 'scheduled'",
        [threadKey],
      )
      .map((r) => r.id);
  }

  /** A push is starting: counts the attempt and clears the last error. */
  beginSendAttempt(messageId: string): void {
    this.db.exec(
      `UPDATE outbox SET attempts = attempts + 1, last_error = NULL, pushing_since = ?, updated_at = ?
       WHERE message_id = ?`,
      [this.#now(), this.#now(), messageId],
    );
  }

  /** Records how a send ended. A `sent` message leaves the outbox. */
  finishSendAttempt(messageId: string, status: MessageStatus, error: string | null = null): void {
    this.#write(() => {
      this.setMessageStatus(messageId, status);
      if (status === "sent") {
        this.db.exec("DELETE FROM outbox WHERE message_id = ?", [messageId]);
      } else {
        this.db.exec(
          "UPDATE outbox SET last_error = ?, pushing_since = NULL, send_at = NULL, updated_at = ? WHERE message_id = ?",
          [error, this.#now(), messageId],
        );
      }
    });
  }

  /** Puts a failed or unknown message back in the queue. */
  requeueOutgoing(messageId: string): void {
    this.#write(() => {
      this.setMessageStatus(messageId, "pending");
      this.db.exec(
        "UPDATE outbox SET last_error = NULL, pushing_since = NULL, updated_at = ? WHERE message_id = ?",
        [this.#now(), messageId],
      );
    });
  }

  #outbox(where: string, params: SqlParam[]): OutboxEntry[] {
    const rows = this.db.query<{
      message_id: string;
      recipients: string;
      attempts: number;
      last_error: string | null;
      pushing_since: number | null;
      updated_at: number;
      send_at: number | null;
      agent_draft_id: string | null;
    }>(
      `SELECT o.message_id, o.recipients, o.attempts, o.last_error, o.pushing_since, o.updated_at,
         o.send_at, o.agent_draft_id
       FROM outbox o
       JOIN messages m ON m.id = o.message_id AND m.deleted_at IS NULL
       ${where} ORDER BY m.sort_at, m.rowid`,
      params,
    );
    return rows.map((r) => ({
      messageId: r.message_id,
      recipients: JSON.parse(r.recipients) as string[],
      attempts: r.attempts,
      lastError: r.last_error,
      pushingSince: r.pushing_since,
      updatedAt: r.updated_at,
      sendAt: r.send_at,
      agentDraftId: r.agent_draft_id,
    }));
  }

  // --- Agent bookkeeping (local) ------------------------------------------

  /** How many `kind` actions agents took after `since`. */
  countAgentActions(kind: string, since: number): number {
    return Number(
      this.db.query<{ n: number }>(
        "SELECT count(*) AS n FROM agent_actions WHERE kind = ? AND at > ?",
        [kind, since],
      )[0]?.n ?? 0,
    );
  }

  /** Records an agent action, forgetting ones older than `keepAfter`. */
  recordAgentAction(kind: string, at: number, keepAfter: number): void {
    this.#write(() => {
      this.db.exec("DELETE FROM agent_actions WHERE kind = ? AND at <= ?", [kind, keepAfter]);
      this.db.exec("INSERT INTO agent_actions (kind, at) VALUES (?, ?)", [kind, at]);
    });
  }

  /** Remembers what an opaque agent ID stands for. */
  saveAgentToken(token: string, value: string): void {
    this.db.exec("INSERT OR IGNORE INTO agent_tokens (token, value) VALUES (?, ?)", [token, value]);
  }

  agentTokenValue(token: string): string | null {
    return (
      this.db.query<{ value: string }>("SELECT value FROM agent_tokens WHERE token = ?", [token])[0]
        ?.value ?? null
    );
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Provenance for a change about to be written. Call inside a write: the clock and sequence are
   * saved with it, so they stay monotonic across restarts.
   */
  #stamp(): Stamp {
    const updatedAt = this.#clock.now();
    this.#changeSeq += 1;
    this.setSetting(CLOCK_KEY, updatedAt);
    this.setSetting(CHANGE_SEQ_KEY, this.#changeSeq);
    return { origin: this.origin, updatedAt, changeSeq: this.#changeSeq };
  }

  /** Runs `body` in a transaction unless one is already open. */
  #write<T>(body: () => T): T {
    return this.db.inTransaction ? body() : this.db.transaction(body);
  }
}

function isDraftNote(value: string | null): value is AgentDraftNote {
  return value === "hidden" || value === "shortCode" || value === "outOfScope";
}

/** How close an agent's send and the phone's copy of it are, to tell the copy from the user's own. */
const AGENT_ECHO_WINDOW_MS = 5 * 60_000;

/** SQL: the user (not an agent) sent a message in the thread `key` names. */
function userSentSql(key: string): string {
  return `EXISTS (
    SELECT 1 FROM messages us
    WHERE us.thread_key = ${key} AND us.direction = 'outgoing' AND us.sent_by_agent = 0
      AND us.deleted_at IS NULL AND us.status <> 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM messages ua
        WHERE ua.thread_key = us.thread_key AND ua.sent_by_agent = 1 AND ua.deleted_at IS NULL
          AND ua.status <> 'scheduled'
          AND ua.body = us.body AND abs(ua.sort_at - us.sort_at) <= ${AGENT_ECHO_WINDOW_MS}))`;
}

/** SQL: `key` is a short code or alphanumeric sender, as `isShortCode` in keys.ts decides. */
function shortCodeSql(key: string): string {
  return `(substr(${key}, 1, 7) = 'sender:' OR (substr(${key}, 1, 4) = 'tel:'
    AND length(${key}) BETWEEN 5 AND 10 AND substr(${key}, 5) NOT GLOB '*[^0-9]*'))`;
}

/** SQL: every member of the thread `key` names is a saved contact or the user; see `AgentScopeFilter`. */
function contactsSql(
  key: string,
  ownHandles: readonly string[],
): { sql: string; params: SqlParam[] } {
  const params: SqlParam[] = [];
  const known = (handle: string): string => {
    const own = ownHandles.length
      ? `${handle} IN (${ownHandles.map(() => "?").join(", ")}) OR `
      : "";
    params.push(...ownHandles);
    return `(${own}EXISTS (
      SELECT 1 FROM handles sh JOIN contacts sc ON sc.id = sh.contact_id
      WHERE sh.handle = ${handle} AND sh.deleted_at IS NULL AND sc.deleted_at IS NULL))`;
  };
  // A group can have no members at all: that must not pass as "every member is a contact".
  const member = (extra: string) =>
    `SELECT 1 FROM thread_members sm WHERE sm.thread_key = ${key} AND sm.deleted_at IS NULL${extra}`;
  const sql = `(CASE WHEN EXISTS (${member("")})
    THEN NOT EXISTS (${member(` AND NOT ${known("sm.handle")}`)})
    ELSE (substr(${key}, 1, 4) = 'tel:' OR substr(${key}, 1, 6) = 'email:') AND ${known(key)} END)`;
  return { sql, params };
}

/** SQL: the thread `key` names is one an agent may read under `scope` (hidden aside). */
function agentScopeSql(key: string, scope: AgentScopeFilter): { sql: string; params: SqlParam[] } {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  if (scope.hideCodes) parts.push(`NOT ${shortCodeSql(key)}`);
  if (scope.read === "off") parts.push("0");
  else if (scope.read !== "all") {
    const contacts = contactsSql(key, scope.ownHandles);
    parts.push(scope.read === "known" ? `(${contacts.sql} OR ${userSentSql(key)})` : contacts.sql);
    params.push(...contacts.params);
  }
  return { sql: parts.length ? parts.join(" AND ") : "1", params };
}

/** SQL: a group's roster column as JSON `json_each` can read (none when it doesn't parse). */
function rosterJson(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END`;
}

/**
 * SQL: the conversation `key` names is hidden from agents (`Store.isThreadHiddenFromAgents`): the
 * user hid it (a group), it's an empty one left by moving its messages, or its key, a member or
 * someone on its roster is a hidden handle. Works for keys with no conversation yet.
 */
function agentHiddenSql(key: string): string {
  return `(EXISTS (SELECT 1 FROM threads ht WHERE ht.key = ${key}
      AND (ht.agent_hidden = 1 OR (ht.hidden = 1 AND ht.deleted_at IS NULL)))
    OR EXISTS (SELECT 1 FROM agent_hidden_handles ah WHERE ah.handle = ${key})
    OR EXISTS (SELECT 1 FROM thread_members hm JOIN agent_hidden_handles ah ON ah.handle = hm.handle
      WHERE hm.thread_key = ${key} AND hm.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM groups hg, json_each(${rosterJson("hg.roster")}) hr
      JOIN agent_hidden_handles ah ON ah.handle = hr.value
      WHERE hg.thread_key = ${key} AND hg.deleted_at IS NULL))`;
}

/** SQL: the contact `id` names is hidden from agents (`Store.isContactHiddenFromAgents`). */
function contactHiddenSql(id: string): string {
  return `(EXISTS (SELECT 1 FROM agent_hidden_people ap WHERE ap.contact_id = ${id})
    OR EXISTS (SELECT 1 FROM handles xh JOIN agent_hidden_handles ah ON ah.handle = xh.handle
      WHERE xh.contact_id = ${id} AND xh.deleted_at IS NULL))`;
}

const THREAD_SELECT = `
  SELECT t.key, t.kind, t.title, t.muted, t.agent_hidden, t.pinned, t.last_message_at,
    (SELECT c.name FROM handles h JOIN contacts c ON c.id = h.contact_id
      WHERE h.handle = t.key AND h.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY c.favorite DESC, c.name LIMIT 1) AS contact_name,
    (SELECT g.name FROM groups g WHERE g.thread_key = t.key AND g.deleted_at IS NULL) AS group_name,
    (SELECT g.participants FROM groups g WHERE g.thread_key = t.key AND g.deleted_at IS NULL)
      AS group_participants,
    (SELECT d.body FROM drafts d WHERE d.thread_key = t.key) AS draft_text,
    (SELECT d.updated_at FROM drafts d WHERE d.thread_key = t.key) AS draft_at,
    (SELECT count(*) FROM messages m
      WHERE m.thread_key = t.key AND m.direction = 'incoming' AND m.read = 0
        AND m.deleted_at IS NULL) AS unread
  FROM threads t`;

/** A roster entry: a plain tel: or email: handle, nothing that could smuggle in other text. */
function isRosterHandle(handle: string): boolean {
  return /^(tel:\+?[0-9]{1,20}|email:[^\s@]+@[^\s@]+)$/.test(handle);
}

function toGroup(row: GroupRow): Group {
  return {
    threadKey: row.thread_key,
    name: row.name,
    named: row.named === 1,
    participants: parseStrings(row.participants) ?? [],
    // A roster that doesn't read cleanly is no roster: never send to a guess.
    roster: row.roster === null ? null : (parseStrings(row.roster)?.filter(isRosterHandle) ?? []),
    routeInvalidated: row.route_invalidated === 1,
  };
}

/** Canonical JSON for the details column, or null when there's nothing to keep. */
function detailsJson(details: ContactDetails | undefined): string | null {
  if (!details) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value) ? value.length > 0 : value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function parseDetails(json: string | null): ContactDetails | null {
  if (!json) return null;
  try {
    const parsed = ContactDetails.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseStrings(json: string): string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function inferKind(key: string): Thread["kind"] {
  return key.startsWith("group:") ? "group" : "direct";
}

/** The address part of a thread key, for a thread with no better title. */
/**
 * What a thread is called: the user's name for it, the group's own name or the contact's, else
 * an unnamed group's members ("Aunt Kate, Nana"), else the key itself.
 */
function threadTitle(row: ThreadRow): string {
  const named = row.title ?? row.group_name ?? row.contact_name;
  if (named) return named;
  if (!row.key.startsWith("group:")) return displayKey(row.key);
  const people = (row.group_participants && parseStrings(row.group_participants)) || [];
  if (people.length > 0) return people.join(", ");
  return displayKey(row.key)
    .split("+")
    .map((slug) => slug.split("-").map(capitalize).join(" "))
    .join(", ");
}

function capitalize(word: string): string {
  return word.charAt(0).toLocaleUpperCase() + word.slice(1);
}

function displayKey(key: string): string {
  return key.replace(/^(tel|email|sender|group:name|group:members):/, "");
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 50), 1), 500);
}

/**
 * Identity of a message apart from its handle: the same sender, direction, text and send time.
 * A message can be moved between threads, so the thread isn't part of it.
 */
export function contentHash(
  m: Pick<NewMessage, "direction" | "sender" | "body" | "sentAt">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([m.direction, m.sender, m.body, m.sentAt]))
    .digest("base64url");
}

/**
 * Turns free text into an FTS5 query: every word must appear, the last as a prefix. Quotes keep
 * FTS syntax (`OR`, `-`, `"`, `*`) in user input literal.
 */
export function ftsQuery(text: string): string {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter((w) => w.length > 0);
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

/** Whether a tapback's quote is `body`, or its start when iOS cut it short with `…`. */
function quotes(quote: string, body: string): boolean {
  if (!quote.endsWith("…")) return quote === body;
  const prefix = quote.slice(0, -1);
  return prefix.length > 0 && body.startsWith(prefix);
}

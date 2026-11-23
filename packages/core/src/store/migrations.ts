import { TincanError } from "@beyland/tincan-protocol";
import type { Db } from "./db.ts";

/** SQL for the current time in milliseconds. */
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** SQL for a fresh UUIDv7 (RFC 9562) per row, as `uuidv7` in ids.ts makes them. */
function uuidv7Sql(): string {
  const time = `printf('%012x', ${NOW_MS_SQL})`;
  return `(substr(${time}, 1, 8) || '-' || substr(${time}, 9, 4) || '-7'
    || substr(lower(hex(randomblob(2))), 2, 3) || '-'
    || substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2, 3)
    || '-' || lower(hex(randomblob(6))))`;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Numbered migrations, applied in order and recorded in `PRAGMA user_version`. Once a version has
 * shipped its SQL never changes: add a new migration instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      -- Syncable tables (ADR 0007) carry origin (the computer that last changed the row),
      -- updated_at (a hybrid logical clock; mutable fields merge last-writer-wins by it),
      -- change_seq (local and increasing, for "changes since N") and deleted_at (a tombstone:
      -- rows are never deleted, so nothing cascades). Everything else is local to this computer.

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE threads (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
        title TEXT,
        muted INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        -- Derived from the thread's messages; recomputed locally, never merged.
        last_message_at INTEGER,
        created_at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX threads_by_activity ON threads (last_message_at DESC);
      CREATE INDEX threads_changes ON threads (change_seq);

      CREATE TABLE thread_members (
        thread_key TEXT NOT NULL REFERENCES threads (key),
        handle TEXT NOT NULL,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (thread_key, handle)
      );
      CREATE INDEX thread_members_changes ON thread_members (change_seq);

      CREATE TABLE messages (
        -- Stable across computers: a hash for MAP and ANCS messages, a UUIDv7 for ones sent here.
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL REFERENCES threads (key),
        -- The phone's address.
        device TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        sender TEXT,
        body TEXT NOT NULL,
        sent_at INTEGER,
        received_at INTEGER NOT NULL,
        sort_at INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('map', 'ancs', 'local')),
        status TEXT NOT NULL CHECK (status IN ('received', 'pending', 'sent', 'failed', 'unknown')),
        read INTEGER NOT NULL DEFAULT 0,
        -- A dedupe key for this computer's MAP sessions, not an id.
        map_handle TEXT,
        folder TEXT,
        content_hash TEXT NOT NULL,
        -- Apple's message GUID, once a backup import has matched the message.
        apple_guid TEXT UNIQUE,
        reaction_kind TEXT,
        -- No foreign key: another computer's changes may bring a reaction before its message.
        reaction_to TEXT,
        attachment_hint TEXT,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE (device, map_handle)
      );
      CREATE INDEX messages_by_thread ON messages (thread_key, sort_at DESC);
      CREATE INDEX messages_by_hash ON messages (content_hash);
      CREATE INDEX messages_by_reaction ON messages (reaction_to) WHERE reaction_to IS NOT NULL;
      CREATE INDEX messages_changes ON messages (change_seq);

      -- Tombstoned messages are left out of the index.
      CREATE VIRTUAL TABLE messages_fts USING fts5 (
        body,
        content = 'messages',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
        INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
      END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END;
      CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, deleted_at ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body)
          SELECT 'delete', old.rowid, old.body WHERE old.deleted_at IS NULL;
        INSERT INTO messages_fts (rowid, body)
          SELECT new.rowid, new.body WHERE new.deleted_at IS NULL;
      END;

      -- Local: messages that arrived live here and still need a desktop notification. Messages
      -- from a catch-up pass or another computer never get a row, so they count as notified.
      CREATE TABLE unnotified (
        message_id TEXT PRIMARY KEY REFERENCES messages (id)
      );

      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        photo_path TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX contacts_changes ON contacts (change_seq);

      CREATE TABLE handles (
        contact_id TEXT NOT NULL REFERENCES contacts (id),
        handle TEXT NOT NULL,
        label TEXT,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (contact_id, handle)
      );
      CREATE INDEX handles_by_handle ON handles (handle);
      CREATE INDEX handles_changes ON handles (change_seq);

      CREATE TABLE groups (
        thread_key TEXT PRIMARY KEY REFERENCES threads (key),
        name TEXT,
        named INTEGER NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        roster TEXT,
        route_invalidated INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX groups_changes ON groups (change_seq);

      -- Local tables.

      CREATE TABLE drafts (
        thread_key TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE outbox (
        message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
        recipients TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        -- Set while a push is running: a pending row with it set after a restart may have gone out.
        pushing_since INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        summary TEXT NOT NULL,
        input TEXT NOT NULL,
        client TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
        resolved_at INTEGER
      );
      CREATE INDEX approvals_pending ON approvals (expires_at) WHERE state = 'pending';

      CREATE TABLE sync_state (
        device TEXT NOT NULL,
        folder TEXT NOT NULL,
        last_sync_at INTEGER,
        last_listing TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (device, folder)
      );

      CREATE TABLE gaps (
        id INTEGER PRIMARY KEY,
        device TEXT NOT NULL,
        thread_key TEXT,
        from_at INTEGER NOT NULL,
        to_at INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX gaps_open ON gaps (thread_key) WHERE resolved_at IS NULL;
    `,
  },
  {
    version: 2,
    name: "contact details",
    sql: `ALTER TABLE contacts ADD COLUMN details TEXT;`,
  },
  {
    version: 3,
    name: "connection log",
    sql: `
      CREATE TABLE connection_log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        address TEXT,
        code TEXT
      );
    `,
  },
  {
    version: 4,
    name: "agent safety",
    sql: `
      -- Set when the user hides a conversation and cleared only when they unhide it: unlike
      -- hidden, a new message doesn't clear it, so agents never see the conversation again.
      ALTER TABLE threads ADD COLUMN agent_hidden INTEGER NOT NULL DEFAULT 0;
      UPDATE threads SET agent_hidden = 1 WHERE hidden = 1;

      -- Sent by an AI agent rather than the user (a send from the phone or a Tincan app).
      ALTER TABLE messages ADD COLUMN sent_by_agent INTEGER NOT NULL DEFAULT 0;

      -- Local: who wrote a draft, so an agent never overwrites the user's.
      ALTER TABLE drafts ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0;

      -- Local: when agents last did rate-limited things, so a restart doesn't reset the limits.
      CREATE TABLE agent_actions (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX agent_actions_by_kind ON agent_actions (kind, at);

      -- Local: the opaque IDs agents have been given, and what each stands for.
      CREATE TABLE agent_tokens (
        token TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: "approval notes",
    sql: `
      -- Why a send needed the user even though the policy might have let it go: the recipient is
      -- hidden from agents, a short code, or outside what agents may read. Shown only to the user.
      ALTER TABLE approvals ADD COLUMN note TEXT;
    `,
  },
  {
    version: 6,
    name: "draft agent names",
    sql: `
      -- Local: the self-reported name of the AI agent that wrote a draft (with by_agent), so the
      -- app can say who drafted it. The user's own save clears it.
      ALTER TABLE drafts ADD COLUMN agent_name TEXT;
    `,
  },
  {
    version: 7,
    name: "agent drafts and send delays",
    sql: `
      -- Local: messages AI agents wrote, queued in a conversation's composer for the user (or
      -- tracked through their send). Never synced. recipient is the tel:/email: key it goes to,
      -- which is also the key of its conversation once there is one. queue_at orders the queue.
      CREATE TABLE agent_drafts (
        id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        requested_as TEXT,
        agent_name TEXT NOT NULL,
        intent TEXT NOT NULL CHECK (intent IN ('draft', 'send')),
        body TEXT NOT NULL,
        text TEXT NOT NULL,
        edited INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK (state IN ('queued', 'scheduled', 'sent', 'failed', 'discarded', 'cancelled')),
        message_id TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        queue_at INTEGER NOT NULL
      );
      CREATE INDEX agent_drafts_by_recipient ON agent_drafts (recipient, state, queue_at);
      CREATE INDEX agent_drafts_by_agent ON agent_drafts (agent_name, state);
      CREATE INDEX agent_drafts_by_message ON agent_drafts (message_id) WHERE message_id IS NOT NULL;

      -- Agents' drafts move out of the user's draft slot. Only ones Tincan can send (to a phone
      -- number or email address) become agent drafts; any other stays as the user's draft.
      INSERT INTO agent_drafts (id, recipient, agent_name, intent, body, text, state, created_at,
          updated_at, queue_at)
        SELECT 'drf_' || substr(printf('%012x', updated_at), 1, 8) || '-'
            || substr(printf('%012x', updated_at), 9, 4) || '-7'
            || substr(lower(hex(randomblob(2))), 2, 3) || '-'
            || substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2, 3)
            || '-' || lower(hex(randomblob(6))),
          thread_key, COALESCE(agent_name, 'An AI agent'), 'draft', body, body, 'queued',
          updated_at, updated_at, updated_at
        FROM drafts
        WHERE by_agent = 1 AND (substr(thread_key, 1, 4) = 'tel:' OR substr(thread_key, 1, 6) = 'email:');
      DELETE FROM drafts
        WHERE by_agent = 1 AND (substr(thread_key, 1, 4) = 'tel:' OR substr(thread_key, 1, 6) = 'email:');
      UPDATE drafts SET by_agent = 0, agent_name = NULL;

      -- Approvals became agent drafts; nothing waits or expires any more.
      DROP TABLE approvals;

      -- Rebuild messages so status allows 'scheduled' (held for the send delay), keeping rowids
      -- (the full-text index refers to them). Rows that reference messages are set aside first,
      -- so dropping the old table cascades to nothing.
      CREATE TEMP TABLE v7_outbox AS SELECT * FROM outbox;
      CREATE TEMP TABLE v7_unnotified AS SELECT * FROM unnotified;
      DELETE FROM outbox;
      DELETE FROM unnotified;

      CREATE TABLE messages_v7 (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL REFERENCES threads (key),
        device TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        sender TEXT,
        body TEXT NOT NULL,
        sent_at INTEGER,
        received_at INTEGER NOT NULL,
        sort_at INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('map', 'ancs', 'local')),
        status TEXT NOT NULL CHECK (status IN ('received', 'scheduled', 'pending', 'sent', 'failed', 'unknown')),
        read INTEGER NOT NULL DEFAULT 0,
        map_handle TEXT,
        folder TEXT,
        content_hash TEXT NOT NULL,
        apple_guid TEXT UNIQUE,
        reaction_kind TEXT,
        reaction_to TEXT,
        attachment_hint TEXT,
        origin TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_seq INTEGER NOT NULL,
        deleted_at INTEGER,
        sent_by_agent INTEGER NOT NULL DEFAULT 0,
        -- For agent messages: the user edited the agent's text first, the agent's self-reported
        -- name, and how it went (user: sent from an agent draft; policy: sent directly).
        agent_edited INTEGER NOT NULL DEFAULT 0,
        agent_name TEXT,
        agent_via TEXT,
        UNIQUE (device, map_handle)
      );
      INSERT INTO messages_v7 (rowid, id, thread_key, device, direction, sender, body, sent_at,
          received_at, sort_at, source, status, read, map_handle, folder, content_hash, apple_guid,
          reaction_kind, reaction_to, attachment_hint, origin, updated_at, change_seq, deleted_at,
          sent_by_agent)
        SELECT rowid, id, thread_key, device, direction, sender, body, sent_at, received_at, sort_at,
          source, status, read, map_handle, folder, content_hash, apple_guid, reaction_kind,
          reaction_to, attachment_hint, origin, updated_at, change_seq, deleted_at, sent_by_agent
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v7 RENAME TO messages;
      CREATE INDEX messages_by_thread ON messages (thread_key, sort_at DESC);
      CREATE INDEX messages_by_hash ON messages (content_hash);
      CREATE INDEX messages_by_reaction ON messages (reaction_to) WHERE reaction_to IS NOT NULL;
      CREATE INDEX messages_changes ON messages (change_seq);
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
        INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
      END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      END;
      CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, deleted_at ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body)
          SELECT 'delete', old.rowid, old.body WHERE old.deleted_at IS NULL;
        INSERT INTO messages_fts (rowid, body)
          SELECT new.rowid, new.body WHERE new.deleted_at IS NULL;
      END;

      -- Local: when a scheduled message goes to the phone, and the agent draft it was sent from.
      ALTER TABLE outbox ADD COLUMN send_at INTEGER;
      ALTER TABLE outbox ADD COLUMN agent_draft_id TEXT;
      INSERT INTO outbox (message_id, recipients, attempts, last_error, pushing_since, updated_at)
        SELECT message_id, recipients, attempts, last_error, pushing_since, updated_at FROM v7_outbox;
      INSERT INTO unnotified (message_id) SELECT message_id FROM v7_unnotified;
      DROP TABLE v7_outbox;
      DROP TABLE v7_unnotified;
    `,
  },
  {
    version: 8,
    name: "hide from agents only",
    sql: `
      -- Hiding a conversation from the list until a new message arrives is gone; hiding it from
      -- AI agents (agent_hidden) stays. Conversations the user hid come back into the list and
      -- stay hidden from agents, as hiding them implied. From now on hidden only keeps an empty
      -- conversation, left behind when its messages moved to a group, out of the list until a
      -- message arrives: those have no messages, so they stay as they are.
      UPDATE threads SET agent_hidden = 1, hidden = 0
        WHERE hidden = 1
          AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_key = threads.key AND m.deleted_at IS NULL);
    `,
  },
  {
    version: 9,
    name: "hide people from agents",
    sql: `
      -- Local: people the user hid from AI agents. A contact's id is a hash of its card, so it
      -- changes whenever the card is edited: a person is anchored on handles instead, and
      -- contact_id (null for a raw number or address, or once the contact is gone) follows the
      -- card that has them. label is the contact's name, or the address for a raw one.
      CREATE TABLE agent_hidden_people (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Local: every hidden handle. A handle is hidden from agents iff it's here. source: from the
      -- contact's card, or typed in by the user.
      CREATE TABLE agent_hidden_handles (
        handle TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES agent_hidden_people (id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('contact', 'manual'))
      );
      CREATE INDEX agent_hidden_handles_by_person ON agent_hidden_handles (person_id);
      CREATE INDEX agent_hidden_people_by_contact ON agent_hidden_people (contact_id);

      -- One-to-one conversations hidden from agents become hidden people: the contact the key
      -- belongs to, with all its numbers and emails, or else the key alone. agent_hidden stays,
      -- for group conversations only.
      CREATE TEMP TABLE v9_hidden AS
        SELECT t.key AS key,
          (SELECT c.id FROM handles h JOIN contacts c ON c.id = h.contact_id
            WHERE h.handle = t.key AND h.deleted_at IS NULL AND c.deleted_at IS NULL
            ORDER BY c.favorite DESC, c.name, c.id LIMIT 1) AS contact_id
        FROM threads t WHERE t.kind = 'direct' AND t.agent_hidden = 1;
      CREATE TEMP TABLE v9_people AS
        SELECT ${uuidv7Sql()} AS id, contact_id
        FROM (SELECT DISTINCT contact_id FROM v9_hidden WHERE contact_id IS NOT NULL);
      INSERT INTO agent_hidden_people (id, contact_id, label, created_at)
        SELECT p.id, p.contact_id, c.name, ${NOW_MS_SQL}
        FROM v9_people p JOIN contacts c ON c.id = p.contact_id;
      INSERT OR IGNORE INTO agent_hidden_handles (handle, person_id, source)
        SELECT h.handle, p.id, 'contact'
        FROM v9_people p JOIN handles h ON h.contact_id = p.contact_id
        WHERE h.deleted_at IS NULL;
      CREATE TEMP TABLE v9_manual AS
        SELECT ${uuidv7Sql()} AS id, key
        FROM v9_hidden WHERE key NOT IN (SELECT handle FROM agent_hidden_handles);
      INSERT INTO agent_hidden_people (id, contact_id, label, created_at)
        SELECT id, NULL,
          CASE
            WHEN substr(key, 1, 4) = 'tel:' THEN substr(key, 5)
            WHEN substr(key, 1, 6) = 'email:' THEN substr(key, 7)
            WHEN substr(key, 1, 7) = 'sender:' THEN substr(key, 8)
            ELSE key
          END,
          ${NOW_MS_SQL}
        FROM v9_manual;
      INSERT INTO agent_hidden_handles (handle, person_id, source)
        SELECT key, id, 'manual' FROM v9_manual;
      UPDATE threads SET agent_hidden = 0 WHERE kind = 'direct' AND agent_hidden = 1;
      DROP TABLE v9_hidden;
      DROP TABLE v9_people;
      DROP TABLE v9_manual;
    `,
  },
  {
    version: 10,
    name: "contact photos in the store",
    sql: `
      -- Local: contact photos, once each, by the name contacts.photo_path gives them
      -- (<sha256>.<ext>). A table of their own keeps contact queries off the photos' pages.
      -- Replaces the plain files Tincan kept next to the store; those are imported at startup.
      CREATE TABLE contact_photos (
        name TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        data BLOB NOT NULL
      );
    `,
  },
];

export interface MigrationResult {
  from: number;
  to: number;
}

/** Brings `db` up to the newest migration. Refuses a database written by a newer Tincan. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new TincanError("INTERNAL", `Migration ${i + 1} is out of order`);
  });
  const from = schemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    throw new TincanError(
      "CONFLICT",
      `The message store is at schema ${from}, newer than this Tincan understands (${latest}). Update Tincan.`,
    );
  }
  for (const migration of migrations.slice(from)) {
    db.transaction(() => {
      db.execBatch(migration.sql);
      db.execBatch(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { from, to: latest };
}

export function schemaVersion(db: Db): number {
  return Number(db.query<{ user_version: number }>("PRAGMA user_version")[0]?.user_version ?? 0);
}

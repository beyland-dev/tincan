import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { TincanError } from "@beyland/tincan-protocol";
import {
  CONNECTION_LOG_LIMIT,
  Core,
  HybridClock,
  isShortCode,
  MIGRATIONS,
  Store,
  compareHlc,
  ftsQuery,
  lastWriterWins,
  migrate,
  nodeSqliteDb,
  parseHlc,
  phoneContactId,
  phoneMessageId,
  schemaVersion,
  uuidv7,
  type ContactInput,
  type Db,
  type NewMessage,
} from "../src/index.ts";

const PHONE = "aa:bb:cc:dd:ee:ff";
const ALICE = "tel:+12065550101";
const BOB = "tel:+12065550102";
const T0 = 1_780_000_000_000;

function memoryDb(): Db {
  return nodeSqliteDb(new DatabaseSync(":memory:"));
}

function clock(start = T0) {
  let t = start;
  const now = () => t;
  return { now, set: (v: number) => (t = v), tick: (ms = 1) => (t += ms) };
}

function open(db = memoryDb(), now = clock().now) {
  return Store.open(db, { now });
}

function incoming(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    threadKey: ALICE,
    direction: "incoming",
    sender: ALICE,
    body: "hello there",
    sentAt: T0,
    receivedAt: T0 + 500,
    source: "map",
    status: "received",
    read: false,
    device: PHONE,
    mapHandle: "0400000000000001",
    folder: "inbox",
    ...overrides,
  };
}

function row(store: Store, table: string, where: string, params: (string | number)[]) {
  return store.db.query<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE ${where}`,
    params,
  )[0]!;
}

describe("connection log", () => {
  test("keeps the newest entries, oldest first", () => {
    const store = open();
    for (let i = 0; i < CONNECTION_LOG_LIMIT + 5; i++) {
      store.logConnection({
        at: T0 + i,
        kind: "phone",
        state: `s${i}`,
        address: PHONE,
        code: null,
      });
    }
    const all = store.connectionLog(CONNECTION_LOG_LIMIT + 10);
    expect(all).toHaveLength(CONNECTION_LOG_LIMIT);
    expect(all[0]).toEqual({ at: T0 + 5, kind: "phone", state: "s5", address: PHONE, code: null });
    expect(store.connectionLog(2).map((e) => e.state)).toEqual([
      `s${CONNECTION_LOG_LIMIT + 3}`,
      `s${CONNECTION_LOG_LIMIT + 4}`,
    ]);
  });
});

describe("migrations", () => {
  test("a fresh database migrates to the latest version, once", () => {
    const db = memoryDb();
    expect(migrate(db)).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(migrate(db)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  test("refuses a database from a newer Tincan", () => {
    const db = memoryDb();
    db.execBatch(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    let error: unknown;
    try {
      migrate(db);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TincanError);
    expect((error as TincanError).code).toBe("CONFLICT");
  });

  test("refuses migrations out of order", () => {
    expect(() => migrate(memoryDb(), [{ ...MIGRATIONS[0]!, version: 2 }])).toThrow(/out of order/);
  });

  test("v7 moves agents' drafts out of the user's slot, drops approvals and allows scheduled", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.slice(0, 6));
    // A version 6 store: messages (one with an outbox entry and a notification), drafts by the
    // user and by agents, and an approval.
    db.exec(
      `INSERT INTO threads (key, kind, created_at, origin, updated_at, change_seq)
         VALUES (?, 'direct', 1, 'o', 'h', 1)`,
      [ALICE],
    );
    const insertMessage = (id: string, body: string, status: string, agent = 0) =>
      db.exec(
        `INSERT INTO messages (id, thread_key, direction, body, received_at, sort_at, source,
           status, content_hash, origin, updated_at, change_seq, sent_by_agent)
         VALUES (?, ?, 'outgoing', ?, 1, 1, 'local', ?, ?, 'o', 'h', 1, ?)`,
        [id, ALICE, body, status, id, agent],
      );
    insertMessage("m1", "pending lunch plans", "pending");
    insertMessage("m2", "sent by an agent", "sent", 1);
    db.exec("INSERT INTO outbox (message_id, recipients, updated_at) VALUES ('m1', '[]', 5)");
    db.exec("INSERT INTO unnotified (message_id) VALUES ('m2')");
    db.exec(
      "INSERT INTO drafts (thread_key, body, updated_at, by_agent, agent_name) VALUES (?, ?, ?, ?, ?)",
      [ALICE, "agent wrote this", T0, 1, "Claude Code"],
    );
    db.exec(
      "INSERT INTO drafts (thread_key, body, updated_at, by_agent, agent_name) VALUES (?, ?, ?, ?, ?)",
      [BOB, "older agent draft", T0 + 1, 1, null],
    );
    db.exec(
      "INSERT INTO drafts (thread_key, body, updated_at, by_agent, agent_name) VALUES (?, ?, ?, ?, ?)",
      ["group:name:club", "group draft by an agent", T0 + 2, 1, "Claude Code"],
    );
    db.exec(
      "INSERT INTO drafts (thread_key, body, updated_at, by_agent, agent_name) VALUES (?, ?, ?, ?, ?)",
      ["tel:+12065550103", "the user's own", T0 + 3, 0, null],
    );
    db.exec(
      `INSERT INTO approvals (id, command, summary, input, client, requested_at, expires_at, state)
       VALUES ('a1', 'message.send', 's', '{}', '{}', 1, 2, 'pending')`,
    );

    expect(migrate(db)).toEqual({ from: 6, to: MIGRATIONS.length });
    const store = Store.open(db);
    // Agents' drafts to numbers and addresses are queued agent drafts now.
    const drafts = store.listAgentDrafts({ states: ["queued"] });
    expect(drafts.map((d) => [d.to, d.agentName, d.intent, d.body, d.text, d.state])).toEqual([
      [ALICE, "Claude Code", "draft", "agent wrote this", "agent wrote this", "queued"],
      [BOB, "An AI agent", "draft", "older agent draft", "older agent draft", "queued"],
    ]);
    expect(drafts[0]!.id).toMatch(
      /^drf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(drafts[0]).toMatchObject({
      createdAt: T0,
      edited: false,
      revision: 0,
      threadKey: ALICE,
    });
    expect(drafts[1]!.threadKey).toBeNull();
    // The user's slot keeps only the user's (a group's agent draft stays, as the user's text).
    expect(store.getDraft(ALICE)).toBeNull();
    expect(store.getDraft(BOB)).toBeNull();
    expect(store.getDraft("tel:+12065550103")).toBe("the user's own");
    expect(store.getDraft("group:name:club")).toBe("group draft by an agent");
    // Approvals are gone.
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'approvals'")).toEqual([]);
    // Messages kept everything, with their outbox entry, notification and full-text index.
    expect(store.getMessage("m1")?.status).toBe("pending");
    expect(store.outboxEntry("m1")).toMatchObject({
      updatedAt: 5,
      sendAt: null,
      agentDraftId: null,
    });
    expect(store.pendingNotifications().map((m) => m.id)).toEqual(["m2"]);
    expect(store.getMessage("m2")?.agent).toEqual({
      name: "An AI agent",
      edited: false,
      via: "policy",
    });
    expect(store.search("lunch").map((m) => m.id)).toEqual(["m1"]);
    // New messages index too, and status may now be scheduled.
    const scheduled = store.queueOutgoing({
      threadKey: ALICE,
      body: "scheduled dinner",
      recipients: [],
      sendAt: T0 + 10_000,
    });
    expect(store.getMessage(scheduled.id)).toMatchObject({
      status: "scheduled",
      sendAt: T0 + 10_000,
    });
    store.dispatchScheduled(scheduled.id);
    expect(store.search("dinner").map((m) => m.id)).toEqual([scheduled.id]);
    expect(db.query("PRAGMA foreign_key_check")).toEqual([]);
    expect(
      db.query<{ integrity_check: string }>("PRAGMA integrity_check")[0]?.integrity_check,
    ).toBe("ok");
  });
});

describe("settings", () => {
  test("round-trip as JSON", () => {
    const store = open();
    store.setSetting("x", { a: [1, 2] });
    expect(store.getSetting("x")).toEqual({ a: [1, 2] });
    expect(store.getSetting("missing")).toBeUndefined();
  });

  test("Core persists settings through the store", async () => {
    const db = memoryDb();
    const core = await Core.open({ version: "0", store: open(db) });
    core.updateSettings({ agents: { read: "all" } });
    const again = await Core.open({ version: "0", store: open(db) });
    expect(again.settings.agents.read).toBe("all");
  });

  test("settings stored by older versions load with today's values", async () => {
    const db = memoryDb();
    open(db).setSetting("settings", {
      agents: {
        enabled: true,
        read: "on",
        send: "allow",
        handles: "visible",
        drafts: false,
        retired: 1,
      },
      notifications: { preview: "sender", sound: true },
      defaultRegion: "GB",
    });
    const core = await Core.open({ version: "0", store: open(db) });
    expect(core.settings).toEqual({
      agents: {
        access: "assistant",
        read: "known",
        send: "replied",
        sendLimit: 10,
        sendDelaySeconds: 10,
        manage: false,
        handles: "visible",
        hideCodes: true,
      },
      notifications: { preview: "sender" },
      defaultRegion: "GB",
      sendDelaySeconds: 0,
    });
    // A value no version understands falls back rather than breaking the policy.
    open(db).setSetting("settings", { agents: { read: "everything", sendLimit: 1000 } });
    const odd = await Core.open({ version: "0", store: open(db) });
    expect(odd.settings.agents).toMatchObject({ read: "known", sendLimit: 10 });
    // A stored "no limit" stays no limit.
    open(db).setSetting("settings", { agents: { access: "assistant", sendLimit: null } });
    expect((await Core.open({ version: "0", store: open(db) })).settings.agents.sendLimit).toBe(
      null,
    );
  });

  test("the old agents.enabled switch becomes an access level, never full", async () => {
    const db = memoryDb();
    const load = async (agents: Record<string, unknown>) => {
      open(db).setSetting("settings", { agents });
      const core = await Core.open({ version: "0", store: open(db) });
      expect(core.settings.agents).not.toHaveProperty("enabled");
      return core.settings.agents;
    };
    expect(await load({ enabled: false, read: "all", send: "allow" })).toMatchObject({
      access: "off",
      read: "all",
      send: "replied",
    });
    expect(await load({ enabled: true, read: "on", send: "never" })).toMatchObject({
      access: "readOnly",
      read: "known",
    });
    // Older still: no send policy stored, which meant never.
    expect((await load({ enabled: true, read: "on" })).access).toBe("readOnly");
    // On, but agents could neither read nor send: it stays that way rather than gaining reading.
    expect((await load({ enabled: true, read: "off", send: "never" })).access).toBe("off");
    expect(
      await load({ enabled: true, read: "all", send: "always", handles: "visible" }),
    ).toMatchObject({ access: "assistant", send: "always", handles: "visible" });
    expect((await load({ enabled: true, read: "off", send: "approve" })).access).toBe("assistant");
    // Already migrated: `access` wins over a leftover `enabled`.
    expect((await load({ enabled: true, access: "off", send: "approve" })).access).toBe("off");
  });
});

describe("message ids", () => {
  test("a phone message gets the same id on every computer", () => {
    const a = open().insertMessage(incoming()).message!;
    const b = open().insertMessage(
      incoming({ mapHandle: "other-handle", receivedAt: T0 + 9000 }),
    ).message!;
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("only whole seconds of the phone time count, and the device's case doesn't", () => {
    const id = phoneMessageId(
      { device: PHONE, threadKey: ALICE, direction: "incoming", phoneTime: T0, body: "x" },
      0,
    );
    expect(
      phoneMessageId(
        {
          device: PHONE.toUpperCase(),
          threadKey: ALICE,
          direction: "incoming",
          phoneTime: T0 + 999,
          body: "x",
        },
        0,
      ),
    ).toBe(id);
    expect(
      phoneMessageId(
        { device: PHONE, threadKey: ALICE, direction: "incoming", phoneTime: T0 + 1000, body: "x" },
        0,
      ),
    ).not.toBe(id);
  });

  test("identical texts in the same second get distinct ids, the same on every computer", () => {
    const ids = () => {
      const store = open();
      return ["h1", "h2", "h3"].map(
        (h) => store.insertMessage(incoming({ body: "ok", mapHandle: h })).message!.id,
      );
    };
    const first = ids();
    expect(new Set(first).size).toBe(3);
    const base = {
      device: PHONE,
      threadKey: ALICE,
      direction: "incoming",
      phoneTime: T0,
      body: "ok",
    } as const;
    expect(first).toEqual([0, 1, 2].map((n) => phoneMessageId(base, n)));
    expect(ids()).toEqual(first);
  });

  test("messages sent from Tincan get a UUIDv7", () => {
    const store = open();
    const { message } = store.insertMessage(
      incoming({
        direction: "outgoing",
        sender: null,
        source: "local",
        status: "pending",
        mapHandle: null,
        device: null,
      }),
    );
    expect(message!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(message!.id.replace(/-/g, "").slice(0, 12)).toBe(T0.toString(16).padStart(12, "0"));
    expect(uuidv7(T0)).not.toBe(uuidv7(T0));
  });
});

describe("inserting messages", () => {
  test("dedupes by (device, map handle) and by Apple GUID", () => {
    const store = open();
    expect(store.insertMessage(incoming()).inserted).toBe(true);
    const again = store.insertMessage(incoming({ device: PHONE.toUpperCase(), body: "changed" }));
    expect(again.inserted).toBe(false);
    expect(again.message!.body).toBe("hello there");

    store.insertMessage(incoming({ mapHandle: "h2", body: "b", appleGuid: "GUID-1" }));
    expect(
      store.insertMessage(incoming({ mapHandle: null, body: "different", appleGuid: "GUID-1" }))
        .inserted,
    ).toBe(false);
  });

  test("an ANCS or Tincan copy and the MAP copy are one message", () => {
    const store = open();
    const ancs = store.insertMessage(incoming({ source: "ancs", mapHandle: null, device: null }));
    const map = store.insertMessage(incoming());
    expect(map.inserted).toBe(false);
    expect(map.message!.id).toBe(ancs.message!.id);
    expect(map.message!.mapHandle).toBe("0400000000000001");
    expect(
      store.insertMessage(incoming({ source: "ancs", mapHandle: null, device: null })).inserted,
    ).toBe(false);
  });

  test("an empty conversation a move left behind leaves the list until its next message", () => {
    const store = open();
    const { message } = store.insertMessage(incoming());
    expect(store.moveMessage(message!.id, "group:name:club", "group")).toBe(true);
    expect(store.listThreads().map((t) => t.key)).toEqual(["group:name:club"]);
    // Agents can't reach it either while it's out of the list, but it isn't hidden from them.
    expect(store.isThreadHiddenFromAgents(ALICE)).toBe(true);
    expect(store.getThread(ALICE)?.hiddenFromAgents).toBe(false);
    // Any message brings it back, one the user sent too.
    store.insertMessage(
      incoming({ direction: "outgoing", mapHandle: "h2", body: "hi", sentAt: T0 + 60_000 }),
    );
    expect(store.listThreads().map((t) => t.key)).toContain(ALICE);
    expect(store.isThreadHiddenFromAgents(ALICE)).toBe(false);
  });

  test("keeps thread activity, unread counts and members", () => {
    const store = open();
    store.insertMessage(incoming());
    store.insertMessage(incoming({ mapHandle: "h2", body: "later", sentAt: T0 + 60_000 }));
    const [thread] = store.listThreads();
    expect(thread).toMatchObject({
      key: ALICE,
      kind: "direct",
      members: [ALICE],
      unread: 2,
      title: "+12065550101",
    });
    expect(thread!.lastMessage!.body).toBe("later");
    expect(store.markThreadRead(ALICE)).toHaveLength(2);
    expect(store.getThread(ALICE)!.unread).toBe(0);
  });

  test("folds tapbacks into their message and round-trips attachment hints", () => {
    const store = open();
    const target = store.insertMessage(
      incoming({ attachmentHint: { count: 1, kinds: ["image"] } }),
    ).message!;
    store.insertMessage(
      incoming({
        mapHandle: "h2",
        body: "Loved “hello there”",
        reactionKind: "love",
        reactionTo: target.id,
      }),
    );
    const [message] = store.listMessages(ALICE);
    expect(message!.reactions).toEqual([
      { kind: "love", from: ALICE, text: "Loved “hello there”" },
    ]);
    expect(message!.attachmentHint).toEqual({ count: 1, kinds: ["image"] });
    expect(store.listMessages(ALICE)).toHaveLength(1);
  });

  test("paginates messages and threads", () => {
    const store = open();
    for (let i = 0; i < 5; i++) {
      store.insertMessage(incoming({ mapHandle: `h${i}`, body: `m${i}`, sentAt: T0 + i * 1000 }));
    }
    const page = store.listMessages(ALICE, { limit: 2 });
    expect(page.map((m) => m.body)).toEqual(["m4", "m3"]);
    const next = store.listMessages(ALICE, { limit: 2, before: page[1]!.sentAt! });
    expect(next.map((m) => m.body)).toEqual(["m2", "m1"]);
    store.insertMessage(
      incoming({ threadKey: BOB, sender: BOB, mapHandle: "b", sentAt: T0 + 10_000 }),
    );
    expect(store.listThreads({ limit: 1 }).map((t) => t.key)).toEqual([BOB]);
    expect(store.listThreads({ before: T0 + 10_000 }).map((t) => t.key)).toEqual([ALICE]);
  });

  test("moves messages between threads and recomputes both", () => {
    const store = open();
    const m = store.insertMessage(incoming()).message!;
    const group = "group:name:Climbing";
    expect(store.moveMessage(m.id, group)).toBe(true);
    expect(store.getThread(ALICE)!.lastMessage).toBeNull();
    expect(store.getThread(group)).toMatchObject({ kind: "group", unread: 1 });
    expect(store.getMessage(m.id)!.threadKey).toBe(group);
  });
});

describe("search", () => {
  test("matches words and prefixes, and survives FTS syntax", () => {
    const store = open();
    store.insertMessage(incoming({ body: "Dinner at Café Lumière tonight?" }));
    store.insertMessage(incoming({ mapHandle: "h2", body: "unrelated" }));
    expect(store.search("cafe lum").map((m) => m.body)).toEqual([
      "Dinner at Café Lumière tonight?",
    ]);
    for (const odd of ['"', "OR", "-", "*", "NEAR(", 'a"b', "  "]) {
      expect(() => store.search(odd)).not.toThrow();
    }
    expect(ftsQuery('say "hi" OR')).toBe('"say" "hi" "OR"*');
    expect(store.search("dinner", { threadKey: BOB })).toEqual([]);
  });
});

describe("who wrote in a conversation", () => {
  const userSent = (store: Store, body: string, at: number, handle: string) =>
    store.insertMessage(
      incoming({
        threadKey: BOB,
        direction: "outgoing",
        sender: null,
        body,
        sentAt: at,
        receivedAt: at,
        mapHandle: handle,
        folder: "sent",
      }),
    ).message!;

  test("an agent's message and the phone's copy of it aren't the user's", () => {
    const c = clock();
    const store = open(memoryDb(), c.now);
    store.queueOutgoing({ threadKey: BOB, body: "Thanks", recipients: [BOB], byAgent: true });
    userSent(store, "Thanks", T0 + 30_000, "echo");
    expect(store.hasUserSentMessage(BOB)).toBe(false);
    // The same words from the user long after aren't an echo.
    userSent(store, "Thanks", T0 + 60 * 60_000, "later");
    expect(store.hasUserSentMessage(BOB)).toBe(true);
    // An agent message the user deleted explains nothing any more.
    const other = open(memoryDb(), c.now);
    const gone = other.queueOutgoing({
      threadKey: BOB,
      body: "Hi",
      recipients: [BOB],
      byAgent: true,
    });
    userSent(other, "Hi", T0 + 1000, "copy");
    expect(other.hasUserSentMessage(BOB)).toBe(false);
    other.deleteMessage(gone.id);
    expect(other.hasUserSentMessage(BOB)).toBe(true);
  });

  test("scope filters agree with keys.ts on short codes", () => {
    const store = open();
    const scope = { read: "all", hideCodes: true, ownHandles: [] } as const;
    for (const [key, short] of [
      ["tel:12345", true],
      ["tel:123456", true],
      ["tel:1234567", false],
      ["tel:+12345", false],
      ["sender:mybank", true],
      ["email:a@example.com", false],
      ["group:name:x", false],
    ] as const) {
      expect({ key, scoped: store.inAgentScope(key, scope) }).toEqual({ key, scoped: !short });
      expect(isShortCode(key)).toBe(short);
    }
  });
});

describe("hybrid logical clock", () => {
  test("never goes backwards, even when the wall clock does", () => {
    const wall = clock();
    const hlc = new HybridClock("a", wall.now);
    const first = hlc.now();
    wall.set(T0 - 60_000);
    const second = hlc.now();
    expect(compareHlc(second, first)).toBe(1);
    expect(parseHlc(second)).toEqual({ time: T0, counter: 1, origin: "a" });
  });

  test("orders local changes after values observed from another computer", () => {
    const remote = new HybridClock("b", () => T0 + 5000).now();
    const hlc = new HybridClock("a", () => T0);
    hlc.observe(remote);
    expect(compareHlc(hlc.now(), remote)).toBe(1);
  });

  test("the origin breaks ties, and the later write wins either way round", () => {
    const a = new HybridClock("a", () => T0).now();
    const b = new HybridClock("b", () => T0).now();
    expect(compareHlc(a, b)).toBe(-1);
    const local = { muted: true, updatedAt: a };
    const remote = { muted: false, updatedAt: b };
    expect(lastWriterWins(local, remote)).toBe(remote);
    expect(lastWriterWins(remote, local)).toBe(remote);
  });

  test("a counter overflow borrows the next millisecond", () => {
    const hlc = new HybridClock("a", () => T0, `${String(T0).padStart(15, "0")}-ffff-a`);
    expect(parseHlc(hlc.now())).toEqual({ time: T0 + 1, counter: 0, origin: "a" });
  });

  test("changes stamp origin, clock and change sequence; no-ops don't", () => {
    const wall = clock();
    const store = open(memoryDb(), wall.now);
    store.insertMessage(incoming());
    const before = row(store, "threads", "key = ?", [ALICE]);
    expect(before.origin).toBe(store.origin);

    wall.tick();
    expect(store.setThreadMuted(ALICE, true)).toBe(true);
    const after = row(store, "threads", "key = ?", [ALICE]);
    expect(compareHlc(after.updated_at as string, before.updated_at as string)).toBe(1);
    expect(after.change_seq).toBeGreaterThan(before.change_seq as number);
    expect(after.change_seq).toBe(store.changeSeq);

    store.setThreadMuted(ALICE, true);
    expect(row(store, "threads", "key = ?", [ALICE]).change_seq).toBe(after.change_seq);

    // A new message updates derived activity but doesn't stamp the thread over a mute.
    store.insertMessage(incoming({ mapHandle: "h2", body: "x", sentAt: T0 + 1000 }));
    expect(row(store, "threads", "key = ?", [ALICE]).updated_at).toBe(after.updated_at);

    const since = after.change_seq as number;
    const changed = store.db.query<{ id: string }>(
      "SELECT id FROM messages WHERE change_seq > ? ORDER BY change_seq",
      [since],
    );
    expect(changed).toHaveLength(1);
  });

  test("origin, clock and sequence survive a restart", () => {
    const db = memoryDb();
    const wall = clock();
    const first = open(db, wall.now);
    first.insertMessage(incoming());
    first.setThreadPinned(ALICE, true);
    const stamp = row(first, "threads", "key = ?", [ALICE]);

    wall.set(T0 - 3_600_000);
    const second = open(db, wall.now);
    expect(second.origin).toBe(first.origin);
    expect(second.changeSeq).toBe(first.changeSeq);
    second.setThreadPinned(ALICE, false);
    const restamped = row(second, "threads", "key = ?", [ALICE]);
    expect(compareHlc(restamped.updated_at as string, stamp.updated_at as string)).toBe(1);
    expect(restamped.change_seq).toBe((stamp.change_seq as number) + 1);
  });
});

describe("tombstones", () => {
  test("a deleted message is hidden from lists, lookups, search, unread and notifications", () => {
    const store = open();
    const keep = store.insertMessage(
      incoming({ body: "keep me", sentAt: T0 - 1000, mapHandle: "h0", notify: true }),
    ).message!;
    const gone = store.insertMessage(incoming({ body: "secret plans", notify: true })).message!;
    store.insertMessage(
      incoming({ mapHandle: "h2", body: "Liked", reactionKind: "like", reactionTo: gone.id }),
    );

    expect(store.deleteMessage(gone.id)).toBe(true);
    expect(store.getMessage(gone.id)).toBeNull();
    expect(store.findByMapHandle(PHONE, "0400000000000001")).toBeNull();
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([keep.id]);
    expect(store.search("secret")).toEqual([]);
    expect(store.search("liked")).toEqual([]);
    expect(store.getThread(ALICE)).toMatchObject({ unread: 1 });
    expect(store.getThread(ALICE)!.lastMessage!.id).toBe(keep.id);
    expect(store.pendingNotifications().map((m) => m.id)).toEqual([keep.id]);

    const tomb = row(store, "messages", "id = ?", [gone.id]);
    expect(tomb).toMatchObject({ body: "", origin: store.origin });
    expect(tomb.deleted_at).not.toBeNull();
    expect(tomb.change_seq).toBe(store.changeSeq);
  });

  test("a deleted message stays deleted when the phone lists it again", () => {
    const store = open();
    const m = store.insertMessage(incoming()).message!;
    store.deleteMessage(m.id);
    expect(store.insertMessage(incoming())).toEqual({ message: null, inserted: false });
    expect(
      store.insertMessage(incoming({ source: "ancs", mapHandle: null, device: null })),
    ).toEqual({
      message: null,
      inserted: false,
    });
    expect(store.listMessages(ALICE)).toEqual([]);
  });

  test("a deleted thread disappears with its messages, members and draft, and a new message revives it", () => {
    const store = open();
    store.insertMessage(incoming({ body: "old news" }));
    store.saveDraft(ALICE, "half-typed");
    expect(store.deleteThread(ALICE)).toBe(true);
    expect(store.getThread(ALICE)).toBeNull();
    expect(store.listThreads()).toEqual([]);
    expect(store.search("old")).toEqual([]);
    expect(store.getDraft(ALICE)).toBeNull();
    expect(row(store, "thread_members", "thread_key = ?", [ALICE]).deleted_at).not.toBeNull();

    store.insertMessage(incoming({ mapHandle: "h2", body: "new news", sentAt: T0 + 1000 }));
    const thread = store.getThread(ALICE)!;
    expect(thread.members).toEqual([ALICE]);
    expect(store.listMessages(ALICE).map((m) => m.body)).toEqual(["new news"]);
  });

  test("removing a member tombstones it and adding it back revives it", () => {
    const store = open();
    const group = "group:name:Climbing";
    store.ensureThread(group);
    store.setThreadMembers(group, [ALICE, BOB]);
    store.setThreadMembers(group, [BOB]);
    expect(store.getThread(group)!.members).toEqual([BOB]);
    expect(row(store, "thread_members", "handle = ?", [ALICE]).deleted_at).not.toBeNull();
    store.setThreadMembers(group, [ALICE, BOB]);
    expect(store.getThread(group)!.members).toEqual([ALICE, BOB]);
  });
});

describe("groups", () => {
  const GROUP = "group:name:weekend-trip";
  const CAROL = "email:carol@example.com";

  test("a notification records the group and its thread; repeating it writes nothing", () => {
    const store = open();
    const info = { named: true, name: "Weekend Trip", participants: [] };
    expect(store.recordGroup(GROUP, info)).toBe(true);
    expect(store.getGroup(GROUP)).toEqual({
      threadKey: GROUP,
      name: "Weekend Trip",
      named: true,
      participants: [],
      roster: null,
      routeInvalidated: false,
    });
    expect(store.getThread(GROUP)!.kind).toBe("group");
    const seq = store.changeSeq;
    expect(store.recordGroup(GROUP, info)).toBe(false);
    expect(store.changeSeq).toBe(seq);
    expect(() => store.recordGroup(ALICE, info)).toThrow(TincanError);
  });

  test("a roster becomes the members and survives a renamed notification", () => {
    const store = open();
    store.recordGroup(GROUP, { named: true, name: "Weekend Trip", participants: [] });
    const group = store.setGroupRoster(GROUP, [BOB, CAROL, BOB]);
    expect(group.roster).toEqual([BOB, CAROL]);
    expect(store.getThread(GROUP)!.members).toEqual([CAROL, BOB]);
    store.recordGroup(GROUP, { named: true, name: "Weekend trip!", participants: [] });
    expect(store.getGroup(GROUP)).toMatchObject({ name: "Weekend trip!", roster: [BOB, CAROL] });
    expect(store.setGroupRoster(GROUP, null).roster).toBeNull();
  });

  test("a roster entry that isn't a plain handle is refused", () => {
    const store = open();
    for (const bad of ["tel:+1555\r\nTEL:+15559999999", "Bob", "tel:", "email:not an address"]) {
      expect(() => store.setGroupRoster(GROUP, [bad])).toThrow(TincanError);
    }
    expect(store.getGroup(GROUP)).toBeNull();
  });

  test("a corrupt roster reads as empty, never as a partial list", () => {
    const store = open();
    store.setGroupRoster(GROUP, [BOB]);
    store.db.exec("UPDATE groups SET roster = '[\"tel:+1\", ' WHERE thread_key = ?", [GROUP]);
    expect(store.getGroup(GROUP)!.roster).toEqual([]);
    store.db.exec("UPDATE groups SET roster = ? WHERE thread_key = ?", [
      JSON.stringify([BOB, "TEL:\r\nx"]),
      GROUP,
    ]);
    expect(store.getGroup(GROUP)!.roster).toEqual([BOB]);
  });

  test("a sender off the roster flags the route, once, until the roster is saved again", () => {
    const store = open();
    store.setGroupRoster(GROUP, [BOB]);
    expect(store.noteGroupSender(GROUP, BOB)).toBe(false);
    expect(store.noteGroupSender(GROUP, ALICE)).toBe(true);
    expect(store.getGroup(GROUP)!.routeInvalidated).toBe(true);
    expect(store.getThread(GROUP)!.members).toEqual([ALICE, BOB]);
    expect(store.noteGroupSender(GROUP, ALICE)).toBe(false);
    expect(store.setGroupRoster(GROUP, [ALICE, BOB]).routeInvalidated).toBe(false);
  });

  test("without a roster a new sender just joins the members", () => {
    const store = open();
    store.recordGroup(GROUP, { named: true, name: "Weekend Trip", participants: [] });
    expect(store.noteGroupSender(GROUP, ALICE)).toBe(false);
    expect(store.getThread(GROUP)!.members).toEqual([ALICE]);
    expect(store.noteGroupSender("group:name:nope", ALICE)).toBe(false);
  });

  test("deleting a group forgets its roster but keeps the thread; seeing it again starts fresh", () => {
    const store = open();
    store.setGroupRoster(GROUP, [BOB]);
    expect(store.deleteGroup(GROUP)).toBe(true);
    expect(store.getGroup(GROUP)).toBeNull();
    expect(store.listGroups()).toEqual([]);
    expect(store.getThread(GROUP)).not.toBeNull();
    expect(store.deleteGroup(GROUP)).toBe(false);
    store.recordGroup(GROUP, { named: true, name: "Weekend Trip", participants: [] });
    expect(store.getGroup(GROUP)!.roster).toBeNull();
  });

  test("an unnamed group is called by its members; a title the user sets wins", () => {
    const store = open();
    const family = "group:members:aunt-kate+aunt-nel+nana+uncle-jay";
    const people = ["Aunt Kate", "Aunt Nel", "Nana", "Uncle Jay"];
    store.recordGroup(family, { named: false, name: null, participants: people });
    expect(store.getThread(family)!.title).toBe("Aunt Kate, Aunt Nel, Nana, Uncle Jay");
    store.setThreadTitle(family, "Family");
    expect(store.getThread(family)!.title).toBe("Family");
    store.setThreadTitle(family, null);
    expect(store.getThread(family)!.title).toBe("Aunt Kate, Aunt Nel, Nana, Uncle Jay");
    const bare = "group:members:alice-smith+bob";
    store.ensureThread(bare, "group");
    expect(store.getThread(bare)!.title).toBe("Alice Smith, Bob");
  });

  test("lists live groups, most recent activity first", () => {
    const store = open();
    const other = "group:members:alice+bob";
    store.recordGroup(GROUP, { named: true, name: "Weekend Trip", participants: [] });
    store.recordGroup(other, { named: false, name: null, participants: ["Alice", "Bob"] });
    store.insertMessage(incoming({ threadKey: other, sentAt: T0 + 5000 }));
    store.insertMessage(incoming({ threadKey: GROUP, mapHandle: "h2" }));
    expect(store.listGroups().map((g) => g.threadKey)).toEqual([other, GROUP]);
    store.deleteThread(other);
    expect(store.listGroups().map((g) => g.threadKey)).toEqual([GROUP]);
  });
});

describe("moving and reactions", () => {
  const GROUP = "group:members:bob";

  test("moving a message out of a conversation hides it once empty", () => {
    const store = open();
    const first = store.insertMessage(incoming()).message!;
    const second = store.insertMessage(incoming({ mapHandle: "h2", body: "again" })).message!;
    const visible = () => store.listThreads().map((t) => t.key);
    expect(store.moveMessage(first.id, GROUP, "group")).toBe(true);
    expect(visible()).toContain(ALICE);
    expect(store.moveMessage(second.id, GROUP, "group")).toBe(true);
    expect(visible()).toEqual([GROUP]);
    expect(store.getMessage(first.id)!.id).toBe(first.id);
    expect(store.listMessages(GROUP).map((m) => m.id)).toEqual([second.id, first.id]);
    expect(store.getThread(GROUP)!.kind).toBe("group");
  });

  test("attaches a tapback it couldn't place to its target, in the target's thread", () => {
    const store = open();
    const target = store.insertMessage(
      incoming({ threadKey: GROUP, sender: BOB, body: "pack light", mapHandle: "h1" }),
    ).message!;
    const tapback = store.insertMessage(
      incoming({ body: "Laughed at “pack light”", mapHandle: "h2", reactionKind: "laugh" }),
    ).message!;
    const plain = store.insertMessage(incoming({ body: "hi", mapHandle: "h3" })).message!;
    expect(store.attachReaction(plain.id, target.id)).toBe(false);
    expect(store.attachReaction(tapback.id, tapback.id)).toBe(false);
    expect(store.attachReaction(tapback.id, target.id)).toBe(true);
    expect(store.attachReaction(tapback.id, target.id)).toBe(false);
    expect(store.getMessage(tapback.id)).toMatchObject({ threadKey: GROUP, reactionTo: target.id });
    expect(store.listMessages(GROUP).map((m) => m.id)).toEqual([target.id]);
    expect(store.getMessage(target.id)!.reactions).toEqual([
      { kind: "laugh", from: ALICE, text: "Laughed at “pack light”" },
    ]);
  });

  test("finds what a tapback quotes: exact, cut short, or in the sender's group", () => {
    const store = open();
    const mine = store.insertMessage(
      incoming({
        direction: "outgoing",
        sender: null,
        body: "dinner at seven?",
        mapHandle: "h1",
        status: "sent",
      }),
    ).message!;
    store.insertMessage(incoming({ body: "later one", mapHandle: "h2", sentAt: T0 + 10_000 }));
    const find = (text: string, before = T0 + 60_000) =>
      store.findReactionTarget({ threadKey: ALICE, sender: ALICE, text, before })?.id ?? null;
    expect(find("dinner at seven?")).toBe(mine.id);
    expect(find("dinner at…")).toBe(mine.id);
    expect(find("dinner at")).toBeNull();
    expect(find("…")).toBeNull();
    expect(find("later one", T0)).toBeNull();

    const inGroup = store.insertMessage(
      incoming({ threadKey: GROUP, sender: BOB, body: "group text", mapHandle: "h3" }),
    ).message!;
    store.recordGroup(GROUP, { named: false, name: null, participants: ["Bob"] });
    store.noteGroupSender(GROUP, ALICE);
    expect(find("group text")).toBe(inGroup.id);
  });

  test("a tapback folds into its target, and removing it takes only that sender's", () => {
    const store = open();
    const target = store.insertMessage(incoming({ body: "ok" })).message!;
    const love = (sender: string, handle: string) =>
      store.insertMessage(
        incoming({
          sender,
          body: "Loved “ok”",
          mapHandle: handle,
          reactionKind: "love",
          reactionTo: target.id,
        }),
      ).message!;
    const fromAlice = love(ALICE, "h2");
    love(BOB, "h3");
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([target.id]);
    expect(store.getMessage(target.id)!.reactions.map((r) => r.from)).toEqual([ALICE, BOB]);
    expect(store.getMessage(fromAlice.id)).toMatchObject({
      reaction: "love",
      reactionTo: target.id,
    });

    expect(store.removeReaction(target.id, ALICE, "like")).toBeNull();
    expect(store.removeReaction(target.id, ALICE, "love")).toBe(fromAlice.id);
    expect(store.getMessage(target.id)!.reactions.map((r) => r.from)).toEqual([BOB]);
    expect(store.removeReaction(target.id, ALICE, "love")).toBeNull();
  });
});

describe("placing tapbacks", () => {
  test("files a named tapback with the message it quotes", () => {
    const store = open();
    const target = store.insertMessage(incoming({ body: "see you soon" })).message!;
    const tapback = store.insertMessage(
      incoming({ body: "Kaia liked “see you soon”", mapHandle: "h2", sentAt: T0 + 1000 }),
    ).message!;
    expect(store.placeTapback(tapback.id)).toEqual({
      target: expect.objectContaining({ id: target.id }),
      removed: false,
    });
    expect(store.getMessage(tapback.id)).toMatchObject({ reaction: "like", reactionTo: target.id });
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([target.id]);
    expect(store.placeTapback(target.id)).toBeNull();
  });

  test("a tapback whose message Tincan lacks stays unplaced until the message arrives", () => {
    const store = open();
    const tapback = store.insertMessage(
      incoming({ body: "Loved “from the phone”", mapHandle: "h1", sentAt: T0 + 5000 }),
    ).message!;
    expect(store.placeTapback(tapback.id)).toEqual({ target: null, removed: false });
    expect(store.getMessage(tapback.id)).toMatchObject({ reaction: "love" });
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([tapback.id]);

    // Arrives later (a backup import), older than the tapback.
    const late = store.insertMessage(
      incoming({ body: "from the phone", mapHandle: null, source: "local", sentAt: T0 }),
    ).message!;
    expect(store.getMessage(tapback.id)!.reactionTo).toBe(late.id);
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([late.id]);
    expect(store.getMessage(late.id)!.reactions.map((r) => r.kind)).toEqual(["love"]);
  });

  test("a message newer than the tapback isn't adopted", () => {
    const store = open();
    const tapback = store.insertMessage(
      incoming({ body: "Liked “ok”", mapHandle: "h1", reactionKind: "like" }),
    ).message!;
    store.insertMessage(incoming({ body: "ok", mapHandle: "h2", sentAt: T0 + 1000 }));
    expect(store.getMessage(tapback.id)!.reactionTo).toBeUndefined();
  });

  test("removing a tapback Tincan couldn't place tombstones both", () => {
    const store = open();
    const added = store.insertMessage(
      incoming({ body: "Loved “gone”", mapHandle: "h1", sentAt: T0 }),
    ).message!;
    store.placeTapback(added.id);
    const removal = store.insertMessage(
      incoming({ body: "Removed a heart from “gone”", mapHandle: "h2", sentAt: T0 + 1000 }),
    ).message!;
    expect(store.placeTapback(removal.id)).toEqual({ target: null, removed: true });
    expect(store.getMessage(added.id)).toBeNull();
    expect(store.getMessage(removal.id)).toBeNull();
    expect(store.listMessages(ALICE)).toEqual([]);
  });

  test("removing a placed tapback takes it off its target", () => {
    const store = open();
    const target = store.insertMessage(incoming({ body: "ok" })).message!;
    const added = store.insertMessage(
      incoming({ body: "Kaia loved “ok”", mapHandle: "h2", sentAt: T0 + 1 }),
    ).message!;
    store.placeTapback(added.id);
    const removal = store.insertMessage(
      incoming({ body: "Kaia removed a heart from “ok”", mapHandle: "h3", sentAt: T0 + 2 }),
    ).message!;
    expect(store.placeTapback(removal.id)!.removed).toBe(true);
    expect(store.getMessage(target.id)!.reactions).toEqual([]);
    expect(store.listMessages(ALICE).map((m) => m.id)).toEqual([target.id]);
  });

  test("reparsing on open turns stored tapback text into tapbacks", () => {
    const db = memoryDb();
    const first = open(db);
    const target = first.insertMessage(incoming({ body: "Nana arrived" })).message!;
    const text = first.insertMessage(
      incoming({ body: "Kaia liked “Nana arrived”", mapHandle: "h2", sentAt: T0 + 1 }),
    ).message!;
    // What an older Tincan stored: plain text.
    first.db.exec("UPDATE messages SET reaction_kind = NULL, reaction_to = NULL WHERE id = ?", [
      text.id,
    ]);
    expect(first.listMessages(ALICE)).toHaveLength(2);
    const reopened = open(db);
    expect(reopened.getMessage(text.id)).toMatchObject({ reaction: "like", reactionTo: target.id });
    expect(reopened.reparseTapbacks()).toBe(0);
  });
});

describe("contacts", () => {
  const ada: ContactInput = {
    id: "ada",
    name: "Ada Lovelace",
    favorite: false,
    handles: [
      { handle: ALICE, label: "cell" },
      { handle: "email:ada@example.com", label: "home" },
    ],
  };
  const grace: ContactInput = {
    id: "grace",
    name: "Grace Hopper",
    favorite: true,
    handles: [{ handle: BOB, label: null }],
  };

  test("ids are stable, ignore address order and count identical cards", () => {
    const card = {
      device: PHONE,
      name: "Ada",
      tels: ["(206) 555-0101", "+1 206 555 0102"],
      emails: [],
    };
    const id = phoneContactId(card, 0);
    expect(phoneContactId({ ...card, device: PHONE.toUpperCase() }, 0)).toBe(id);
    expect(phoneContactId({ ...card, tels: [...card.tels].reverse() }, 0)).toBe(id);
    expect(phoneContactId(card, 1)).not.toBe(id);
    expect(phoneContactId({ ...card, name: "Ada L" }, 0)).not.toBe(id);
  });

  test("mirrors the phone, names threads and finds contacts", () => {
    const store = open();
    store.insertMessage(incoming());
    const first = store.replaceContacts([ada, grace]);
    expect(first.changed.sort()).toEqual(["ada", "grace"]);
    expect(first.handles).toContain(ALICE);
    expect(store.getThread(ALICE)?.title).toBe("Ada Lovelace");
    expect(store.listContacts().map((c) => c.name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
    expect(store.listContacts({ favoritesOnly: true }).map((c) => c.id)).toEqual(["grace"]);
    expect(store.getContact("ada")).toEqual({
      id: "ada",
      name: "Ada Lovelace",
      handles: ["email:ada@example.com", ALICE],
      hasPhoto: false,
      labels: { "email:ada@example.com": "home", [ALICE]: "cell" },
    });
    expect(store.contactForHandle(BOB)?.id).toBe("grace");
    expect(store.searchContacts("love").map((c) => c.id)).toEqual(["ada"]);
    expect(store.searchContacts("hopper grace").map((c) => c.id)).toEqual(["grace"]);
    expect(store.searchContacts("ada@ex").map((c) => c.id)).toEqual(["ada"]);
    expect(store.searchContacts("(206) 555-0102").map((c) => c.id)).toEqual(["grace"]);
    expect(store.searchContacts("%").map((c) => c.id)).toEqual([]);
  });

  test("keeps the card's details and notices when they change", () => {
    const store = open();
    const details = {
      company: "Analytical Engines",
      jobTitle: "",
      addresses: [{ label: "home", value: "12 St James\nLondon" }],
      urls: [],
    };
    store.replaceContacts([{ ...ada, details }]);
    expect(store.getContact("ada")?.details).toEqual({
      company: "Analytical Engines",
      addresses: [{ label: "home", value: "12 St James\nLondon" }],
    });
    expect(store.getContact("grace")?.details).toBeUndefined();
    expect(store.replaceContacts([{ ...ada, details }]).changed).toEqual([]);
    expect(
      store.replaceContacts([{ ...ada, details: { ...details, nickname: "Ada" } }]).changed,
    ).toEqual(["ada"]);
    expect(store.getContact("ada")?.details?.nickname).toBe("Ada");
  });

  test("an unchanged pull writes nothing", () => {
    const store = open();
    store.replaceContacts([ada, grace]);
    const seq = store.changeSeq;
    expect(store.replaceContacts([ada, grace])).toEqual({ changed: [], removed: [], handles: [] });
    expect(store.changeSeq).toBe(seq);
  });

  test("contacts and handles the phone dropped are tombstoned, and revived if they return", () => {
    const store = open();
    store.insertMessage(incoming());
    store.replaceContacts([ada, grace]);
    store.setContactPhoto("ada", "abc.jpg");

    const edited = store.replaceContacts([{ ...ada, handles: [ada.handles[1]!] }]);
    expect(edited).toEqual({ changed: ["ada"], removed: ["grace"], handles: expect.any(Array) });
    expect(edited.handles.sort()).toEqual([BOB, "email:ada@example.com", ALICE].sort());
    expect(row(store, "contacts", "id = ?", ["grace"]).deleted_at).not.toBeNull();
    expect(
      row(store, "handles", "contact_id = ? AND handle = ?", ["ada", ALICE]).deleted_at,
    ).not.toBeNull();
    expect(store.getContact("grace")).toBeNull();
    expect(store.contactForHandle(ALICE)).toBeNull();
    expect(store.searchContacts("grace")).toEqual([]);
    expect(store.getThread(ALICE)?.title).toBe("+12065550101");
    expect(store.contactPhotos()).toEqual(new Set(["abc.jpg"]));

    store.replaceContacts([ada, grace]);
    expect(store.getContact("grace")?.handles).toEqual([BOB]);
    expect(store.contactForHandle(ALICE)?.id).toBe("ada");
  });

  test("photos are set once and count toward hasPhoto", () => {
    const store = open();
    store.replaceContacts([ada]);
    expect(store.setContactPhoto("ada", "abc.jpg")).toBe(true);
    expect(store.setContactPhoto("ada", "abc.jpg")).toBe(false);
    expect(store.setContactPhoto("nobody", "abc.jpg")).toBe(false);
    expect(store.getContact("ada")?.hasPhoto).toBe(true);
    expect(store.contactPhoto("ada")).toBe("abc.jpg");
  });

  test("photo bytes are kept once in the store, read back, and pruned when unused", () => {
    const store = open();
    store.replaceContacts([ada, grace]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
    expect(store.putContactPhoto("abc.jpg", "image/jpeg", jpeg)).toBe(true);
    store.setContactPhoto("ada", "abc.jpg");
    store.setContactPhoto("grace", "abc.jpg");
    const read = store.getContactPhoto("ada");
    expect(read?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(read!.data)).toEqual(jpeg);
    expect(store.getContactPhoto("grace")?.mediaType).toBe("image/jpeg");
    expect(store.getContactPhoto("nobody")).toBeNull();

    // An unchanged photo writes nothing.
    const total = () => store.db.query<{ n: number }>("SELECT total_changes() AS n")[0]!.n;
    const before = total();
    expect(store.putContactPhoto("abc.jpg", "image/jpeg", jpeg)).toBe(false);
    expect(store.pruneContactPhotos()).toBe(0);
    expect(total()).toBe(before);

    // Grace's card is dropped; Ada still uses the photo.
    store.replaceContacts([ada]);
    expect(store.hasContactPhoto("abc.jpg")).toBe(true);
    // Ada's photo is cleared, so it goes with the next prune: ...
    store.setContactPhoto("ada", null);
    expect(store.getContactPhoto("ada")).toBeNull();
    expect(store.pruneContactPhotos()).toBe(1);
    expect(store.hasContactPhoto("abc.jpg")).toBe(false);

    // ... and at the end of the next replace, when only a removed contact used it.
    store.putContactPhoto("def.jpg", "image/jpeg", jpeg);
    store.setContactPhoto("ada", "def.jpg");
    store.replaceContacts([grace]);
    expect(store.hasContactPhoto("def.jpg")).toBe(false);
    expect(store.db.query("SELECT name FROM contact_photos")).toEqual([]);
  });
});

describe("notifications", () => {
  test("only live arrivals wait for a notification", () => {
    const store = open();
    const live = store.insertMessage(incoming({ notify: true })).message!;
    store.insertMessage(incoming({ mapHandle: "h2", body: "catch-up" }));
    expect(store.pendingNotifications().map((m) => m.id)).toEqual([live.id]);
    store.markNotified(live.id);
    expect(store.pendingNotifications()).toEqual([]);
  });
});

describe("drafts", () => {
  test("save, replace and clear", () => {
    const store = open();
    store.saveDraft(ALICE, "a");
    store.saveDraft(ALICE, "b");
    expect(store.getDraft(ALICE)).toBe("b");
    store.saveDraft(ALICE, "");
    expect(store.getDraft(ALICE)).toBeNull();
  });
});

describe("sync bookkeeping", () => {
  test("map handle state includes tombstones; last message time ignores them", () => {
    const store = open();
    expect(store.mapHandleState(PHONE, "0400000000000001")).toBeNull();
    expect(store.lastMessageAt(PHONE)).toBeNull();
    const { message } = store.insertMessage(incoming());
    store.insertMessage(
      incoming({ mapHandle: "0400000000000002", body: "later", sentAt: T0 + 5000 }),
    );
    expect(store.mapHandleState(PHONE.toUpperCase(), "0400000000000001")).toEqual({
      id: message!.id,
      threadKey: ALICE,
      read: false,
      deleted: false,
    });
    expect(store.lastMessageAt(PHONE)).toBe(T0 + 5000);

    const later = store.findByMapHandle(PHONE, "0400000000000002")!;
    store.deleteMessage(later.id);
    expect(store.mapHandleState(PHONE, "0400000000000002")).toMatchObject({ deleted: true });
    expect(store.lastMessageAt(PHONE)).toBe(T0);
  });

  test("sync state round-trips per device and folder", () => {
    const store = open();
    expect(store.getSyncState(PHONE, "inbox")).toBeNull();
    store.setSyncState(PHONE, "inbox", { lastSyncAt: T0, lastListing: { a: true, b: false } });
    store.setSyncState(PHONE, "inbox", { lastSyncAt: T0 + 1, lastListing: { c: false } });
    expect(store.getSyncState(PHONE.toUpperCase(), "inbox")).toEqual({
      lastSyncAt: T0 + 1,
      lastListing: { c: false },
    });
    expect(store.getSyncState(PHONE, "sent")).toBeNull();
  });

  test("gaps: record, filter by thread, resolve", () => {
    const now = clock();
    const store = open(memoryDb(), now.now);
    const all = store.recordGap({ device: PHONE, threadKey: null, fromAt: T0 - 50, toAt: T0 });
    const bob = store.recordGap({ device: PHONE, threadKey: BOB, fromAt: T0 - 100, toAt: T0 });
    expect(store.openGaps().map((g) => g.id)).toEqual([bob, all]);
    expect(store.openGaps(ALICE)).toEqual([
      {
        id: all,
        device: PHONE.toUpperCase(),
        threadKey: null,
        fromAt: T0 - 50,
        toAt: T0,
        detectedAt: T0,
      },
    ]);
    expect(store.resolveGap(all)).toBe(true);
    expect(store.resolveGap(all)).toBe(false);
    expect(store.openGaps(ALICE)).toEqual([]);
    expect(store.openGaps(BOB).map((g) => g.id)).toEqual([bob]);
  });
});

describe("outbox", () => {
  test("queues a local pending message and tracks attempts until sent", () => {
    const c = clock();
    const store = open(memoryDb(), c.now);
    const message = store.queueOutgoing({
      threadKey: ALICE,
      body: "hi",
      recipients: ["+12065550101"],
    });
    expect(message).toMatchObject({
      threadKey: ALICE,
      direction: "outgoing",
      source: "local",
      status: "pending",
      read: true,
      sentAt: T0,
    });
    expect(store.outboxEntries("pending")).toEqual([
      {
        messageId: message.id,
        recipients: ["+12065550101"],
        attempts: 0,
        lastError: null,
        pushingSince: null,
        updatedAt: T0,
        sendAt: null,
        agentDraftId: null,
      },
    ]);

    c.tick(10);
    store.beginSendAttempt(message.id);
    expect(store.outboxEntry(message.id)).toMatchObject({ attempts: 1, pushingSince: T0 + 10 });
    store.finishSendAttempt(message.id, "failed", "INTERNAL");
    expect(store.getMessage(message.id)?.status).toBe("failed");
    expect(store.outboxEntry(message.id)).toMatchObject({
      lastError: "INTERNAL",
      pushingSince: null,
    });
    expect(store.outboxEntries("pending")).toEqual([]);

    store.requeueOutgoing(message.id);
    expect(store.outboxEntry(message.id)).toMatchObject({ attempts: 1, lastError: null });
    store.beginSendAttempt(message.id);
    store.finishSendAttempt(message.id, "sent");
    expect(store.getMessage(message.id)?.status).toBe("sent");
    expect(store.outboxEntry(message.id)).toBeNull();
  });

  test("identical sends stay separate and deleting one drops its outbox entry", () => {
    const store = open();
    const a = store.queueOutgoing({ threadKey: ALICE, body: "ok", recipients: ["+12065550101"] });
    const b = store.queueOutgoing({ threadKey: ALICE, body: "ok", recipients: ["+12065550101"] });
    expect(a.id).not.toBe(b.id);
    store.deleteMessage(a.id);
    expect(store.outboxEntries().map((e) => e.messageId)).toEqual([b.id]);
    expect(row(store, "outbox", "message_id = ?", [a.id])).toBeUndefined();
  });
});

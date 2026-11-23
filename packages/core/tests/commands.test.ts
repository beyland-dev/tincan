import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  TincanError,
  type ClientInfo,
  type TincanEvent,
  type Message,
} from "@beyland/tincan-protocol";
import {
  Core,
  Store,
  nodeSqliteDb,
  type ContactInput,
  type NewMessage,
  type ReadChange,
  type SendOptions,
} from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "test" };
const mcp: ClientInfo = { kind: "mcp", name: "agent" };
const PHONE = "aa:bb:cc:dd:ee:ff";
const ALICE = "tel:+12065550101";
const ALICE_WORK = "email:alice@example.com";
const BOB = "tel:+12065550102";
const GROUP = "group:name:book-club";
const T0 = 1_780_000_000_000;

let t = T0;
let store: Store;
let core: Core;
let events: TincanEvent[];

beforeEach(async () => {
  t = T0;
  store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => t });
  core = await Core.open({ version: "1.0.0", store, now: () => t });
  events = [];
  core.events.subscribe((e) => events.push(e));
});

let handle = 0;
function incoming(overrides: Partial<NewMessage> = {}): Message {
  handle++;
  const { message } = store.insertMessage({
    threadKey: ALICE,
    direction: "incoming",
    sender: ALICE,
    body: "hello there",
    sentAt: t,
    receivedAt: t,
    source: "map",
    status: "received",
    read: false,
    device: PHONE,
    mapHandle: `04000000000000${String(handle).padStart(2, "0")}`,
    folder: "inbox",
    ...overrides,
  });
  if (!message) throw new Error("not inserted");
  return message;
}

/** A message the user sent themselves (from the phone). */
function outgoing(overrides: Partial<NewMessage> = {}): Message {
  return incoming({
    direction: "outgoing",
    sender: null,
    body: "from me",
    status: "sent",
    read: true,
    folder: "sent",
    ...overrides,
  });
}

function contact(id: string, name: string, handles: string[]): ContactInput {
  return { id, name, favorite: false, handles: handles.map((h) => ({ handle: h, label: null })) };
}

async function errorOf(promise: Promise<unknown>): Promise<TincanError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TincanError) return error;
    throw error;
  }
  throw new Error("Expected a TincanError");
}

function fakeOutbox() {
  const sent: Array<{ key: string; body: string }> = [];
  return {
    sent,
    outbox: stubOutbox(async (key, body, options) => {
      sent.push({ key, body });
      return store.queueOutgoing({
        threadKey: key,
        body,
        recipients: [key],
        agent: options?.agent,
        agentDraftId: options?.agentDraftId,
      });
    }),
  };
}

/** An outbox that hands sends to `send` and supports nothing else. */
function stubOutbox(send: (key: string, body: string, options?: SendOptions) => Promise<Message>) {
  return {
    send,
    retry: async (id: string) => store.getMessage(id)!,
    cancel: (): never => {
      throw new TincanError("CONFLICT", "Already sending");
    },
    sendNow: async (id: string) => store.getMessage(id)!,
    dropThread: () => {},
  };
}

describe("without a phone", () => {
  test("store commands work; phone commands fail with NOT_CONNECTED", async () => {
    incoming();
    expect((await core.call("thread.list", {}, cli)).map((th) => th.key)).toEqual([ALICE]);
    for (const [name, input] of [
      ["message.send", { to: ALICE, text: "hi" }],
      ["sync.now", {}],
      ["contact.sync", {}],
    ] as const) {
      expect((await errorOf(core.run(name, input, cli))).code).toBe("NOT_CONNECTED");
    }
  });

  test("sync.status reports everything off", async () => {
    expect(await core.call("sync.status", {}, cli)).toEqual({
      messages: { state: "off", syncing: false, lastSyncAt: null },
      contacts: { state: "off", lastSyncAt: null },
      notifications: { state: "off" },
    });
  });

  test("a Core without a store fails store commands with INTERNAL", async () => {
    const bare = await Core.open({ version: "1.0.0" });
    expect((await errorOf(bare.call("thread.list", {}, cli))).code).toBe("INTERNAL");
  });
});

describe("thread commands", () => {
  test("get accepts the key as typed, with group and draft", async () => {
    incoming();
    store.saveDraft(ALICE, "half-written");
    const got = await core.call("thread.get", { key: "tel:(206) 555-0101" }, cli);
    expect(got.thread.key).toBe(ALICE);
    expect(got).toMatchObject({ group: null, draft: "half-written" });
    expect((await errorOf(core.call("thread.get", { key: BOB }, cli))).code).toBe("NOT_FOUND");
  });

  test("markRead marks in the store, then on the phone, and emits", async () => {
    const a = incoming();
    const b = incoming({ body: "second" });
    const mirrored: ReadChange[][] = [];
    core.attach({
      sync: {
        status: {
          link: { kind: "stopped" },
          syncing: false,
          lastSyncAt: null,
          lastError: null,
          failures: 0,
        },
        sync: async () => null,
        trigger: () => {},
        markReadOnPhone: async (changes) => {
          mirrored.push([...changes]);
          return changes.length;
        },
      },
    });
    expect(await core.call("thread.markRead", { key: ALICE }, cli)).toEqual({
      marked: 2,
      onPhone: 2,
    });
    expect(mirrored[0]!.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.getThread(ALICE)?.unread).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["message.changed", "thread.changed"]);
    expect(await core.call("thread.markRead", { key: ALICE }, cli)).toEqual({
      marked: 0,
      onPhone: 0,
    });
  });

  test("hiding from agents, mute and pin report whether they changed", async () => {
    incoming();
    const hidden = await core.call("agents.hide", { handle: ALICE }, cli);
    expect(hidden).toMatchObject({ changed: true, group: null, requeued: 0 });
    // Hidden from agents, it stays in the list.
    const all = await core.call("thread.list", {}, cli);
    expect(all[0]).toMatchObject({ key: ALICE, hiddenFromAgents: true, pinned: false });
    expect((await core.call("agents.hide", { handle: ALICE }, cli)).changed).toBe(false);
    expect((await core.call("agents.show", { personId: hidden.person!.id }, cli)).changed).toBe(
      true,
    );
    await core.call("thread.mute", { key: ALICE }, cli);
    await core.call("thread.pin", { key: ALICE }, cli);
    expect(store.getThread(ALICE)).toMatchObject({
      muted: true,
      pinned: true,
      hiddenFromAgents: false,
    });
    expect(events.filter((e) => e.event === "thread.changed").length).toBe(4);
  });

  test("delete removes a conversation from Tincan", async () => {
    incoming();
    expect(await core.call("thread.delete", { key: ALICE }, cli)).toEqual({
      key: ALICE,
      deleted: true,
    });
    expect(await core.call("thread.list", {}, cli)).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(["thread.changed", "message.changed"]);
    expect((await errorOf(core.call("thread.delete", { key: ALICE }, cli))).code).toBe("NOT_FOUND");
  });
});

describe("message commands", () => {
  test("list and search", async () => {
    incoming({ body: "lunch tomorrow?" });
    t += 1000;
    incoming({ body: "never mind" });
    const list = await core.call("message.list", { threadKey: ALICE }, cli);
    expect(list.map((m) => m.body)).toEqual(["never mind", "lunch tomorrow?"]);
    const found = await core.call("message.search", { query: "lunch" }, cli);
    expect(found.map((m) => m.body)).toEqual(["lunch tomorrow?"]);
    expect(await core.call("message.search", { query: "lunch", threadKey: BOB }, cli)).toEqual([]);
  });

  test("delete removes messages from Tincan and announces their thread", async () => {
    const first = incoming({ body: "spam" });
    t += 1000;
    incoming({ body: "keep" });
    events.length = 0;
    expect(await core.call("message.delete", { ids: [first.id, "nope"] }, cli)).toEqual({
      deleted: [first.id],
    });
    const list = await core.call("message.list", { threadKey: ALICE }, cli);
    expect(list.map((m) => m.body)).toEqual(["keep"]);
    expect(events.map((e) => e.event)).toEqual(["message.changed", "thread.changed"]);
    expect(await core.call("message.delete", { ids: [first.id] }, cli)).toEqual({ deleted: [] });
  });

  test("drafts save and clear", async () => {
    expect(await core.call("message.draft.save", { threadKey: ALICE, text: "draft" }, cli)).toEqual(
      { threadKey: ALICE, saved: true, deleted: false },
    );
    expect(store.getDraft(ALICE)).toBe("draft");
    expect(await core.call("message.draft.save", { threadKey: ALICE, text: "" }, cli)).toEqual({
      threadKey: ALICE,
      saved: false,
      deleted: true,
    });
    expect(store.getDraft(ALICE)).toBeNull();
  });

  test("your own draft to someone with no conversation yet reads back", async () => {
    const NEW = "tel:+12065550199";
    expect(await core.call("message.draft.list", {}, cli)).toEqual([]);
    expect(
      await core.call("message.draft.save", { to: "(206) 555-0199", text: "See you there" }, cli),
    ).toEqual({ threadKey: NEW, saved: true, deleted: false });
    expect(events.at(-1)).toMatchObject({ event: "thread.changed", data: { keys: [NEW] } });
    t += 1000;
    await core.call("message.draft.save", { to: BOB, text: "Later" }, cli);
    // A conversation's draft comes with the conversation, not here.
    await core.call("message.draft.save", { threadKey: ALICE, text: "Hi Alice" }, cli);
    incoming();
    expect(await core.call("message.draft.list", {}, cli)).toEqual([
      { to: BOB, text: "Later", updatedAt: t },
      { to: NEW, text: "See you there", updatedAt: t - 1000 },
    ]);
    expect(await core.call("message.draft.list", { limit: 1 }, cli)).toHaveLength(1);

    // Once there's a conversation, it's the conversation's draft.
    incoming({ threadKey: BOB, sender: BOB });
    expect((await core.call("message.draft.list", {}, cli)).map((d) => d.to)).toEqual([NEW]);
    expect((await core.call("thread.get", { key: BOB }, cli)).draft).toBe("Later");

    // Empty text deletes it; only somewhere Tincan can send to takes one.
    await core.call("message.draft.save", { to: NEW, text: "" }, cli);
    expect((await core.call("message.draft.list", {}, cli)).map((d) => d.to)).toEqual([]);
    await expect(
      core.call("message.draft.save", { to: "group:name:nowhere", text: "x" }, cli),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // It's yours alone: agents can't list it.
    await expect(core.call("message.draft.list", {}, mcp)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  test("a failed send says why, and an agent sees why only on its own messages", async () => {
    await core.call(
      "settings.set",
      { agents: { access: "full", read: "all", send: "approve", handles: "visible" } },
      cli,
    );
    incoming();
    const queue = (body: string, agent?: string) => {
      const message = store.queueOutgoing({
        threadKey: ALICE,
        body,
        recipients: [ALICE],
        ...(agent ? { byAgent: true, agent: { name: agent, edited: false, via: "policy" } } : {}),
      });
      t += 1000;
      return message.id;
    };
    const mine = queue("Mine");
    const own = queue("The agent's", "agent");
    const other = queue("Another agent's", "Other agent");
    store.finishSendAttempt(mine, "failed", "PAUSED");
    store.finishSendAttempt(own, "failed", "NOT_CONNECTED");
    store.finishSendAttempt(other, "failed", "NOT_CONNECTED");
    const pending = queue("Still going");

    const byId = (list: Message[]) => new Map(list.map((m) => [m.id, m]));
    const forUser = byId(await core.call("message.list", { threadKey: ALICE }, cli));
    expect(forUser.get(mine)?.failure).toEqual({ code: "PAUSED" });
    expect(forUser.get(own)?.failure).toEqual({ code: "NOT_CONNECTED" });
    expect(forUser.get(pending)).not.toHaveProperty("failure");

    const forAgent = byId(await core.call("message.list", { threadKey: ALICE }, mcp));
    expect(forAgent.get(mine)).not.toHaveProperty("failure");
    expect(forAgent.get(own)?.failure).toEqual({ code: "NOT_CONNECTED" });
    expect(forAgent.get(other)).not.toHaveProperty("failure");
    expect(forAgent.get(own)?.agent).toEqual({ edited: false, via: "policy" });

    // Retrying clears it.
    store.requeueOutgoing(mine);
    expect(store.getMessage(mine)).not.toHaveProperty("failure");
  });

  describe("send resolves the recipient", () => {
    let sent: Array<{ key: string; body: string }>;
    beforeEach(() => {
      const fake = fakeOutbox();
      sent = fake.sent;
      core.attach({ outbox: fake.outbox });
      store.replaceContacts([
        contact("alice", "Alice Smith", [ALICE, ALICE_WORK]),
        contact("bob", "Bob Jones", [BOB]),
        contact("bobby", "Bobby Tables", ["tel:+12065550103"]),
        contact("carol", "Carol", []),
      ]);
    });

    test("thread keys, numbers and email addresses", async () => {
      for (const to of [ALICE, "tel:2065550101", "(206) 555-0101", "Alice@Example.com"]) {
        await core.call("message.send", { to, text: "hi" }, cli);
      }
      expect(sent.map((s) => s.key)).toEqual([ALICE, ALICE, ALICE, ALICE_WORK]);
    });

    test("a contact name, exact match first", async () => {
      await core.call("message.send", { to: "bob jones", text: "hi" }, cli);
      expect(sent.at(-1)?.key).toBe(BOB);
      // "Bob" matches both Bob and Bobby.
      const ambiguous = await errorOf(core.call("message.send", { to: "bob", text: "hi" }, cli));
      expect(ambiguous.code).toBe("INVALID_INPUT");
      expect(ambiguous.message).not.toMatch(/bob/i);
      expect((await errorOf(core.call("message.send", { to: "Zed", text: "x" }, cli))).code).toBe(
        "NOT_FOUND",
      );
      expect((await errorOf(core.call("message.send", { to: "Carol", text: "x" }, cli))).code).toBe(
        "INVALID_INPUT",
      );
    });

    test("a contact with several handles: the active conversation, else ask", async () => {
      const error = await errorOf(core.call("message.send", { to: "Alice", text: "x" }, cli));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("2 numbers or addresses");
      incoming({ threadKey: ALICE_WORK, sender: ALICE_WORK });
      await core.call("message.send", { to: "Alice", text: "hi" }, cli);
      expect(sent.at(-1)?.key).toBe(ALICE_WORK);
    });

    test("an agent's send under approve waits in the composer until the user sends it", async () => {
      await core.call(
        "settings.set",
        { agents: { access: "assistant", read: "all", send: "approve" } },
        cli,
      );
      const queued = await core.call("message.send", { to: BOB, text: "hi" }, mcp);
      expect(queued).toMatchObject({ outcome: "queued", draft: { state: "queued", body: "hi" } });
      expect(sent).toEqual([]);
      const [pending] = await core.call("draft.list", {}, cli);
      const result = await core.call("draft.send", { id: pending!.id }, cli);
      expect(result.message.body).toBe("hi");
      expect(result.message.agent).toEqual({ name: "agent", edited: false, via: "user" });
      expect(sent).toEqual([{ key: BOB, body: "hi" }]);
    });

    test("sending clears any saved draft and ignores handle-less duplicate contacts", async () => {
      store.replaceContacts([
        contact("bob-1", "Bob Jones", [BOB]),
        contact("bob-empty", "Bob Jones", []),
      ]);
      await core.call("message.draft.save", { threadKey: "Bob Jones", text: "draft" }, cli);
      expect(store.getDraft(BOB)).toBe("draft");
      await core.call("message.send", { to: "Bob Jones", text: "sent text" }, cli);
      expect(store.getDraft(BOB)).toBeNull();
    });
  });
});

describe("agent privacy, guardrails and ergonomics", () => {
  test("masks handles behind opaque IDs and resolves them back across tools", async () => {
    await core.call(
      "settings.set",
      { agents: { access: "assistant", read: "all", send: "replied", handles: "hidden" } },
      cli,
    );
    store.replaceContacts([contact("alice", "Alice Smith", [ALICE])]);
    incoming({ threadKey: ALICE, sender: ALICE, body: "hello" });

    const threads = await core.call("thread.list", {}, mcp);
    expect(threads).toHaveLength(1);
    const opaqueKey = threads[0]!.key;
    expect(opaqueKey).toMatch(/^handle:/);
    expect(JSON.stringify(threads)).not.toContain("2065550101");

    const contacts = await core.call("contact.search", { query: "Alice" }, mcp);
    expect(contacts[0]!.handles).toEqual([opaqueKey]);
    // Digit probing must not reveal contacts when handles are hidden.
    expect(await core.call("contact.search", { query: "2065550101" }, mcp)).toEqual([]);

    // The opaque handle and contact name both work in message.list; raw phone numbers are rejected.
    const byOpaque = await core.call("message.list", { threadKey: opaqueKey }, mcp);
    const byName = await core.call("message.list", { threadKey: "Alice Smith" }, mcp);
    expect(byOpaque).toHaveLength(1);
    expect(byOpaque[0]!.id).toMatch(/^msg:/);
    expect(byOpaque[0]!.sender).toBe(opaqueKey);
    expect(byOpaque[0]!.sentAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(byName).toHaveLength(1);
    await expect(core.call("message.list", { threadKey: ALICE }, mcp)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    // Unnamed group:members: keys containing raw phone numbers are masked and resolvable back.
    const rawGroup = "group:members:+12065550101+alice";
    store.recordGroup(rawGroup, {
      named: false,
      name: null,
      participants: ["+12065550101", "Alice"],
    });
    incoming({ threadKey: rawGroup, sender: ALICE, body: "group hi" });
    const groups = await core.call("group.list", {}, mcp);
    expect(groups[0]!.threadKey).toMatch(/^group:members:/);
    expect(groups[0]!.threadKey).not.toContain("2065550101");
    expect(JSON.stringify(groups)).not.toContain("2065550101");
    const groupMsgs = await core.call("message.list", { threadKey: groups[0]!.threadKey }, mcp);
    expect(groupMsgs).toHaveLength(1);
  });

  test("hides verification codes, short-code senders and hidden threads from agents", async () => {
    await core.call(
      "settings.set",
      {
        agents: { access: "full", read: "all", send: "never", handles: "visible", hideCodes: true },
      },
      cli,
    );
    incoming({ threadKey: ALICE, sender: ALICE, body: "Your verification code is 482913" });
    t += 1000;
    incoming({ threadKey: ALICE, sender: ALICE, body: "Your login code is A1B2C3" });
    t += 1000;
    incoming({ threadKey: ALICE, sender: ALICE, body: "See you at 5" });
    incoming({ threadKey: "sender:mybank", sender: "sender:mybank", body: "Your OTP is 991122" });
    incoming({ threadKey: BOB, sender: BOB, body: "private" });
    store.setThreadHiddenFromAgents(BOB, true);
    store.saveDraft(ALICE, "My 2FA passcode is 554433");

    const threads = await core.call("thread.list", {}, mcp);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).not.toBe("mybank");

    // Draft carrying a verification code is redacted in thread.get.
    const detail = await core.call("thread.get", { key: ALICE }, mcp);
    expect(detail.draft).toBe("[Verification code hidden from AI agents]");

    // A short code looks like a conversation that doesn't exist, as a hidden one does.
    await expect(
      core.call("message.list", { threadKey: "sender:mybank" }, mcp),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such conversation" });
    await expect(core.call("thread.get", { key: BOB }, mcp)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const aliceMsgs = await core.call("message.list", { threadKey: ALICE }, mcp);
    expect(aliceMsgs.map((m) => m.body)).toEqual([
      "See you at 5",
      "[Verification code hidden from AI agents]",
      "[Verification code hidden from AI agents]",
    ]);

    // Search never leaks verification codes or hidden threads to agents.
    expect(await core.call("message.search", { query: "482913" }, mcp)).toEqual([]);
    expect(await core.call("message.search", { query: "A1B2C3" }, mcp)).toEqual([]);
    expect(await core.call("message.search", { query: "private" }, mcp)).toEqual([]);
  });

  test("marks self-conversations and locks down destructive deletions for agents", async () => {
    await core.call(
      "settings.set",
      { agents: { access: "readOnly", read: "all", send: "never" } },
      cli,
    );
    core.attach({
      contacts: {
        sync: async () => ({ skipped: true, contacts: 0, changed: 0, removed: 0, photos: 0 }),
        lastSyncAt: null,
        lastError: null,
        ownHandles: [ALICE],
      },
    });
    incoming({ threadKey: ALICE, sender: ALICE, body: "note to self" });
    const [selfThread] = await core.call("thread.list", {}, mcp);
    expect(selfThread?.isSelf).toBe(true);

    for (const cmd of ["thread.delete", "message.delete", "group.delete"] as const) {
      await expect(core.run(cmd, {}, mcp)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  test("auto-send still queues for brand-new recipients and enforces rate limits", async () => {
    const limited = await Core.open({
      version: "1.0.0",
      store,
      now: () => t,
      agentSendLimit: 1,
      agentSendWindowMs: 60_000,
    });
    const fake = fakeOutbox();
    limited.attach({ outbox: fake.outbox });
    await limited.call(
      "settings.set",
      { agents: { access: "assistant", read: "all", send: "replied" } },
      cli,
    );
    const alice = limited.handleMasker.mask(ALICE);
    // A conversation the user has written in: sent directly.
    incoming({ threadKey: ALICE, sender: ALICE, body: "hey" });
    outgoing({ threadKey: ALICE });
    const autoSent = await limited.call("message.send", { to: alice, text: "hi back" }, mcp);
    expect(autoSent.outcome).toBe("sent");

    // Rate limit blocks a second send in the same window.
    await expect(
      limited.call("message.send", { to: alice, text: "too fast" }, mcp),
    ).rejects.toMatchObject({ code: "BUSY" });

    // Advance past rate-limit window; sending to brand-new recipient BOB still queues.
    t += 61_000;
    const queued = await limited.call(
      "message.send",
      { to: limited.handleMasker.mask(BOB), text: "first time" },
      mcp,
    );
    expect(queued.outcome).toBe("queued");
    // The queued send took the window's slot: discarding it doesn't give it back.
    await limited.call("draft.discard", { id: queued.draft!.id }, mcp);
    await expect(
      limited.call("message.send", { to: alice, text: "again" }, mcp),
    ).rejects.toMatchObject({ code: "BUSY" });
    await limited.close();
  });

  test("enforces concurrent rate limits, queues short-code sends, redacts reaction codes and masks draft/contact/group leaks", async () => {
    const limited = await Core.open({
      version: "1.0.0",
      store,
      now: () => t,
      agentSendLimit: 1,
      agentSendWindowMs: 60_000,
    });
    let releaseSend!: () => void;
    limited.attach({
      outbox: stubOutbox(async (key, body, options) => {
        await new Promise<void>((r) => (releaseSend = r));
        return store.queueOutgoing({
          threadKey: key,
          body,
          recipients: [key],
          agent: options?.agent,
          agentDraftId: options?.agentDraftId,
        });
      }),
    });
    await limited.call(
      "settings.set",
      {
        agents: {
          access: "assistant",
          read: "all",
          send: "replied",
          handles: "hidden",
          hideCodes: true,
        },
      },
      cli,
    );

    // Concurrent send cannot bypass the rate limit of 1.
    incoming({ threadKey: ALICE, sender: ALICE, body: "hey" });
    outgoing({ threadKey: ALICE });
    const aliceToken = limited.handleMasker.mask(ALICE);
    const first = limited.call("message.send", { to: aliceToken, text: "one" }, mcp);
    await expect(
      limited.call("message.send", { to: aliceToken, text: "two" }, mcp),
    ).rejects.toMatchObject({ code: "BUSY" });
    releaseSend();
    await first;

    // A short-code send is never automatic, even when the thread has messages and
    // agents.send=replied: it waits for the user like a brand-new recipient.
    t += 61_000;
    incoming({ threadKey: "tel:22000", sender: "tel:22000", body: "Reply YES to confirm" });
    const shortCode = await limited.call("message.send", { to: "tel:22000", text: "YES" }, mcp);
    expect(shortCode.outcome).toBe("queued");
    const [asked] = await limited.call("draft.list", { states: ["queued"] }, cli);
    expect(asked).toMatchObject({ to: "tel:22000", note: "shortCode", text: "YES" });
    await limited.call("draft.discard", { id: asked!.id }, cli);

    // Nameless contact whose `name` is a formatted phone number is masked in contacts & threads.
    store.replaceContacts([contact("nameless", "(206) 555-0102", [BOB])]);
    incoming({ threadKey: BOB, sender: BOB, body: "hello" });
    const maskedContact = await limited.call("contact.get", { id: "nameless" }, mcp);
    expect(maskedContact.name).toMatch(/^handle:/);
    expect(JSON.stringify(maskedContact)).not.toContain("555");

    // Tapback quoting a verification code is also redacted (using opaque handle from thread.list).
    const codeMsg = incoming({
      threadKey: ALICE,
      sender: ALICE,
      body: "Your login code is 849201",
    });
    t += 1000;
    const tapback = incoming({
      threadKey: ALICE,
      sender: ALICE,
      body: 'Liked "Your login code is 849201"',
    });
    store.placeTapback(tapback.id);
    const aliceOpaque = limited.handleMasker.mask(ALICE);
    const msgs = await limited.call("message.list", { threadKey: aliceOpaque }, mcp);
    const listedCode = msgs.find((m) => m.id === limited.handleMasker.maskMessageId(codeMsg.id));
    expect(listedCode?.body).toBe("[Verification code hidden from AI agents]");
    expect(listedCode?.reactions[0]?.text).toBe("[Verification code hidden from AI agents]");

    // Draft views never carry the real numbers while handles are hidden.
    t += 61_000;
    const queued = await limited.call(
      "message.send",
      { to: "+1 206 555 0199", text: "Meet at room (3B): bring snacks" },
      mcp,
    );
    const views = await limited.call("draft.list", { states: ["queued", "discarded"] }, mcp);
    expect(JSON.stringify(views)).not.toContain("2065550101");
    expect(JSON.stringify(views)).not.toContain("2065550199");
    expect(views.find((d) => d.id === queued.draft!.id)?.to).toBe("+1 206 555 0199");

    // agents.hide and agents.show are internal and blocked for MCP; status redacts phone MAC
    // and device name.
    for (const name of ["agents.hide", "agents.show"]) {
      await expect(limited.run(name, { target: aliceOpaque }, mcp)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    }
    limited.setPhone({
      address: "AA:BB:CC:DD:EE:FF",
      name: "Alice's iPhone",
      paired: true,
      connected: true,
    });
    const mcpStatus = await limited.call("status", {}, mcp);
    expect(mcpStatus.phone.device?.address).toBe("00:00:00:00:00:00");
    expect(mcpStatus.phone.device?.name).toBe("iPhone");

    // group.save and group.assignMessage are blocked for MCP; hidden groups omitted from group.list.
    store.recordGroup("group:name:hidden", {
      named: true,
      name: "Secret",
      participants: ["+12065550102"],
    });
    store.setThreadHiddenFromAgents("group:name:hidden", true);
    store.recordGroup("group:name:open", {
      named: true,
      name: "Open",
      participants: ["Alice", "+12065550102"],
    });
    const groups = await limited.call("group.list", {}, mcp);
    expect(groups.map((g) => g.threadKey)).toEqual(["group:name:open"]);
    expect(groups[0]?.participants[1]).toMatch(/^handle:/);
    await expect(
      limited.run("group.save", { threadKey: "group:name:open", title: "X" }, mcp),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      limited.run("group.assignMessage", { id: codeMsg.id, threadKey: "group:name:open" }, mcp),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    // Contact-name resolution via message.send is blocked when agents.read = off.
    await limited.call("settings.set", { agents: { read: "off", send: "approve" } }, cli);
    await expect(
      limited.call("message.send", { to: "Alice Smith", text: "hi" }, mcp),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await limited.close();
  });
});

describe("contact and group commands", () => {
  test("contacts list, search and get; agents need read access", async () => {
    store.replaceContacts([contact("alice", "Alice Smith", [ALICE])]);
    expect((await core.call("contact.list", {}, cli)).map((c) => c.id)).toEqual(["alice"]);
    expect((await core.call("contact.search", { query: "smith" }, cli)).length).toBe(1);
    expect((await core.call("contact.get", { id: "alice" }, cli)).name).toBe("Alice Smith");
    expect((await errorOf(core.call("contact.get", { id: "nope" }, cli))).code).toBe("NOT_FOUND");
    for (const name of ["contact.list", "thread.list", "message.list", "group.list"]) {
      const input = name === "message.list" ? { threadKey: ALICE } : {};
      expect((await errorOf(core.run(name, input, mcp))).code).toBe("PERMISSION_DENIED");
    }
  });

  test("contact.photo reads the photo from the store, with no phone service running", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    store.replaceContacts([
      contact("alice", "Alice Smith", [ALICE]),
      contact("bob", "Bob", ["tel:+12065550102"]),
      contact("carol", "Carol", ["tel:+12065550103"]),
    ]);
    expect(await core.call("contact.photo", { id: "alice" }, cli)).toBeNull();
    store.putContactPhoto("a.png", "image/png", png);
    store.setContactPhoto("alice", "a.png");
    store.putContactPhoto("b.png", "image/png", Buffer.from("not an image"));
    store.setContactPhoto("bob", "b.png");
    // Named, but its bytes aren't here (yet).
    store.setContactPhoto("carol", "c.png");
    expect(core.services.contacts).toBeUndefined();
    expect(await core.call("contact.photo", { id: "alice" }, cli)).toEqual({
      contactId: "alice",
      mediaType: "image/png",
      data: png.toString("base64"),
    });
    expect(await core.call("contact.photo", { id: "bob" }, cli)).toBeNull();
    expect(await core.call("contact.photo", { id: "carol" }, cli)).toBeNull();
    expect(await core.call("contact.photo", { id: "dave" }, cli)).toBeNull();
  });

  test("group.save names a group and saves its members", async () => {
    const group = await core.call(
      "group.save",
      { threadKey: GROUP, title: "Book Club", roster: ["(206) 555-0101", "bob@example.com"] },
      cli,
    );
    expect(group).toMatchObject({
      threadKey: GROUP,
      roster: [ALICE, "email:bob@example.com"],
      routeInvalidated: false,
    });
    expect(store.getThread(GROUP)).toMatchObject({ title: "Book Club", kind: "group" });
    expect((await core.call("group.list", {}, cli)).map((g) => g.threadKey)).toEqual([GROUP]);
    const bad = await errorOf(
      core.call("group.save", { threadKey: GROUP, roster: ["Alice"] }, cli),
    );
    expect(bad.code).toBe("INVALID_INPUT");
    expect((await errorOf(core.run("group.save", { threadKey: ALICE }, cli))).code).toBe(
      "INVALID_INPUT",
    );
    expect(await core.call("group.delete", { threadKey: GROUP }, cli)).toEqual({ deleted: true });
    expect(await core.call("group.list", {}, cli)).toEqual([]);
  });

  test("conversations and group commands take a group's name for its key", async () => {
    await core.call("group.save", { threadKey: GROUP, title: "Book Club" }, cli);
    expect((await core.call("thread.get", { key: "book club" }, cli)).thread.key).toBe(GROUP);
    expect(
      await core.call("group.save", { threadKey: "Book Club", roster: ["(206) 555-0101"] }, cli),
    ).toMatchObject({ threadKey: GROUP, roster: [ALICE] });
    const message = incoming();
    const moved = await core.call(
      "group.assignMessage",
      { id: message.id, threadKey: "Book Club" },
      cli,
    );
    expect(moved.threadKey).toBe(GROUP);
    expect((await errorOf(core.run("group.save", { threadKey: "Chess Club" }, cli))).code).toBe(
      "NOT_FOUND",
    );
    expect((await errorOf(core.run("group.delete", { threadKey: ALICE }, cli))).code).toBe(
      "INVALID_INPUT",
    );
    expect((await errorOf(core.run("group.delete", { threadKey: "group:" }, cli))).code).toBe(
      "INVALID_INPUT",
    );
    // Agents only find groups they may read.
    store.setThreadHiddenFromAgents(GROUP, true);
    await core.call("settings.set", { agents: { access: "readOnly", read: "all" } }, cli);
    expect((await errorOf(core.run("thread.get", { key: "Book Club" }, mcp))).code).toBe(
      "NOT_FOUND",
    );
    // Two groups by one name: ask for the key.
    await core.call("group.save", { threadKey: "group:name:book-club-2", title: "Book Club" }, cli);
    expect((await errorOf(core.run("thread.get", { key: "Book Club" }, cli))).code).toBe(
      "INVALID_INPUT",
    );
    expect(await core.call("group.delete", { threadKey: GROUP }, cli)).toEqual({ deleted: true });
  });

  test("group.assignMessage moves a message and announces both threads", async () => {
    store.setGroupRoster(GROUP, [BOB]);
    const message = incoming();
    events.length = 0;
    const moved = await core.call("group.assignMessage", { id: message.id, threadKey: GROUP }, cli);
    expect(moved.threadKey).toBe(GROUP);
    // Alice isn't on the roster: replies may not reach everyone.
    expect(store.getGroup(GROUP)?.routeInvalidated).toBe(true);
    // Alice's conversation, empty now, leaves the list until her next message.
    expect(store.listThreads().map((x) => x.key)).not.toContain(ALICE);
    expect(events.map((e) => e.event)).toEqual([
      "message.changed",
      "message.changed",
      "thread.changed",
    ]);
  });
});

describe("sync commands", () => {
  test("status and now reflect the attached services", async () => {
    let contactSyncs = 0;
    core.attach({
      sync: {
        status: {
          link: { kind: "connected", session: "s" },
          syncing: false,
          lastSyncAt: T0,
          lastError: null,
          failures: 0,
        },
        sync: async () => ({
          kind: "relist",
          listed: 3,
          added: [incoming()],
          readChanged: [],
          reacted: [],
          skipped: 0,
          gap: null,
        }),
        trigger: () => {},
        markReadOnPhone: async () => 0,
      },
      contacts: {
        lastSyncAt: T0,
        lastError: null,
        sync: async (options) => {
          contactSyncs++;
          expect(options).toEqual({ force: true });
          return { skipped: false, contacts: 10, changed: 2, removed: 1, photos: 0 };
        },
      },
      ancs: { state: { kind: "waiting", hint: "Allow notifications on the phone" } },
    });
    expect(await core.call("sync.status", {}, cli)).toEqual({
      messages: { state: "connected", syncing: false, lastSyncAt: T0 },
      contacts: { state: "on", lastSyncAt: T0 },
      notifications: { state: "waiting", detail: "Allow notifications on the phone" },
    });
    expect(await core.call("sync.now", {}, cli)).toEqual({
      synced: true,
      added: 1,
      contacts: null,
    });
    expect(contactSyncs).toBe(0);
    expect((await core.call("sync.now", { contacts: true }, cli)).contacts).toEqual({
      skipped: false,
      contacts: 10,
      changed: 2,
      removed: 1,
    });
    core.attach({ sync: undefined });
    expect((await core.call("sync.status", {}, cli)).messages.state).toBe("off");
  });

  test("device.connect retries messages now", async () => {
    const calls: string[] = [];
    core.setControl({
      connect: async () => void calls.push("connect"),
    } as never);
    await expect(core.call("device.connect", {}, cli)).resolves.toEqual({ address: null });
    core.attach({ sync: { trigger: (t: string) => calls.push(t) } as never });
    await core.call("device.connect", {}, cli);
    expect(calls).toEqual(["connect", "connect", "reconnect"]);
  });
});

describe("service commands", () => {
  test("report and install the background service", async () => {
    const installs: string[] = [];
    const managed = await Core.open({
      version: "1.0.0",
      service: {
        status: async () => ({ installed: false, enabled: null, active: null }),
        install: async () => {
          installs.push("install");
          return { installed: true, enabled: true, active: false, handover: true };
        },
        disable: async () => {
          installs.push("disable");
          return { installed: true, enabled: false, active: true, handover: true };
        },
      },
    });
    expect(await managed.call("service.status", {}, cli)).toEqual({
      installed: false,
      enabled: null,
      active: null,
    });
    expect(await managed.call("service.install", {}, cli)).toEqual({
      installed: true,
      enabled: true,
      active: false,
      handover: true,
    });
    expect(await managed.call("service.disable", {}, cli)).toEqual({
      installed: true,
      enabled: false,
      active: true,
      handover: true,
    });
    expect(installs).toEqual(["install", "disable"]);
    expect((await errorOf(managed.run("service.install", {}, mcp))).code).toBe("PERMISSION_DENIED");
    expect((await errorOf(managed.run("service.disable", {}, mcp))).code).toBe("PERMISSION_DENIED");
  });

  test("fail with NOT_FOUND when the daemon can't manage it", async () => {
    expect((await errorOf(core.run("service.status", {}, cli))).code).toBe("NOT_FOUND");
  });
});

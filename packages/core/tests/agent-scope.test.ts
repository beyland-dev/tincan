import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  TincanError,
  type AgentSettingsPatch,
  type ClientInfo,
  type Message,
  type TincanEvent,
} from "@beyland/tincan-protocol";
import { Core, Store, nodeSqliteDb, type NewMessage, type SendOptions } from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "test" };
const desktop: ClientInfo = { kind: "desktop", name: "tincan-desktop" };
const mcp: ClientInfo = { kind: "mcp", name: "agent" };
const PHONE = "AA:BB:CC:DD:EE:FF";
const T0 = 1_780_000_000_000;

const ALICE = "tel:+12065550101"; // saved contact, texts the user
const AMY = "tel:+12065550102"; // saved contact, no conversation yet
const STRANGER = "tel:+12065550199"; // only ever texted the user
const REPLIED = "tel:+12065550198"; // a stranger the user wrote back to
const AGENT_ONLY = "tel:+12065550197"; // a stranger only an agent wrote to
const FORMER = "tel:+12065550196"; // a contact the user deleted
const ME = "tel:+12065550100"; // the user's own number
const SHORT = "tel:12345"; // a short code
const SAVED_SHORT = "tel:54321"; // a short code saved as a contact
const HIDDEN = "tel:+12065550195"; // a contact's conversation the user hid
const MIXED_REPLIED = "group:name:mixed-replied";
const MIXED_QUIET = "group:name:mixed-quiet";
const FRIENDS = "group:name:friends";
const EMPTY = "group:name:empty";

let t = T0;
let store: Store;
let core: Core;
let sent: Array<{ key: string; body: string }>;
let events: TincanEvent[];
let mapHandle = 0;

function insert(overrides: Partial<NewMessage>): Message {
  mapHandle++;
  t += 1000;
  const { message } = store.insertMessage({
    threadKey: ALICE,
    direction: "incoming",
    sender: overrides.threadKey ?? ALICE,
    body: `hello ${mapHandle}`,
    sentAt: t,
    receivedAt: t,
    source: "map",
    status: "received",
    read: false,
    device: PHONE,
    mapHandle: `0400${String(mapHandle).padStart(12, "0")}`,
    folder: "inbox",
    ...overrides,
  });
  if (!message) throw new Error("not inserted");
  return message;
}

const incoming = (threadKey: string, body?: string) =>
  insert({
    threadKey,
    sender: threadKey.startsWith("group:") ? ALICE : threadKey,
    ...(body === undefined ? {} : { body }),
  });

/** A message the user sent themselves, from the phone. */
const replied = (threadKey: string, body = "thanks") =>
  insert({ threadKey, direction: "outgoing", sender: null, body, folder: "sent" });

function contact(id: string, name: string, handles: string[]) {
  return { id, name, favorite: false, handles: handles.map((handle) => ({ handle, label: null })) };
}

/**
 * Changes the agent settings, at `full` access unless given: most of these tests use raw keys
 * (`handles: "visible"`), which only `full` allows. Tests of what `assistant` adds pass it.
 */
async function settings(agents: AgentSettingsPatch): Promise<void> {
  await core.call("settings.set", { agents: { access: "full", ...agents } }, cli);
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

/** Ids of agent drafts queued for the user. */
function requested(): string[] {
  return events.flatMap((e) =>
    e.event === "draft.changed" && e.data.state === "queued" ? [e.data.id] : [],
  );
}

/** Thread keys an agent sees in thread.list. */
async function listed(): Promise<string[]> {
  return (await core.call("thread.list", { limit: 500 }, mcp)).map((th) => th.key).sort();
}

/** Whether an agent can open the conversation (thread.get), or gets NOT_FOUND. */
async function readable(key: string): Promise<boolean> {
  try {
    await core.call("thread.get", { key }, mcp);
    return true;
  } catch (error) {
    expect(error).toMatchObject({ code: "NOT_FOUND", message: "No such conversation" });
    return false;
  }
}

beforeEach(async () => {
  t = T0;
  sent = [];
  events = [];
  store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => t });
  store.replaceContacts([
    contact("alice", "Alice Smith", [ALICE]),
    contact("amy", "Amy Jones", [AMY]),
    contact("former", "Former Friend", [FORMER]),
    contact("shortcode", "Pharmacy", [SAVED_SHORT]),
    contact("hidden", "Hidden Hal", [HIDDEN]),
  ]);
  // What the last contact sync stored: the owner card's numbers.
  store.setSetting(`pbap.${PHONE}`, { version: null, syncedAt: T0, ownHandles: [ME] });
  core = await Core.open({ version: "1.0.0", store, now: () => t });
  core.events.subscribe((e) => events.push(e));
  core.attach({
    outbox: {
      send: async (key: string, body: string, options?: SendOptions) => {
        sent.push({ key, body });
        const queued = store.queueOutgoing({
          threadKey: key,
          body,
          recipients: [key],
          byAgent: options?.byAgent,
          agent: options?.agent,
          agentDraftId: options?.agentDraftId,
        });
        store.setMessageStatus(queued.id, "failed");
        return store.getMessage(queued.id)!;
      },
      retry: async (id: string): Promise<Message> => {
        const message = store.getMessage(id)!;
        sent.push({ key: message.threadKey, body: message.body });
        return message;
      },
      cancel: () => {
        throw new TincanError("CONFLICT", "Already sending");
      },
      sendNow: async (id: string): Promise<Message> => store.getMessage(id)!,
      dropThread: () => {},
    },
  });
});

afterEach(async () => {
  await core.close();
});

/** Every kind of conversation the scope rules tell apart. */
function seedConversations(): void {
  incoming(ALICE);
  incoming(STRANGER);
  incoming(REPLIED);
  replied(REPLIED);
  // An agent's send, and the phone's copy of it a moment later (a MAP echo): neither is the user's.
  store.queueOutgoing({
    threadKey: AGENT_ONLY,
    body: "agent hello",
    recipients: [],
    byAgent: true,
  });
  replied(AGENT_ONLY, "agent hello");
  incoming(FORMER);
  replied(ME, "note to self");
  incoming(SHORT, "Your code is 123456");
  replied(SHORT, "STOP");
  incoming(SAVED_SHORT, "Your prescription is ready");
  incoming(HIDDEN);
  for (const [key, members] of [
    [MIXED_REPLIED, [ALICE, STRANGER]],
    [MIXED_QUIET, [ALICE, STRANGER]],
    [FRIENDS, [ALICE, AMY]],
  ] as const) {
    incoming(key);
    store.setThreadMembers(key, members);
  }
  replied(MIXED_REPLIED);
  // A group Tincan knows only by name: no members recorded at all.
  incoming(EMPTY);
  store.replaceContacts([
    contact("alice", "Alice Smith", [ALICE]),
    contact("amy", "Amy Jones", [AMY]),
    contact("shortcode", "Pharmacy", [SAVED_SHORT]),
    contact("hidden", "Hidden Hal", [HIDDEN]),
  ]);
  // The user hid Hal from agents.
  store.hideHandle(HIDDEN, "Hidden Hal");
}

describe("read scope", () => {
  const contacts = [ALICE, FRIENDS, ME];
  const known = [...contacts, MIXED_REPLIED, REPLIED];
  const all = [...known, AGENT_ONLY, EMPTY, FORMER, MIXED_QUIET, STRANGER];
  const everything = [...all, HIDDEN, SAVED_SHORT, SHORT];

  const cases = [
    { read: "contacts", hideCodes: true, visible: contacts },
    { read: "known", hideCodes: true, visible: known },
    { read: "all", hideCodes: true, visible: all },
    // Without hideCodes a short code is like anyone else: saved, or replied to.
    { read: "contacts", hideCodes: false, visible: [...contacts, SAVED_SHORT] },
    { read: "known", hideCodes: false, visible: [...known, SAVED_SHORT, SHORT] },
    { read: "all", hideCodes: false, visible: [...all, SAVED_SHORT, SHORT] },
  ] as const;

  for (const { read, hideCodes, visible } of cases) {
    test(`${read}${hideCodes ? "" : " without hideCodes"}`, async () => {
      seedConversations();
      await settings({ read, hideCodes, handles: "visible" });
      expect(await listed()).toEqual([...visible].sort());
      for (const key of everything) {
        expect({ key, readable: await readable(key) }).toEqual({
          key,
          readable: visible.includes(key),
        });
      }
      // Every way in agrees: messages, search and groups.
      for (const key of everything) {
        const list = core.call("message.list", { threadKey: key }, mcp);
        if (visible.includes(key)) await list;
        else expect((await errorOf(list)).code).toBe("NOT_FOUND");
      }
      const hits = await core.call("message.search", { query: "hello", limit: 500 }, mcp);
      const searched = new Set(hits.map((m) => m.threadKey));
      for (const key of everything) {
        if (!visible.includes(key)) expect(searched.has(key)).toBe(false);
      }
      expect(searched.has(ALICE)).toBe(true);
      const groups = (await core.call("group.list", {}, mcp)).map((g) => g.threadKey);
      for (const key of groups) expect(visible).toContain(key);
    });
  }

  test("the user sees everything, whatever agents may", async () => {
    seedConversations();
    await settings({ read: "contacts" });
    const forUser = await core.call("thread.list", { limit: 500 }, desktop);
    expect(forUser.map((th) => th.key).sort()).toEqual([...everything].sort());
  });

  test("off: nothing at all", async () => {
    seedConversations();
    await settings({ read: "off" });
    expect((await errorOf(core.call("thread.list", {}, mcp))).code).toBe("PERMISSION_DENIED");
    expect((await errorOf(core.call("thread.get", { key: ALICE }, mcp))).code).toBe(
      "PERMISSION_DENIED",
    );
  });

  test("the self conversation counts once the owner card is known, even with no contact sync running", async () => {
    replied(ME, "note to self");
    await settings({ read: "contacts", handles: "visible" });
    expect(await listed()).toEqual([ME]);
    store.setSetting(`pbap.${PHONE}`, { version: null, syncedAt: T0, ownHandles: [] });
    expect(await listed()).toEqual([]);
    // A running contact sync is the authority.
    core.attach({
      contacts: {
        sync: async () => ({ skipped: true, contacts: 0, changed: 0, removed: 0, photos: 0 }),
        lastSyncAt: null,
        lastError: null,
        ownHandles: [ME],
      },
    });
    expect(await listed()).toEqual([ME]);
  });

  test("an agent's own messages never make a conversation readable", async () => {
    incoming(STRANGER, "hi, who is this?");
    await settings({ read: "known", send: "always", handles: "visible" });
    await core.call("message.send", { to: STRANGER, text: "Thanks" }, mcp);
    // The phone's copy of the agent's message.
    replied(STRANGER, "Thanks");
    expect(await readable(STRANGER)).toBe(false);
    // The user writing the same words much later is their own message.
    t += 60 * 60_000;
    replied(STRANGER, "Thanks");
    expect(await readable(STRANGER)).toBe(true);
  });
});

describe("no LIMIT starvation", () => {
  test("thread.list finds contacts' conversations below many newer strangers and short codes", async () => {
    for (const [i, key] of ["tel:+12065550001", "tel:+12065550002", "tel:+12065550003"].entries()) {
      store.replaceContacts([
        ...store.listContacts({ limit: 500 }).map((c) => ({
          id: c.id,
          name: c.name,
          favorite: false,
          handles: c.handles.map((handle) => ({ handle, label: null })),
        })),
        contact(`c${i}`, `Contact ${i}`, [key]),
      ]);
    }
    const keys = [ALICE, AMY, "tel:+12065550001", "tel:+12065550002", "tel:+12065550003"];
    for (const key of keys) incoming(key);
    for (let i = 0; i < 100; i++) incoming(`tel:+1206556${String(i).padStart(4, "0")}`);
    for (let i = 0; i < 100; i++) incoming(`tel:${10000 + i}`);
    await settings({ read: "contacts", handles: "visible" });
    const threads = await core.call("thread.list", { limit: 5 }, mcp);
    expect(threads.map((th) => th.key).sort()).toEqual([...keys].sort());
  });

  test("message.search finds contacts' messages below many newer strangers' matches", async () => {
    for (let i = 0; i < 3; i++) incoming(ALICE, `pizza tonight ${i}`);
    for (let i = 0; i < 600; i++) {
      incoming(`tel:+1206557${String(i % 50).padStart(4, "0")}`, `pizza deal ${i}`);
    }
    await settings({ read: "contacts", handles: "visible" });
    const hits = await core.call("message.search", { query: "pizza", limit: 3 }, mcp);
    expect(hits.map((m) => m.body).sort()).toEqual([
      "pizza tonight 0",
      "pizza tonight 1",
      "pizza tonight 2",
    ]);
  });
});

describe("sending", () => {
  /** Whether an agent's send goes at once (true) or becomes an agent draft for the user. */
  async function sendsAtOnce(to: string): Promise<boolean> {
    const result = await core.call("message.send", { to, text: "hi" }, mcp);
    expect(result.draft).toBeDefined();
    if (result.outcome === "queued") {
      expect(result).not.toHaveProperty("message");
      return false;
    }
    expect(result.outcome).toBe("sent");
    return true;
  }

  test("always, as assistant: anyone, directly, except what's hidden", async () => {
    seedConversations();
    await settings({ access: "assistant", read: "contacts", send: "always" });
    const as = (key: string) => core.handleMasker.mask(key);
    expect(await sendsAtOnce(as(STRANGER))).toBe(true); // out of scope
    expect(await sendsAtOnce(as("tel:+12065550111"))).toBe(true); // brand new
    expect(await sendsAtOnce(as(ALICE))).toBe(true);
    expect(await sendsAtOnce(as(HIDDEN))).toBe(false);
    expect(await sendsAtOnce(as(SHORT))).toBe(false);
    // Assistant keeps the privacy protections on whatever is stored.
    await settings({ access: "assistant", hideCodes: false, handles: "visible" });
    expect(await sendsAtOnce(as(SHORT))).toBe(false);
    // A raw number while handles are hidden queues, so sending can't confirm who it is.
    expect(await sendsAtOnce("+1 206 555 0199")).toBe(false);
    expect(await sendsAtOnce(as(STRANGER))).toBe(true);
  });

  test("always, with full access: nothing queues but people the user hid", async () => {
    seedConversations();
    await settings({ read: "contacts", send: "always", handles: "visible" });
    for (const to of [STRANGER, "tel:+12065550111", ALICE, SHORT]) {
      expect({ to, atOnce: await sendsAtOnce(to) }).toEqual({ to, atOnce: true });
    }
    // An explicit hide beats every access level: always an agent draft, noted for the user.
    expect(await sendsAtOnce(HIDDEN)).toBe(false);
    expect(sent.map((s) => s.key)).not.toContain(HIDDEN);
    expect(store.listAgentDrafts({ to: HIDDEN })[0]).toMatchObject({
      state: "queued",
      note: "hidden",
    });
    // Not even a raw number while the user keeps handles hidden.
    await settings({ handles: "hidden" });
    expect(await sendsAtOnce("+1 206 555 0199")).toBe(true);
    expect(await sendsAtOnce(core.handleMasker.mask(HIDDEN))).toBe(false);
    // Only Hal's became a draft (the same text again is the same draft).
    expect(requested()).toHaveLength(1);
    expect(store.listAgentDrafts({ states: ["queued"] }).map((d) => d.to)).toEqual([HIDDEN]);
    // Reading still respects what the user hid, and the read scope.
    expect(await readable(core.handleMasker.mask(HIDDEN))).toBe(false);
    expect(await readable(core.handleMasker.mask(STRANGER))).toBe(false);
    expect(await readable(core.handleMasker.mask(ALICE))).toBe(true);
  });

  test("full access with replied or approve queues as assistant does", async () => {
    seedConversations();
    replied(ALICE);
    await settings({ read: "contacts", send: "replied", handles: "visible" });
    expect(await sendsAtOnce(ALICE)).toBe(true);
    expect(await sendsAtOnce(HIDDEN)).toBe(false);
    expect(await sendsAtOnce(STRANGER)).toBe(false);
    await settings({ send: "approve" });
    expect(await sendsAtOnce(ALICE)).toBe(false);
  });

  test("replied: only people the user has texted, within what agents may read", async () => {
    seedConversations();
    await settings({ read: "contacts", send: "replied", handles: "visible" });
    replied(ALICE);
    expect(await sendsAtOnce(ALICE)).toBe(true);
    expect(await sendsAtOnce(REPLIED)).toBe(false); // replied to, but outside `contacts`
    expect(await sendsAtOnce(AMY)).toBe(false); // a contact the user hasn't texted
    expect(await sendsAtOnce(STRANGER)).toBe(false);
    await settings({ read: "known" });
    expect(await sendsAtOnce(REPLIED)).toBe(true);
    expect(await sendsAtOnce(SHORT)).toBe(false); // replied to, but a short code
  });

  test("approve: every send queues", async () => {
    seedConversations();
    replied(ALICE);
    await settings({ read: "all", send: "approve", handles: "visible" });
    expect(await sendsAtOnce(ALICE)).toBe(false);
  });

  test("queued drafts tell the user why, and agents nothing", async () => {
    seedConversations();
    await settings({ read: "contacts", send: "replied", handles: "visible" });
    for (const to of [HIDDEN, SHORT, STRANGER, ALICE]) {
      await core.call("message.send", { to, text: "hi" }, mcp);
    }
    const forUser = await core.call("draft.list", {}, desktop);
    const notes = Object.fromEntries(forUser.map((d) => [d.to, d.note ?? null]));
    expect(notes).toEqual({
      [HIDDEN]: "hidden",
      [SHORT]: "shortCode",
      [STRANGER]: "outOfScope",
      [ALICE]: null,
    });
    const forAgent = await core.call("draft.list", {}, mcp);
    expect(forAgent).toHaveLength(4);
    for (const d of forAgent) {
      expect(d).not.toHaveProperty("note");
      expect(d).not.toHaveProperty("requestedAs");
    }
    // What the agent may not read looks the same as a brand-new recipient: no conversation, no
    // current text.
    const unreadable = forAgent.filter((d) => d.to !== ALICE);
    for (const d of unreadable) {
      expect(d.threadKey).toBeNull();
      expect(d).not.toHaveProperty("text");
    }
    expect(forAgent.find((d) => d.to === ALICE)).toMatchObject({ threadKey: ALICE, text: "hi" });
    expect(JSON.stringify(forAgent)).not.toMatch(/hidden|shortCode|outOfScope|Hidden Hal/);
  });

  test("a draft the user sends goes where they chose, hidden or not", async () => {
    seedConversations();
    await settings({ read: "contacts", send: "approve", handles: "visible" });
    const { draft } = await core.call("message.send", { to: HIDDEN, text: "please" }, mcp);
    const result = await core.call("draft.send", { id: draft!.id }, desktop);
    expect(result.draft).toMatchObject({ state: "scheduled", to: HIDDEN, intent: "send" });
    expect(result.message.agent).toEqual({ name: "agent", edited: false, via: "user" });
    expect(sent.at(-1)).toEqual({ key: HIDDEN, body: "please" });
  });

  test("agents can't retry; the user can", async () => {
    seedConversations();
    await settings({ read: "contacts", send: "always", handles: "visible" });
    const { message: failed } = await core.call("message.send", { to: ALICE, text: "again" }, mcp);
    const denied = await errorOf(core.call("message.retry", { id: failed!.id }, mcp));
    expect(denied.code).toBe("PERMISSION_DENIED");
    const id = core.handleMasker.unmaskMessageId(failed!.id) ?? failed!.id;
    await core.call("message.retry", { id }, desktop);
    expect(sent.at(-1)).toEqual({ key: ALICE, body: "again" });
  });

  test("sendLimit applies as soon as it changes, to queued sends too", async () => {
    const to = core.handleMasker.mask(STRANGER);
    await settings({ access: "assistant", read: "all", send: "always", sendLimit: 2 });
    await core.call("message.send", { to, text: "1" }, mcp);
    await core.call("message.send", { to, text: "2" }, mcp);
    const busy = await errorOf(core.call("message.send", { to, text: "3" }, mcp));
    expect(busy.code).toBe("BUSY");
    expect(busy.message).toContain("agents.sendLimit");
    await settings({ access: "assistant", sendLimit: 3 });
    await core.call("message.send", { to, text: "3" }, mcp);
    // No limit, as assistant.
    await settings({ access: "assistant", sendLimit: null });
    for (let i = 4; i <= 15; i++) await core.call("message.send", { to, text: `${i}` }, mcp);
    // Back to 10: the recent sends count.
    await settings({ access: "assistant", sendLimit: 10 });
    expect((await errorOf(core.call("message.send", { to, text: "x" }, mcp))).code).toBe("BUSY");
  });

  test("full access has no send limit, whatever is stored", async () => {
    await settings({ read: "all", send: "always", handles: "visible", sendLimit: 1 });
    for (let i = 0; i < 70; i++) {
      await core.call("message.send", { to: STRANGER, text: `${i}` }, mcp);
    }
    // Other agent limits protect the phone and still apply.
    incoming(ALICE);
    await settings({ manage: true });
    for (let i = 0; i < 30; i++)
      await core.call("thread.mute", { key: ALICE, muted: i % 2 === 0 }, mcp);
    expect((await errorOf(core.call("thread.mute", { key: ALICE }, mcp))).code).toBe("BUSY");
  });

  test("a contact with several numbers never resolves to one an agent may not see", async () => {
    const WORK = "tel:+12065550120";
    store.replaceContacts([contact("bob", "Bob Brown", [ALICE, WORK])]);
    incoming(ALICE);
    incoming(WORK); // the most recent
    store.setThreadHiddenFromAgents(WORK, true);
    await settings({ read: "all", send: "approve", handles: "visible" });
    await core.call("message.send", { to: "Bob Brown", text: "hi" }, mcp);
    const [pending] = await core.call("draft.list", {}, desktop);
    expect(pending!.to).toBe(ALICE);
  });
});

describe("drafts and inbox actions", () => {
  test("a saved contact with no conversation yet can get a draft under contacts and known", async () => {
    for (const read of ["contacts", "known"] as const) {
      await settings({ read, handles: "visible" });
      const saved = await core.call("message.draft.save", { threadKey: AMY, text: "hi" }, mcp);
      // No conversation yet: the draft waits for one.
      expect(saved).toMatchObject({ threadKey: null, saved: true, draft: { to: AMY } });
      const stranger = core.call("message.draft.save", { threadKey: STRANGER, text: "hi" }, mcp);
      expect((await errorOf(stranger)).code).toBe("NOT_FOUND");
    }
    await settings({ read: "all" });
    await core.call("message.draft.save", { threadKey: STRANGER, text: "hi" }, mcp);
  });

  test("read only can't draft, and manage: false refuses inbox actions", async () => {
    incoming(ALICE);
    await settings({ read: "all", manage: false, handles: "visible" });
    await core.call("settings.set", { agents: { access: "readOnly" } }, cli);
    const draft = await errorOf(
      core.call("message.draft.save", { threadKey: ALICE, text: "hi" }, mcp),
    );
    expect(draft).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(draft.message).toContain("agents.access");
    await settings({ read: "all", manage: false, handles: "visible" });
    for (const [name, input] of [
      ["thread.markRead", { key: ALICE }],
      ["thread.mute", { key: ALICE }],
      ["thread.pin", { key: ALICE }],
    ] as const) {
      const error = await errorOf(core.run(name, input, mcp));
      expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
      expect(error.message).toContain("agents.manage");
    }
    await settings({ manage: true });
    await core.call("message.draft.save", { threadKey: ALICE, text: "hi" }, mcp);
    await core.call("thread.pin", { key: ALICE }, mcp);
  });

  test("inbox actions stay within what agents may read", async () => {
    incoming(STRANGER);
    await settings({ read: "contacts", manage: true, handles: "visible" });
    for (const name of ["thread.markRead", "thread.mute", "thread.pin"]) {
      expect((await errorOf(core.run(name, { key: STRANGER }, mcp))).code).toBe("NOT_FOUND");
    }
  });
});

describe("groups", () => {
  test("a group whose conversation is gone still has to be in scope", async () => {
    store.recordGroup("group:name:orphan", { named: true, name: "Orphan", participants: [] });
    await settings({ read: "known" });
    expect(await core.call("group.list", {}, mcp)).toEqual([]);
    await settings({ read: "all" });
    expect((await core.call("group.list", {}, mcp)).map((g) => g.threadKey)).toEqual([
      "group:name:orphan",
    ]);
  });
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  TincanError,
  type AgentSettingsPatch,
  type ClientInfo,
  type TincanEvent,
} from "@beyland/tincan-protocol";
import {
  Core,
  MIGRATIONS,
  Outbox,
  Store,
  migrate,
  nodeSqliteDb,
  type ContactInput,
  type MapLinkHandle,
} from "../src/index.ts";

const desktop: ClientInfo = { kind: "desktop", name: "tincan-desktop" };
const cli: ClientInfo = { kind: "cli", name: "tincan" };
const agent: ClientInfo = { kind: "mcp", name: "Claude Code" };
const MOM = "tel:+12065550101";
const MOM_WORK = "tel:+12065550111";
const MOM_EMAIL = "email:mom@example.com";
const BOB = "tel:+12065550102";
const STRANGER = "tel:+12065550199";
const FAMILY = "group:name:family";
const CLUB = "group:name:club";
const T0 = 1_780_000_000_000;

let t = T0;
let store: Store;
let core: Core;
let outbox: Outbox;
let pushed: string[];
let events: TincanEvent[];
let mapHandle = 0;

const link = {
  pushMessage: async (recipients: string[], body: string) => {
    pushed.push(`${recipients.join(",")}: ${body}`);
    return "accepted" as const;
  },
} as unknown as MapLinkHandle;

function contact(id: string, name: string, handles: string[]): ContactInput {
  return { id, name, favorite: false, handles: handles.map((handle) => ({ handle, label: null })) };
}

const MOM_CARD = contact("mom", "Mom", [MOM, MOM_WORK, MOM_EMAIL]);
const BOB_CARD = contact("bob", "Bob Brown", [BOB]);

function incoming(threadKey: string, sender = threadKey, body = "hello"): void {
  mapHandle++;
  t += 1000;
  store.insertMessage({
    threadKey,
    threadKind: threadKey.startsWith("group:") ? "group" : "direct",
    direction: "incoming",
    sender,
    body,
    sentAt: t,
    receivedAt: t,
    source: "map",
    status: "received",
    read: false,
    device: "AA:BB:CC:DD:EE:FF",
    mapHandle: `h${mapHandle}`,
    folder: "inbox",
  });
}

async function agents(patch: AgentSettingsPatch): Promise<void> {
  await core.call(
    "settings.set",
    { agents: { access: "full", read: "all", handles: "visible", ...patch } },
    cli,
  );
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

/** Thread keys the agent sees in thread.list. */
async function agentThreads(): Promise<string[]> {
  return (await core.call("thread.list", {}, agent)).map((th) => th.key).sort();
}

beforeEach(async () => {
  t = T0;
  pushed = [];
  events = [];
  store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => t });
  store.replaceContacts([MOM_CARD, BOB_CARD]);
  core = await Core.open({ version: "1.0.0", store, now: () => t });
  core.events.subscribe((e) => events.push(e));
  outbox = new Outbox({
    store,
    events: core.events,
    link: () => link,
    defaultRegion: () => "US",
    sweepIntervalMs: 0,
    now: () => t,
  });
  core.attach({ outbox });
  await agents({ send: "always", sendDelaySeconds: 0 });
});

afterEach(async () => {
  outbox.stop();
  await core.close();
});

describe("hiding a contact", () => {
  test("hides all of their numbers and emails, now and in conversations still to come", async () => {
    incoming(MOM);
    incoming(BOB);
    const result = await core.call("agents.hide", { contactId: "mom" }, desktop);
    expect(result).toMatchObject({
      changed: true,
      group: null,
      requeued: 0,
      person: {
        label: "Mom",
        contactId: "mom",
        contactRemoved: false,
        handles: [MOM_EMAIL, MOM, MOM_WORK].sort(),
      },
    });
    expect(await agentThreads()).toEqual([BOB]);
    // A conversation on another of her numbers, started later, is hidden too.
    incoming(MOM_WORK);
    expect(await agentThreads()).toEqual([BOB]);
    expect(core.agentThreadAccess(agent, MOM_EMAIL)).toBe("hidden");
    expect(store.getThread(MOM_WORK)).toMatchObject({
      hiddenFromAgents: true,
      hiddenBy: "person",
      hiddenPerson: { id: result.person!.id, label: "Mom" },
    });
    // The user sees everything, and the list says who's hidden.
    expect((await core.call("thread.list", {}, desktop)).map((th) => th.key).sort()).toEqual(
      [BOB, MOM, MOM_WORK].sort(),
    );
    expect(await core.call("agents.hidden", {}, desktop)).toEqual({
      people: [result.person],
      groups: [],
    });
    expect(await core.call("contact.get", { id: "mom" }, desktop)).toMatchObject({
      hiddenFromAgents: true,
    });
  });

  test("hides the contact itself from agents: lists, search, lookups and names", async () => {
    incoming(MOM);
    await core.call("agents.hide", { target: "Mom" }, cli);
    expect((await core.call("contact.list", {}, agent)).map((c) => c.id)).toEqual(["bob"]);
    expect(await core.call("contact.search", { query: "Mom" }, agent)).toEqual([]);
    expect(await core.call("contact.search", { query: "2065550111" }, agent)).toEqual([]);
    expect((await errorOf(core.call("contact.get", { id: "mom" }, agent))).code).toBe("NOT_FOUND");
    // By name: there's nobody called that, for reading or for sending.
    expect((await errorOf(core.call("thread.get", { key: "Mom" }, agent))).code).toBe("NOT_FOUND");
    expect((await errorOf(core.call("message.send", { to: "Mom", text: "hi" }, agent))).code).toBe(
      "NOT_FOUND",
    );
    expect(
      (await errorOf(core.call("message.draft.save", { to: "Mom", text: "hi" }, agent))).code,
    ).toBe("NOT_FOUND");
    // The user still finds her, hidden.
    const [found] = await core.call("contact.search", { query: "Mom" }, desktop);
    expect(found).toMatchObject({ id: "mom", hiddenFromAgents: true });
    expect((await core.call("contact.list", {}, agent))[0]).not.toHaveProperty("hiddenFromAgents");
  });

  test("hiding one of a contact's numbers hides the whole contact", async () => {
    const { person } = await core.call("agents.hide", { handle: "(206) 555-0111" }, desktop);
    expect(person).toMatchObject({ contactId: "mom", label: "Mom", handles: expect.any(Array) });
    expect(person!.handles).toHaveLength(3);
  });
});

describe("hiding a raw number or address", () => {
  test("works with no conversation yet, and covers the conversation once it starts", async () => {
    const result = await core.call("agents.hide", { target: "+1 206 555 0199" }, cli);
    expect(result.person).toMatchObject({
      label: "+12065550199",
      contactId: null,
      contactRemoved: false,
      handles: [STRANGER],
    });
    expect(core.agentThreadAccess(agent, STRANGER)).toBe("hidden");
    incoming(STRANGER);
    expect(await agentThreads()).toEqual([]);
    // Sending to it still works for agents, as a draft for the user.
    const sent = await core.call("message.send", { to: STRANGER, text: "hi" }, agent);
    expect(sent.outcome).toBe("queued");
    expect(store.listAgentDrafts({ to: STRANGER })[0]?.note).toBe("hidden");
    expect(pushed).toEqual([]);
  });

  test("showing it again by number shows the person", async () => {
    await core.call("agents.hide", { handle: STRANGER }, desktop);
    expect(await core.call("agents.show", { target: "206-555-0199" }, desktop)).toEqual({
      changed: true,
    });
    expect(core.agentThreadAccess(agent, STRANGER)).toBeNull();
    expect((await core.call("agents.hidden", {}, desktop)).people).toEqual([]);
  });
});

describe("groups", () => {
  test("a group with a hidden member is hidden, by its members", async () => {
    incoming(FAMILY, BOB);
    store.setThreadMembers(FAMILY, [BOB, MOM]);
    incoming(CLUB, BOB);
    store.setThreadMembers(CLUB, [BOB]);
    store.setThreadTitle(FAMILY, "Family");
    await core.call("agents.hide", { contactId: "mom" }, desktop);
    expect(await agentThreads()).toEqual([CLUB]);
    expect((await core.call("group.list", {}, agent)).map((g) => g.threadKey)).toEqual([]);
    expect((await errorOf(core.call("thread.get", { key: "Family" }, agent))).code).toBe(
      "NOT_FOUND",
    );
    expect(store.getThread(FAMILY)).toMatchObject({
      hiddenFromAgents: true,
      hiddenBy: "person",
      hiddenPerson: { label: "Mom" },
    });
    // Hidden only through Mom: showing the group itself can't help.
    const conflict = await errorOf(core.call("agents.show", { groupKey: FAMILY }, desktop));
    expect(conflict.code).toBe("CONFLICT");
    expect((await core.call("agents.hidden", {}, desktop)).groups).toEqual([]);
  });

  test("a group with a hidden person on its roster is hidden", async () => {
    incoming(FAMILY, BOB);
    store.recordGroup(FAMILY, { named: true, name: "Family", participants: [] });
    store.setGroupRoster(FAMILY, [BOB, STRANGER]);
    // Members change with the next sender, but the roster still names them.
    store.setThreadMembers(FAMILY, [BOB]);
    expect(await agentThreads()).toContain(FAMILY);
    await core.call("agents.hide", { handle: STRANGER }, desktop);
    expect(await agentThreads()).not.toContain(FAMILY);
    expect(await core.call("group.list", {}, agent)).toEqual([]);
    expect(store.getThread(FAMILY)?.hiddenPerson?.label).toBe("+12065550199");
  });

  test("hiding a group itself, by name, and showing it again", async () => {
    incoming(CLUB, BOB);
    store.setThreadTitle(CLUB, "Book club");
    const hidden = await core.call("agents.hide", { target: "book club" }, cli);
    expect(hidden).toEqual({
      changed: true,
      person: null,
      group: { threadKey: CLUB, title: "Book club" },
      requeued: 0,
    });
    expect(store.getThread(CLUB)).toMatchObject({ hiddenFromAgents: true, hiddenBy: "group" });
    expect(await agentThreads()).toEqual([]);
    expect((await core.call("agents.hidden", {}, desktop)).groups).toEqual([hidden.group]);
    expect((await core.call("agents.hide", { groupKey: CLUB }, desktop)).changed).toBe(false);
    expect(await core.call("agents.show", { groupKey: "Book club" }, desktop)).toEqual({
      changed: true,
    });
    expect(await agentThreads()).toEqual([CLUB]);
  });

  test("hidden always wins over the read scope", async () => {
    incoming(FAMILY, BOB);
    store.setThreadMembers(FAMILY, [BOB, MOM]);
    await core.call("agents.hide", { contactId: "mom" }, desktop);
    for (const read of ["contacts", "known", "all"] as const) {
      await agents({ read });
      expect(core.agentThreadAccess(agent, FAMILY)).toBe("hidden");
      expect(core.agentThreadAccess(agent, MOM)).toBe("hidden");
    }
  });
});

describe("contact changes", () => {
  test("an edited card (a new id) keeps them hidden, numbers it gained included", async () => {
    const { person } = await core.call("agents.hide", { contactId: "mom" }, desktop);
    const NEW_NUMBER = "tel:+12065550122";
    // iOS has no stable id: the edited card is a new contact. She dropped her work number.
    store.replaceContacts([contact("mom-2", "Mum", [MOM, MOM_EMAIL, NEW_NUMBER]), BOB_CARD]);
    const [after] = (await core.call("agents.hidden", {}, desktop)).people;
    expect(after).toMatchObject({ id: person!.id, contactId: "mom-2", label: "Mum" });
    // The number she dropped stays hidden; the one she gained is hidden too.
    expect(after!.handles).toEqual([MOM_EMAIL, MOM, MOM_WORK, NEW_NUMBER].sort());
    expect(core.agentThreadAccess(agent, NEW_NUMBER)).toBe("hidden");
    expect(core.agentThreadAccess(agent, MOM_WORK)).toBe("hidden");
    expect((await core.call("contact.list", {}, agent)).map((c) => c.id)).toEqual(["bob"]);
  });

  test("a hidden raw number saved to a contact hides the contact", async () => {
    await core.call("agents.hide", { handle: STRANGER }, desktop);
    store.replaceContacts([
      MOM_CARD,
      BOB_CARD,
      contact("sam", "Sam", [STRANGER, "tel:+12065550133"]),
    ]);
    const [person] = (await core.call("agents.hidden", {}, desktop)).people;
    expect(person).toMatchObject({ contactId: "sam", label: "Sam" });
    expect(person!.handles).toEqual([STRANGER, "tel:+12065550133"].sort());
    expect(await core.call("contact.search", { query: "Sam" }, agent)).toEqual([]);
  });

  test("two hidden people merged into one card become one", async () => {
    await core.call("agents.hide", { contactId: "mom" }, desktop);
    await core.call("agents.hide", { contactId: "bob" }, desktop);
    expect((await core.call("agents.hidden", {}, desktop)).people).toHaveLength(2);
    store.replaceContacts([contact("both", "Mom and Bob", [MOM, BOB])]);
    const people = (await core.call("agents.hidden", {}, desktop)).people;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ contactId: "both", label: "Mom and Bob" });
    expect(people[0]!.handles).toEqual([BOB, MOM_EMAIL, MOM, MOM_WORK].sort());
  });

  test("a deleted contact stays hidden, by name and numbers, until the user shows them", async () => {
    incoming(MOM);
    const { person } = await core.call("agents.hide", { contactId: "mom" }, desktop);
    store.replaceContacts([BOB_CARD]);
    const [after] = (await core.call("agents.hidden", {}, desktop)).people;
    expect(after).toMatchObject({
      id: person!.id,
      label: "Mom",
      contactId: null,
      contactRemoved: true,
    });
    expect(after!.handles).toHaveLength(3);
    expect(await agentThreads()).toEqual([]);
    expect(await core.call("agents.show", { target: "mom" }, cli)).toEqual({ changed: true });
    expect(await agentThreads()).toEqual([MOM]);
  });
});

describe("sends to hidden people", () => {
  test("Full access with send: always still makes them drafts, noted hidden", async () => {
    incoming(MOM);
    await core.call("agents.hide", { contactId: "mom" }, desktop);
    const result = await core.call("message.send", { to: MOM_WORK, text: "hi" }, agent);
    expect(result.outcome).toBe("queued");
    expect(result.draft).not.toHaveProperty("note");
    expect(result.draft).toMatchObject({ threadKey: null, state: "queued" });
    expect(store.getAgentDraft(result.draft!.id)?.note).toBe("hidden");
    // Groups with them too can't be sent to anyway; others still go at once.
    expect((await core.call("message.send", { to: BOB, text: "hi" }, agent)).outcome).toBe("sent");
    expect(pushed).toEqual(["+12065550102: hi"]);
  });

  test("hiding someone takes back agents' sends to them still waiting to go", async () => {
    await agents({ send: "always", sendDelaySeconds: 10 });
    incoming(MOM);
    const toMom = await core.call("message.send", { to: MOM, text: "soon" }, agent);
    const toBob = await core.call("message.send", { to: BOB, text: "soon" }, agent);
    expect([toMom.outcome, toBob.outcome]).toEqual(["scheduled", "scheduled"]);
    // The user's own message from an agent draft is theirs: it stays.
    await agents({ send: "approve", sendDelaySeconds: 10 });
    const queued = await core.call("message.send", { to: MOM_WORK, text: "theirs" }, agent);
    await core.call("draft.send", { id: queued.draft!.id }, desktop);

    const hidden = await core.call("agents.hide", { contactId: "mom" }, desktop);
    expect(hidden.requeued).toBe(1);
    expect(store.getAgentDraft(toMom.draft!.id)).toMatchObject({ state: "queued", note: "hidden" });
    expect(store.getMessage(toMom.message!.id)).toBeNull();
    expect(store.getAgentDraft(toBob.draft!.id)?.state).toBe("scheduled");
    expect(store.getAgentDraft(queued.draft!.id)?.state).toBe("scheduled");
    // The agent can't read it any more.
    const [mine] = (await core.call("draft.list", { states: ["queued"] }, agent)).filter(
      (d) => d.id === toMom.draft!.id,
    );
    expect(mine).not.toHaveProperty("text");
  });
});

describe("settings for agents", () => {
  test("agents get only the agent policy, at every access level", async () => {
    for (const access of ["off", "readOnly", "assistant", "full"] as const) {
      await core.call("settings.set", { agents: { access }, sendDelaySeconds: 5 }, cli);
      const seen = await core.call("settings.get", {}, agent);
      expect(Object.keys(seen)).toEqual(["agents"]);
      expect(seen.agents.access).toBe(access);
    }
    expect(await core.call("settings.get", {}, desktop)).toMatchObject({
      sendDelaySeconds: 5,
      defaultRegion: "US",
      notifications: { preview: "full" },
    });
  });
});

describe("migration", () => {
  test("hidden one-to-one conversations become hidden people; hidden groups stay", () => {
    const db = nodeSqliteDb(new DatabaseSync(":memory:"));
    migrate(db, MIGRATIONS.slice(0, 8));
    const old = Store.open(db, { now: () => t });
    old.replaceContacts([MOM_CARD, BOB_CARD]);
    for (const key of [MOM, MOM_EMAIL, STRANGER, BOB]) old.ensureThread(key);
    old.ensureThread(FAMILY, "group");
    db.exec("UPDATE threads SET agent_hidden = 1 WHERE key IN (?, ?, ?, ?)", [
      MOM,
      MOM_EMAIL,
      STRANGER,
      FAMILY,
    ]);
    // As version 8 left it, then upgraded.
    db.execBatch(
      "DROP TABLE contact_photos; DROP TABLE agent_hidden_handles; DROP TABLE agent_hidden_people; PRAGMA user_version = 8",
    );
    migrate(db);
    const store = Store.open(db, { now: () => t });
    const people = store.listHiddenPeople();
    expect(people.map((p) => [p.label, p.contactId, p.handles])).toEqual([
      ["+12065550199", null, [STRANGER]],
      ["Mom", "mom", [MOM_EMAIL, MOM, MOM_WORK].sort()],
    ]);
    expect(people.every((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/.test(p.id))).toBe(
      true,
    );
    expect(store.isThreadHiddenFromAgents(MOM_WORK)).toBe(true);
    expect(store.isThreadHiddenFromAgents(BOB)).toBe(false);
    // Direct rows no longer carry the flag; the group keeps it.
    const flags = db.query<{ key: string; agent_hidden: number }>(
      "SELECT key, agent_hidden FROM threads WHERE agent_hidden = 1",
    );
    expect(flags).toEqual([{ key: FAMILY, agent_hidden: 1 }]);
    expect(store.getThread(FAMILY)).toMatchObject({ hiddenFromAgents: true, hiddenBy: "group" });
  });
});

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
  EventBus,
  Outbox,
  QUEUE_CAP_PER_AGENT,
  QUEUE_CAP_PER_CONVERSATION,
  Store,
  nodeSqliteDb,
  type MapLinkHandle,
} from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "tincan" };
const desktop: ClientInfo = { kind: "desktop", name: "tincan-desktop" };
const agent: ClientInfo = { kind: "mcp", name: "Claude Code" };
const other: ClientInfo = { kind: "mcp", name: "Other Agent" };
const ALICE = "tel:+12065550101";
const BOB = "tel:+12065550102";
const NEW = "tel:+12065550199";
const T0 = 1_780_000_000_000;

let t = T0;
let store: Store;
let core: Core;
let outbox: Outbox;
let pushed: Array<{ to: string[]; body: string }>;
let events: TincanEvent[];
let mapHandle = 0;

const link = {
  pushMessage: async (recipients: string[], body: string) => {
    pushed.push({ to: recipients, body });
    return "accepted" as const;
  },
} as unknown as MapLinkHandle;

function incoming(threadKey: string, body = "hello"): void {
  mapHandle++;
  t += 1000;
  store.insertMessage({
    threadKey,
    direction: "incoming",
    sender: threadKey,
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
    // Full access, so these tests can use raw keys; the ones about limits pass `assistant`.
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

function draftEvents(): Array<{ id: string; state: string }> {
  return events.flatMap((e) =>
    e.event === "draft.changed" ? [{ id: e.data.id, state: e.data.state }] : [],
  );
}

beforeEach(async () => {
  t = T0;
  pushed = [];
  events = [];
  store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => t });
  store.replaceContacts([
    {
      id: "alice",
      name: "Alice Smith",
      favorite: false,
      handles: [{ handle: ALICE, label: null }],
    },
  ]);
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
  await agents({ send: "approve", sendDelaySeconds: 0 });
});

afterEach(async () => {
  outbox.stop();
  await core.close();
});

describe("agent sends", () => {
  test("never wait: a send that needs the user is queued, and the agent learns how it ended", async () => {
    incoming(ALICE);
    const result = await core.call("message.send", { to: ALICE, text: "On my way" }, agent);
    expect(result).toMatchObject({
      outcome: "queued",
      draft: {
        threadKey: ALICE,
        to: ALICE,
        agentName: "Claude Code",
        intent: "send",
        body: "On my way",
        text: "On my way",
        edited: false,
        revision: 0,
        state: "queued",
        resolvedAt: null,
      },
    });
    expect(result.draft!.id).toMatch(/^drf_[0-9a-f-]{36}$/);
    expect(result).not.toHaveProperty("message");
    expect(pushed).toEqual([]);

    // The agent waits for an outcome while the user edits and sends it.
    const id = result.draft!.id;
    const waiting = core.call("draft.get", { id, wait: 5 }, agent);
    const [queued] = await core.call("draft.list", {}, desktop);
    const edited = await core.call(
      "draft.update",
      { id, text: "On my way, 10 min", revision: queued!.revision },
      desktop,
    );
    expect(edited).toMatchObject({ edited: true, revision: 1, body: "On my way" });
    const sent = await core.call(
      "draft.send",
      { id, text: "On my way, 10 min", revision: 1 },
      desktop,
    );
    expect(sent.outcome).toBe("sent");
    expect(sent.message).toMatchObject({
      status: "sent",
      body: "On my way, 10 min",
      agent: { name: "Claude Code", edited: true, via: "user" },
    });
    // The wait ends at the first change (it went to the outbox); by now it has gone.
    expect((await waiting).state).toBe("scheduled");
    const outcome = await core.call("draft.get", { id }, agent);
    expect(outcome).toMatchObject({ state: "sent", edited: true, text: "On my way, 10 min" });
    expect(outcome.messageId).toBe(sent.message.id);
    expect(pushed).toEqual([{ to: ["+12065550101"], body: "On my way, 10 min" }]);
    expect(draftEvents().map((e) => e.state)).toEqual(["queued", "queued", "scheduled", "sent"]);
  });

  test("draft.get without a change returns after its wait", async () => {
    const { draft } = await core.call("message.send", { to: ALICE, text: "x" }, agent);
    const started = Date.now();
    const same = await core.call("draft.get", { id: draft!.id, wait: 1 }, agent);
    expect(same.state).toBe("queued");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("the agent sees discarded drafts, but not what the user typed outside what it may read", async () => {
    incoming(BOB);
    await agents({ read: "contacts", send: "approve" });
    const { draft } = await core.call("message.send", { to: BOB, text: "hi" }, agent);
    await core.call("draft.update", { id: draft!.id, text: "private edit", revision: 0 }, desktop);
    const view = await core.call("draft.get", { id: draft!.id }, agent);
    expect(view).toMatchObject({ threadKey: null, edited: true, body: "hi" });
    expect(view).not.toHaveProperty("text");
    await core.call("draft.discard", { id: draft!.id }, desktop);
    expect((await core.call("draft.get", { id: draft!.id }, agent)).state).toBe("discarded");
    expect(await core.call("draft.list", {}, agent)).toEqual([]);
    expect(
      (await core.call("draft.list", { states: ["discarded"] }, agent)).map((d) => d.id),
    ).toEqual([draft!.id]);
  });

  test("the same text to the same recipient while queued is the same draft, and costs nothing", async () => {
    await core.call("settings.set", { agents: { access: "assistant", sendLimit: 2 } }, cli);
    const alice = core.handleMasker.mask(ALICE);
    const first = await core.call("message.send", { to: alice, text: "same" }, agent);
    const again = await core.call("message.send", { to: "Alice Smith", text: "same" }, agent);
    expect(again.draft!.id).toBe(first.draft!.id);
    await core.call("message.send", { to: alice, text: "different" }, agent);
    expect(await core.call("draft.list", {}, desktop)).toHaveLength(2);
    // Two sends counted, not three.
    const bob = core.handleMasker.mask(BOB);
    expect((await errorOf(core.call("message.send", { to: bob, text: "x" }, agent))).code).toBe(
      "BUSY",
    );
  });

  test("queues are capped per conversation and per agent", async () => {
    await core.call("settings.set", { agents: { sendLimit: null } }, cli);
    for (let i = 0; i < QUEUE_CAP_PER_CONVERSATION; i++) {
      await core.call("message.send", { to: ALICE, text: `a${i}` }, i % 2 ? agent : other);
    }
    const full = await errorOf(core.call("message.send", { to: ALICE, text: "more" }, agent));
    expect(full.code).toBe("BUSY");
    expect(full.message).toContain(`${QUEUE_CAP_PER_CONVERSATION}`);
    // Sending one frees a place.
    const [oldest] = await core.call("draft.list", { threadKey: ALICE }, desktop);
    await core.call("draft.send", { id: oldest!.id }, desktop);
    await core.call("message.send", { to: ALICE, text: "now fits" }, agent);

    await core.call("draft.list", {}, desktop);
    const mine = (await core.call("draft.list", {}, agent)).length;
    let n = 0;
    for (; mine + n < QUEUE_CAP_PER_AGENT; n++) {
      await core.call("message.send", { to: `tel:+1206555${3000 + n}`, text: "x" }, agent);
    }
    const perAgent = await errorOf(
      core.call("message.send", { to: "tel:+12065559999", text: "x" }, agent),
    );
    expect(perAgent.code).toBe("BUSY");
    expect(perAgent.message).toContain(`${QUEUE_CAP_PER_AGENT}`);
    // Another agent still has room.
    await core.call("message.send", { to: "tel:+12065559999", text: "x" }, other);
  });

  test("direct sends wait out the agent delay and can be cancelled, or edited back into the queue", async () => {
    await agents({ send: "always", sendDelaySeconds: 10 });
    const direct = await core.call("message.send", { to: NEW, text: "hello" }, agent);
    expect(direct.outcome).toBe("scheduled");
    expect(direct.sendAt).toBe(T0 + 10_000);
    expect(direct.message).toMatchObject({
      status: "scheduled",
      sendAt: T0 + 10_000,
      agent: { edited: false, via: "policy" },
    });
    expect(direct.message!.agent).not.toHaveProperty("name");
    expect(direct.draft).toMatchObject({ state: "scheduled", intent: "send" });

    const id = core.handleMasker.unmaskMessageId(direct.message!.id) ?? direct.message!.id;
    const cancelled = await core.call("message.cancel", { id }, desktop);
    expect(cancelled).toMatchObject({
      threadKey: NEW,
      text: "hello",
      draft: { state: "cancelled" },
    });
    expect(store.getMessage(id)).toBeNull();
    expect((await core.call("draft.get", { id: direct.draft!.id }, agent)).state).toBe("cancelled");

    // "Edit": the user takes the agent's send back into the composer.
    const second = await core.call("message.send", { to: NEW, text: "again" }, agent);
    const secondId = store.agentDraftForMessage(
      core.handleMasker.unmaskMessageId(second.message!.id) ?? second.message!.id,
    )!.messageId!;
    const edit = await core.call("message.cancel", { id: secondId, requeue: true }, desktop);
    expect(edit.draft).toMatchObject({ state: "queued", text: "again" });
    expect(pushed).toEqual([]);
  });

  test("Undo puts a user-sent agent draft back at the front of its queue, edits kept", async () => {
    await agents({ send: "approve", sendDelaySeconds: 10 });
    const a = await core.call("message.send", { to: ALICE, text: "first" }, agent);
    await core.call("message.send", { to: ALICE, text: "second" }, agent);
    const sent = await core.call(
      "draft.send",
      { id: a.draft!.id, text: "first, edited", revision: 0 },
      desktop,
    );
    expect(sent).toMatchObject({ outcome: "scheduled", draft: { state: "scheduled" } });
    expect((await core.call("draft.list", { states: ["queued"] }, desktop)).length).toBe(1);
    const undo = await core.call("message.cancel", { id: sent.message.id, requeue: true }, desktop);
    expect(undo).toMatchObject({ text: "first, edited", draft: { state: "queued", edited: true } });
    const queue = await core.call("thread.get", { key: ALICE }, desktop);
    expect(queue.drafts!.map((d) => d.text)).toEqual(["first, edited", "second"]);

    // Send now skips the rest of the delay.
    const again = await core.call("draft.send", { id: a.draft!.id }, desktop);
    const now = await core.call("message.sendNow", { id: again.message.id }, desktop);
    expect(now.status).toBe("sent");
    expect((await core.call("draft.get", { id: a.draft!.id }, agent)).state).toBe("sent");
    // Already sent: too late to cancel.
    expect(
      (await errorOf(core.call("message.cancel", { id: again.message.id }, desktop))).code,
    ).toBe("NOT_FOUND");
  });

  test("the user's own sends use their delay, and Undo gives the text back", async () => {
    await core.call("settings.set", { sendDelaySeconds: 5 }, cli);
    const result = await core.call("message.send", { to: ALICE, text: "mine" }, desktop);
    expect(result).toMatchObject({ outcome: "scheduled", sendAt: T0 + 5000 });
    expect(result.message!.agent).toBeUndefined();
    const undo = await core.call("message.cancel", { id: result.message!.id }, desktop);
    expect(undo).toEqual({ id: result.message!.id, threadKey: ALICE, text: "mine" });
    // No delay: straight to the phone.
    await core.call("settings.set", { sendDelaySeconds: 0 }, cli);
    expect((await core.call("message.send", { to: ALICE, text: "now" }, desktop)).outcome).toBe(
      "sent",
    );
  });

  test("a draft.update or draft.send with a stale revision is refused", async () => {
    const { draft } = await core.call("message.send", { to: ALICE, text: "x" }, agent);
    await core.call("draft.update", { id: draft!.id, text: "y", revision: 0 }, desktop);
    for (const call of [
      core.call("draft.update", { id: draft!.id, text: "z", revision: 0 }, desktop),
      core.call("draft.send", { id: draft!.id, text: "z", revision: 0 }, desktop),
    ]) {
      expect((await errorOf(call)).code).toBe("CONFLICT");
    }
    // Editing back to the original isn't an edit.
    const back = await core.call(
      "draft.update",
      { id: draft!.id, text: "x", revision: 1 },
      desktop,
    );
    expect(back).toMatchObject({ edited: false, revision: 2 });
  });

  test("discard and restore; agents may discard only their own queued drafts", async () => {
    const { draft } = await core.call("message.send", { to: ALICE, text: "x" }, agent);
    expect((await errorOf(core.call("draft.discard", { id: draft!.id }, other))).code).toBe(
      "NOT_FOUND",
    );
    expect((await core.call("draft.discard", { id: draft!.id }, agent)).state).toBe("discarded");
    const restored = await core.call("draft.restore", { id: draft!.id }, desktop);
    expect(restored.state).toBe("queued");
    expect((await errorOf(core.call("draft.restore", { id: draft!.id }, agent))).code).toBe(
      "PERMISSION_DENIED",
    );
    await core.call("draft.send", { id: draft!.id }, desktop);
    expect((await errorOf(core.call("draft.discard", { id: draft!.id }, agent))).code).toBe(
      "CONFLICT",
    );
    // The internal commands stay out of agents' reach.
    for (const name of ["draft.update", "draft.send", "message.cancel", "message.sendNow"]) {
      const error = await errorOf(core.run(name, { id: draft!.id, text: "x", revision: 0 }, agent));
      expect(error.code).toBe("PERMISSION_DENIED");
    }
  });
});

describe("attribution", () => {
  test("an agent draft the user sends, edited or not, never unlocks replied or known", async () => {
    incoming(BOB);
    await agents({ read: "known", send: "replied", handles: "visible" });
    for (const text of ["agent text", "agent text, rewritten"]) {
      const { draft } = await core.call("message.send", { to: BOB, text: "agent text" }, agent);
      expect(draft!.state).toBe("queued");
      await core.call("draft.send", { id: draft!.id, text }, desktop);
    }
    const messages = store.listMessages(BOB).filter((m) => m.direction === "outgoing");
    expect(messages.map((m) => m.agent)).toEqual([
      { name: "Claude Code", edited: true, via: "user" },
      { name: "Claude Code", edited: false, via: "user" },
    ]);
    expect(store.hasUserSentMessage(BOB)).toBe(false);
    // Agents see how an agent message went, never the agent's name.
    await agents({ read: "all", send: "replied" });
    const [listedBob] = (await core.call("thread.list", {}, agent)).filter((th) => th.key === BOB);
    expect(listedBob!.lastMessage!.agent).toEqual({ edited: true, via: "user" });
    expect((await core.call("message.list", { threadKey: BOB }, agent))[0]!.agent).toEqual({
      edited: true,
      via: "user",
    });
    await agents({ read: "known", send: "replied" });
    // Still outside `known`, and the next send still queues.
    expect((await errorOf(core.call("thread.get", { key: BOB }, agent))).code).toBe("NOT_FOUND");
    expect((await core.call("message.send", { to: BOB, text: "next" }, agent)).outcome).toBe(
      "queued",
    );
    // Once the user writes themselves, it's theirs to read and reply in.
    await core.call("message.send", { to: BOB, text: "typed by me" }, desktop);
    expect(store.hasUserSentMessage(BOB)).toBe(true);
    expect((await core.call("message.send", { to: BOB, text: "reply" }, agent)).outcome).toBe(
      "sent",
    );
  });

  test("a scheduled message of the user's doesn't count as written until it goes", async () => {
    incoming(BOB);
    await agents({ read: "known", send: "replied" });
    await core.call("settings.set", { sendDelaySeconds: 30 }, cli);
    const { message } = await core.call("message.send", { to: BOB, text: "soon" }, desktop);
    expect(store.hasUserSentMessage(BOB)).toBe(false);
    expect(await core.call("message.search", { query: "soon" }, desktop)).toEqual([]);
    await core.call("message.sendNow", { id: message!.id }, desktop);
    expect(store.hasUserSentMessage(BOB)).toBe(true);
    expect(await core.call("message.search", { query: "soon" }, desktop)).toHaveLength(1);
  });
});

describe("message.draft.save for agents", () => {
  test("always queues, even when the agent may send directly", async () => {
    await agents({ access: "full", send: "always" });
    const saved = await core.call("message.draft.save", { threadKey: ALICE, text: "hi" }, agent);
    expect(saved).toMatchObject({ saved: true, deleted: false, draft: { intent: "draft" } });
    expect(saved.draft!.state).toBe("queued");
    expect(pushed).toEqual([]);
  });

  test("updates its own untouched draft, by id or by conversation, and never an edited one", async () => {
    const first = await core.call("message.draft.save", { threadKey: ALICE, text: "a" }, agent);
    const byKey = await core.call("message.draft.save", { threadKey: ALICE, text: "b" }, agent);
    expect(byKey.draft!.id).toBe(first.draft!.id);
    const byId = await core.call("message.draft.save", { id: first.draft!.id, text: "c" }, agent);
    expect(byId.draft).toMatchObject({ id: first.draft!.id, body: "c", text: "c", revision: 2 });

    // Once the user edits it, it's off limits: a new save adds a draft beside it.
    await core.call("draft.update", { id: first.draft!.id, text: "user's", revision: 2 }, desktop);
    const conflict = await errorOf(
      core.call("message.draft.save", { id: first.draft!.id, text: "d" }, agent),
    );
    expect(conflict.code).toBe("CONFLICT");
    const added = await core.call("message.draft.save", { threadKey: ALICE, text: "d" }, agent);
    expect(added.draft!.id).not.toBe(first.draft!.id);
    // Another agent's draft isn't there for it.
    expect(
      (await errorOf(core.call("message.draft.save", { id: added.draft!.id, text: "e" }, other)))
        .code,
    ).toBe("NOT_FOUND");
    expect((await core.call("draft.list", { threadKey: ALICE }, desktop)).length).toBe(2);
  });

  test("empty text withdraws the agent's own draft, never the user's", async () => {
    await core.call("message.draft.save", { threadKey: ALICE, text: "mine" }, desktop);
    const saved = await core.call("message.draft.save", { threadKey: ALICE, text: "x" }, agent);
    const withdrawn = await core.call("message.draft.save", { threadKey: ALICE, text: "" }, agent);
    expect(withdrawn).toMatchObject({ saved: false, deleted: true, draft: { state: "discarded" } });
    expect(store.getAgentDraft(saved.draft!.id)!.state).toBe("discarded");
    expect(store.getDraft(ALICE)).toBe("mine");
    // Nothing left to withdraw: still fine.
    expect(
      await core.call("message.draft.save", { threadKey: ALICE, text: "" }, agent),
    ).toMatchObject({ saved: false, deleted: true });
  });

  test("drafts to a recipient with no conversation yet, and refuses groups", async () => {
    const saved = await core.call("message.draft.save", { to: NEW, text: "hello" }, agent);
    expect(saved).toMatchObject({ threadKey: null, draft: { threadKey: null, to: NEW } });
    const [forUser] = await core.call("draft.list", { threadKey: NEW }, desktop);
    expect(forUser).toMatchObject({ threadKey: null, to: NEW, text: "hello" });
    // Once the conversation exists, the draft belongs to it.
    incoming(NEW);
    expect((await core.call("draft.list", { threadKey: NEW }, desktop))[0]!.threadKey).toBe(NEW);

    const group = "group:name:friends";
    store.ensureThread(group);
    const error = await errorOf(
      core.call("message.draft.save", { threadKey: group, text: "hi" }, agent),
    );
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      (
        await errorOf(
          core.call("message.draft.save", { threadKey: ALICE, to: NEW, text: "x" }, agent),
        )
      ).code,
    ).toBe("INVALID_INPUT");
    expect((await errorOf(core.call("message.draft.save", { text: "x" }, agent))).code).toBe(
      "INVALID_INPUT",
    );
  });

  test("draft creation has its own rate limit", async () => {
    for (let i = 0; i < 30; i++) {
      await core.call(
        "message.draft.save",
        { to: `tel:+1206555${4000 + (i % 5)}`, text: `${i}` },
        agent,
      );
    }
    const busy = await errorOf(core.call("message.draft.save", { to: NEW, text: "x" }, agent));
    expect(busy.code).toBe("BUSY");
    expect(busy.message).toContain("drafts");
    // Withdrawing is never limited.
    await core.call("message.draft.save", { to: "tel:+12065554000", text: "" }, agent);
  });

  test("a queued draft to a conversation hidden from agents leaves it hidden from them", async () => {
    incoming(ALICE);
    await core.call("agents.hide", { handle: ALICE }, desktop);
    await agents({ access: "full", send: "approve" });
    const queued = await core.call("message.send", { to: ALICE, text: "for you" }, agent);
    expect(queued.outcome).toBe("queued");
    const [thread] = await core.call("thread.list", {}, desktop);
    expect(thread).toMatchObject({ key: ALICE, hiddenFromAgents: true });
    expect(await core.call("thread.list", {}, agent)).toEqual([]);
    expect(store.isThreadHiddenFromAgents(ALICE)).toBe(true);
  });
});

describe("events", () => {
  test("draft.changed carries the conversation key for the app", async () => {
    const bus = new EventBus();
    expect(bus.seq).toBe(0);
    const { draft } = await core.call("message.send", { to: NEW, text: "x" }, agent);
    const event = events.find((e) => e.event === "draft.changed");
    expect(event?.data).toEqual({ id: draft!.id, state: "queued", threadKey: NEW });
  });
});

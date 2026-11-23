import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { TincanError, type ClientInfo, type Message } from "@beyland/tincan-protocol";
import {
  AgentRateLimiter,
  CODE_REDACTED,
  Core,
  HandleMasker,
  MIGRATIONS,
  Store,
  isVerificationCodeMessage,
  migrate,
  nodeSqliteDb,
  redactForAgents,
  type NewMessage,
} from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "test" };
const mcp: ClientInfo = { kind: "mcp", name: "agent" };
const ALICE = "tel:+12065550101";
const BOB = "tel:+12065550102";
const T0 = 1_780_000_000_000;

let t = T0;
let store: Store;
let core: Core;

beforeEach(async () => {
  t = T0;
  store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now: () => t });
  core = await Core.open({ version: "1.0.0", store, now: () => t });
  await core.call(
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
});

let handle = 0;
function incoming(overrides: Partial<NewMessage> = {}): Message {
  handle++;
  const { message } = store.insertMessage({
    threadKey: ALICE,
    direction: "incoming",
    sender: overrides.threadKey ?? ALICE,
    body: "hello",
    sentAt: t,
    receivedAt: t,
    source: "map",
    status: "received",
    read: false,
    device: "AA:BB:CC:DD:EE:FF",
    mapHandle: `05${String(handle).padStart(14, "0")}`,
    folder: "inbox",
    ...overrides,
  });
  if (!message) throw new Error("not inserted");
  return message;
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

describe("verification codes and sign-in links", () => {
  test.each([
    "Your verification code is 482913",
    "Enter 482913 to confirm your identity",
    "DoorDash: 482913 is your confirmation",
    "Your code: 48 29 13",
    "Use 4-8-2-9-1-3 to sign in",
    "Your login code is ４８２９１３",
    "Your code is ٤٨٢٩١٣",
    "G-482913 is your Google verification code",
    "Your password reset token is K7Q2ZP",
  ])("redacts %j", (text) => {
    expect(isVerificationCodeMessage(text)).toBe(true);
    expect(redactForAgents(text)).toBe(CODE_REDACTED);
  });

  test.each([
    ["Click to sign in to Slack: https://slack.com/z/AbC123xyz", "Slack:"],
    ["Reset your password here: https://acme.example/reset?t=Zx81", "Reset your password here:"],
    ["Your magic link: acme.example/login/abcdef", "Your magic link:"],
  ])("hides the link in %j", (text, kept) => {
    const out = redactForAgents(text);
    expect(out).toContain(kept);
    expect(out).toContain("[Link hidden from AI agents]");
    expect(out).not.toMatch(/AbC123xyz|Zx81|abcdef/);
  });

  test.each([
    "see you at 6:30",
    "I'm at 1600 Pennsylvania Ave NW, Washington",
    "Call me on 206-555-0101",
    "Check this out https://example.com/article/12345",
    "Order total $482.91",
    "The meeting is on 2026-11-21 in room 4012",
    "Can you confirm? The hotel is rated 4.5/5",
  ])("leaves %j alone", (text) => {
    expect(isVerificationCodeMessage(text)).toBe(false);
    expect(redactForAgents(text)).toBe(text);
  });

  test("stays fast on long hostile input", () => {
    const hostile = `code ${"1 ".repeat(20_000)}x ${"a.".repeat(20_000)}/ ${"9-".repeat(20_000)}`;
    const started = performance.now();
    redactForAgents(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("agents don't find sign-in links by searching for them", async () => {
    incoming({ body: "Sign in to Acme: https://acme.example/m/SECRETTOKEN" });
    expect(await core.call("message.search", { query: "SECRETTOKEN" }, mcp)).toEqual([]);
    expect(await core.call("message.search", { query: "Acme" }, mcp)).toEqual([]);
    expect(await core.call("message.search", { query: "Acme" }, cli)).toHaveLength(1);
    const [listed] = await core.call(
      "message.list",
      { threadKey: core.handleMasker.mask(ALICE) },
      mcp,
    );
    expect(listed!.body).toBe("Sign in to Acme: [Link hidden from AI agents]");
  });
});

describe("conversations hidden from agents", () => {
  test("stay in the user's list, and hidden from agents whatever new messages arrive", async () => {
    incoming({ body: "first" });
    const hidden = await core.call("agents.hide", { handle: ALICE }, cli);
    expect(hidden).toMatchObject({
      changed: true,
      person: { label: "+12065550101", contactId: null, contactRemoved: false, handles: [ALICE] },
      group: null,
      requeued: 0,
    });
    t += 1000;
    incoming({ body: "second" });
    expect(store.getThread(ALICE)).toMatchObject({
      hiddenFromAgents: true,
      hiddenBy: "person",
      hiddenPerson: { id: hidden.person!.id, label: "+12065550101" },
    });
    expect(store.getThread(ALICE)).not.toHaveProperty("hidden");
    // The user still sees it; agents don't.
    const [listed] = await core.call("thread.list", {}, cli);
    expect(listed).toMatchObject({ key: ALICE, hiddenFromAgents: true });
    expect(await core.call("thread.list", {}, mcp)).toEqual([]);
    const token = core.handleMasker.mask(ALICE);
    expect((await errorOf(core.call("thread.get", { key: token }, mcp))).code).toBe("NOT_FOUND");
    expect((await errorOf(core.call("message.list", { threadKey: token }, mcp))).code).toBe(
      "NOT_FOUND",
    );
    expect(await core.call("message.search", { query: "second" }, mcp)).toEqual([]);

    // Hiding it again changes nothing; showing it to agents brings it back for them.
    expect((await core.call("agents.hide", { target: ALICE }, cli)).changed).toBe(false);
    expect((await core.call("agents.show", { personId: hidden.person!.id }, cli)).changed).toBe(
      true,
    );
    expect(store.getThread(ALICE)).toEqual(
      expect.not.objectContaining({ hiddenBy: expect.anything() }),
    );
    expect(store.getThread(ALICE)).toMatchObject({ hiddenFromAgents: false });
    const [visible] = await core.call("thread.list", {}, mcp);
    expect(visible!.key).toBe(token);
    expect(visible).not.toHaveProperty("hiddenFromAgents");
    expect((await core.call("agents.show", { target: ALICE }, cli)).changed).toBe(false);
  });

  test("hiding and showing announce the change", async () => {
    incoming();
    const changed: unknown[] = [];
    core.events.subscribe((e) => void (e.event === "thread.changed" && changed.push(e.data)));
    const { person } = await core.call("agents.hide", { handle: ALICE }, cli);
    await core.call("agents.hide", { handle: ALICE }, cli);
    await core.call("agents.show", { personId: person!.id }, cli);
    expect(changed).toEqual([{ keys: [ALICE] }, { keys: [ALICE] }]);
  });

  test("agents can never hide, show or list who's hidden", async () => {
    incoming();
    const token = core.handleMasker.mask(ALICE);
    for (const call of [
      core.call("agents.hide", { target: token }, mcp),
      core.call("agents.show", { target: token }, mcp),
      core.call("agents.hidden", {}, mcp),
    ]) {
      expect((await errorOf(call)).code).toBe("PERMISSION_DENIED");
    }
    expect(store.getThread(ALICE)?.hiddenFromAgents).toBe(false);
  });

  test("stay hidden from agents after the conversation is deleted and starts again", async () => {
    incoming({ body: "first" });
    await core.call("agents.hide", { handle: ALICE }, cli);
    await core.call("thread.delete", { key: ALICE }, cli);
    t += 1000;
    incoming({ body: "new" });
    expect(await core.call("thread.list", {}, mcp)).toEqual([]);
    expect(store.getThread(ALICE)?.hiddenFromAgents).toBe(true);
  });

  test("migrating keeps conversations hidden before the upgrade hidden from agents", () => {
    const db = nodeSqliteDb(new DatabaseSync(":memory:"));
    migrate(db, MIGRATIONS.slice(0, 3));
    db.exec(
      `INSERT INTO threads (key, kind, hidden, created_at, origin, updated_at, change_seq)
       VALUES (?, 'direct', 1, 0, 'o', '0', 1), (?, 'direct', 0, 0, 'o', '0', 2)`,
      [ALICE, BOB],
    );
    const upgraded = Store.open(db);
    expect(upgraded.getThread(ALICE)?.hiddenFromAgents).toBe(true);
    expect(upgraded.getThread(BOB)?.hiddenFromAgents).toBe(false);
  });

  test("migrating brings hidden conversations back into the list, still hidden from agents", async () => {
    const CAROL = "tel:+12065550103";
    const DAVE = "tel:+12065550104";
    incoming({ threadKey: ALICE, sender: ALICE });
    incoming({ threadKey: BOB, sender: BOB });
    incoming({ threadKey: DAVE, sender: DAVE });
    store.ensureThread(CAROL);
    // As Tincan before the change left them: Alice hidden (so from agents too); Bob hidden
    // without agent_hidden, as moving messages and texting him from the phone left him; Carol
    // empty, left behind by moving her messages to a group.
    store.db.exec("UPDATE threads SET hidden = 1, agent_hidden = 1 WHERE key = ?", [ALICE]);
    store.db.exec("UPDATE threads SET hidden = 1 WHERE key IN (?, ?)", [BOB, CAROL]);
    store.db.execBatch(
      "DROP TABLE contact_photos; DROP TABLE agent_hidden_handles; DROP TABLE agent_hidden_people; PRAGMA user_version = 7",
    );
    migrate(store.db);

    const listed = await core.call("thread.list", {}, cli);
    expect(Object.fromEntries(listed.map((x) => [x.key, x.hiddenFromAgents]))).toEqual({
      [ALICE]: true,
      [BOB]: true,
      [DAVE]: false,
    });
    // Agents still see only what they saw before.
    const forAgents = await core.call("thread.list", {}, mcp);
    expect(forAgents.map((x) => x.key)).toEqual([core.handleMasker.mask(DAVE)]);
    expect(core.agentThreadAccess(mcp, CAROL)).toBe("hidden");
    // Carol comes back, visible to agents, with her next message.
    t += 1000;
    incoming({ threadKey: CAROL, sender: CAROL });
    expect(store.getThread(CAROL)?.hiddenFromAgents).toBe(false);
    expect(core.agentThreadAccess(mcp, CAROL)).toBeNull();
    expect((await core.call("thread.list", {}, cli)).map((x) => x.key)).toContain(CAROL);
  });
});

describe("opaque IDs", () => {
  test("tapbacks' targets are masked like message IDs", () => {
    const masker = new HandleMasker(store);
    const message = incoming();
    const masked = masker.maskMessage({ ...message, reactionTo: message.id });
    expect(masked.reactionTo).toBe(masker.maskMessageId(message.id));
    expect(masked.reactionTo).not.toBe(message.id);
  });

  test("resolve after a restart by lookup, and unknown tokens resolve to nothing", () => {
    const message = incoming();
    const before = new HandleMasker(store);
    const token = before.mask(ALICE);
    const msgToken = before.maskMessageId(message.id);
    const after = new HandleMasker(store);
    expect(after.unmask(token)).toBe(ALICE);
    expect(after.unmaskMessageId(msgToken)).toBe(message.id);
    expect(after.unmask("handle:AAAAAAAAAAAAAAAA")).toBeNull();
    expect(after.unmaskMessageId("msg:AAAAAAAAAAAAAAAA")).toBeNull();
    // A forged row can't redirect a token to another handle.
    store.saveAgentToken("handle:forged", BOB);
    expect(after.unmask("handle:forged")).toBeNull();
  });

  test("tokens handed out before Tincan remembered them still resolve", () => {
    incoming({ threadKey: BOB, sender: BOB });
    const token = new HandleMasker(store).mask(BOB);
    store.db.exec("DELETE FROM agent_tokens");
    store.setSetting("agent.tokensIndexed", false);
    const restarted = new HandleMasker(store);
    expect(restarted.unmask(token)).toBe(BOB);
    expect(store.getSetting("agent.tokensIndexed")).toBe(true);
  });
});

describe("contact masking", () => {
  test("masks numbers and emails inside names and details, and ignores digits in name searches", async () => {
    store.replaceContacts([
      {
        id: "mom",
        name: "Mom 206-555-0101",
        favorite: false,
        handles: [{ handle: ALICE, label: null }],
        details: {
          note: "Work line +1 (206) 555-0102, or mom@example.com",
          company: "Acme",
          addresses: [{ label: "home", value: "1 Main St, Seattle; call 2065550103" }],
          urls: [{ label: null, value: "mailto:mom@example.com" }],
        },
      },
    ]);
    const [found] = await core.call("contact.search", { query: "Mom" }, mcp);
    const text = JSON.stringify(found);
    expect(text).not.toMatch(/555|example\.com/);
    expect(found!.name).toMatch(/^Mom handle:/);
    expect(found!.details?.company).toBe("Acme");
    expect(found!.details?.addresses?.[0]?.value).toMatch(/^1 Main St, Seattle; call handle:/);

    // Digits never match inside names while handles are hidden.
    expect(await core.call("contact.search", { query: "206" }, mcp)).toEqual([]);
    expect(await core.call("contact.search", { query: "Mom 206" }, mcp)).toHaveLength(1);
    expect(await core.call("contact.search", { query: "mom@example.com" }, mcp)).toEqual([]);
    expect(await core.call("contact.search", { query: "206" }, cli)).toHaveLength(1);

    incoming({ body: "hi" });
    const [thread] = await core.call("thread.list", {}, mcp);
    expect(thread!.title).toMatch(/^Mom handle:/);
  });
});

describe("rate limits", () => {
  test("persist across restarts", () => {
    const limiter = new AgentRateLimiter(store, { send: { max: 1, windowMs: 60_000 } });
    limiter.reserve("send", t).commit(t);
    const restarted = new AgentRateLimiter(store, { send: { max: 1, windowMs: 60_000 } });
    expect(() => restarted.reserve("send", t + 1)).toThrow(/rate limit/);
    expect(() => restarted.reserve("send", t + 60_001).release()).not.toThrow();
  });

  test("cover agents' phone-side changes, not the user's", async () => {
    const limited = await Core.open({
      version: "1.0.0",
      store,
      now: () => t,
      agentLimits: {
        markRead: { max: 1, windowMs: 60_000 },
        mute: { max: 1, windowMs: 60_000 },
        sync: { max: 1, windowMs: 60_000 },
        contacts: { max: 1, windowMs: 60_000 },
      },
    });
    limited.attach({
      sync: {
        status: core.services.sync?.status as never,
        sync: async () => null,
        markReadOnPhone: async () => 0,
        trigger: () => {},
      },
      contacts: {
        sync: async () => ({ skipped: true, contacts: 0, changed: 0, removed: 0, photos: 0 }),
        lastSyncAt: null,
        lastError: null,
      },
    });
    limited.updateSettings({ agents: { manage: true } });
    incoming();
    const key = limited.handleMasker.mask(ALICE);
    await limited.call("thread.markRead", { key }, mcp);
    expect((await errorOf(limited.call("thread.markRead", { key }, mcp))).code).toBe("BUSY");
    await limited.call("thread.markRead", { key: ALICE }, cli);
    await limited.call("thread.mute", { key }, mcp);
    expect((await errorOf(limited.call("thread.mute", { key, muted: false }, mcp))).code).toBe(
      "BUSY",
    );
    await limited.call("contact.sync", { force: true }, mcp);
    expect((await errorOf(limited.call("contact.sync", {}, mcp))).code).toBe("BUSY");
    // sync.now with contacts counts against both limits, all or nothing.
    expect((await errorOf(limited.call("sync.now", { contacts: true }, mcp))).code).toBe("BUSY");
    await limited.call("sync.now", {}, mcp);
    expect((await errorOf(limited.call("sync.now", {}, mcp))).code).toBe("BUSY");
    await limited.close();
  });
});

describe("drafts", () => {
  test("agents never replace or delete the user's draft: theirs is a separate slot", async () => {
    incoming();
    const key = core.handleMasker.mask(ALICE);
    await core.call("message.draft.save", { threadKey: ALICE, text: "mine" }, cli);
    const saved = await core.call("message.draft.save", { threadKey: key, text: "agent's" }, mcp);
    expect(saved).toMatchObject({ threadKey: key, saved: true, draft: { state: "queued" } });
    await core.call("message.draft.save", { threadKey: key, text: "" }, mcp);
    expect(store.getDraft(ALICE)).toBe("mine");

    // An agent's own untouched draft it may change: the same draft, rewritten.
    const first = await core.call("message.draft.save", { threadKey: key, text: "a" }, mcp);
    const second = await core.call("message.draft.save", { threadKey: key, text: "b" }, mcp);
    expect(second.draft!.id).toBe(first.draft!.id);
    expect(second.draft).toMatchObject({ body: "b", text: "b", edited: false });
    expect(store.getDraft(ALICE)).toBe("mine");
  });

  test("the app sees which agent wrote each draft; agents see neither the user's nor others'", async () => {
    incoming();
    const key = core.handleMasker.mask(ALICE);
    const desktop: ClientInfo = { kind: "desktop", name: "tincan-desktop" };
    const claude: ClientInfo = { kind: "mcp", name: "Claude\u202e Code\n\t " };
    await core.call("message.draft.save", { threadKey: key, text: "On my way" }, claude);
    await core.call("message.draft.save", { threadKey: ALICE, text: "my own" }, desktop);
    const forApp = await core.call("thread.get", { key: ALICE }, desktop);
    expect(forApp.draft).toBe("my own");
    expect(forApp.thread.draft).toEqual({ text: "my own", updatedAt: expect.any(Number) });
    expect(forApp.drafts).toHaveLength(1);
    expect(forApp.drafts![0]).toMatchObject({ agentName: "Claude Code", text: "On my way" });
    const listed = await core.call("thread.list", {}, desktop);
    expect(listed[0]!.draft).toEqual({ text: "my own", updatedAt: expect.any(Number) });

    // Agents get none of it: not the user's draft on the thread, nor the queue.
    const forAgent = await core.call("thread.get", { key }, mcp);
    expect(forAgent).not.toHaveProperty("drafts");
    expect(forAgent.thread).not.toHaveProperty("draft");
    expect((await core.call("thread.list", {}, mcp))[0]).not.toHaveProperty("draft");
    // Another agent (by its name) doesn't see Claude's draft.
    expect(await core.call("draft.list", {}, mcp)).toEqual([]);
    expect(await core.call("draft.list", {}, claude)).toHaveLength(1);
    const other = await errorOf(core.call("draft.get", { id: forApp.drafts![0]!.id }, mcp));
    expect(other.code).toBe("NOT_FOUND");
  });

  test("an agent's send leaves the user's draft alone", async () => {
    const sent: string[] = [];
    core.attach({
      outbox: {
        send: async (key, body, options) => {
          sent.push(body);
          return store.queueOutgoing({
            threadKey: key,
            body,
            recipients: [key],
            agent: options?.agent,
            agentDraftId: options?.agentDraftId,
          });
        },
        retry: async (id) => store.getMessage(id)!,
        cancel: () => {
          throw new Error("unused");
        },
        sendNow: async (id) => store.getMessage(id)!,
        dropThread: () => {},
      },
    });
    store.queueOutgoing({ threadKey: ALICE, body: "from me", recipients: [ALICE] });
    await core.call("message.draft.save", { threadKey: ALICE, text: "mine" }, cli);
    const result = await core.call(
      "message.send",
      { to: core.handleMasker.mask(ALICE), text: "agent" },
      mcp,
    );
    expect(result.outcome).toBe("sent");
    expect(result.message!.agent).toEqual({ edited: false, via: "policy" });
    expect(store.getDraft(ALICE)).toBe("mine");
    expect(sent).toEqual(["agent"]);
  });
});

describe("thread.list pagination", () => {
  test("doesn't skip conversations sharing a timestamp at a page boundary", async () => {
    // All at the same time; the short-code senders sort first, filling the first SQL batch (4
    // rows for limit 2), so the next batch must start after them, not before their timestamp.
    for (const n of [1, 2, 3, 4]) {
      incoming({ threadKey: `sender:shop${n}`, sender: `sender:shop${n}`, body: "ad" });
    }
    const keys = [1, 2, 3].map((n) => `tel:+1206555020${n}`);
    for (const key of keys) incoming({ threadKey: key, sender: key, body: "same time" });
    const page = await core.call("thread.list", { limit: 2 }, mcp);
    expect(page.map((x) => x.key)).toEqual(keys.slice(0, 2).map((k) => core.handleMasker.mask(k)));
    expect(await core.call("thread.list", { limit: 10 }, mcp)).toHaveLength(3);
  });
});

import { DatabaseSync } from "node:sqlite";
import {
  EventBus,
  Outbox,
  Store,
  SyncEngine,
  nodeSqliteDb,
  type MapLinkHandle,
  type OutboxOptions,
  PAUSED_ERROR,
  RESTARTED_ERROR,
  type PushOutcome,
} from "@beyland/tincan-core";
import type { TincanError, TincanEvent } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone, type FakePhoneOptions } from "../src/index.ts";

const T0 = 1_750_000_000;
const ADA = "5550100001";
const ADA_KEY = "tel:+15550100001";
const ME = "5550100009";
const ME_KEY = "tel:+15550100009";

async function setup(options: Partial<OutboxOptions> = {}, phone: FakePhoneOptions = {}) {
  let seconds = T0;
  const now = () => seconds * 1000;
  const fake = new FakePhone({ now: () => seconds, ...phone });
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now });
  const events = new EventBus();
  const seen: TincanEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const engine = await SyncEngine.start({
    store,
    port: fake.port,
    address: fake.address,
    events,
    defaultRegion: () => "US",
    relistIntervalMs: 0,
    now,
  });
  const outbox = new Outbox({
    store,
    events,
    link: () => engine.mapLink,
    defaultRegion: () => "US",
    sweepIntervalMs: 0,
    now,
    ...options,
  });
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settle();
      await engine.idle();
      await outbox.idle();
    }
  };
  await flush();
  return { fake, store, events, seen, engine, outbox, flush, tick: (s = 1) => (seconds += s) };
}

async function rejection(promise: Promise<unknown>): Promise<TincanError> {
  try {
    await promise;
  } catch (error) {
    return error as TincanError;
  }
  throw new Error("Expected a rejection");
}

describe("Outbox", () => {
  it("records which sends an agent made, so they don't count as the user writing", async () => {
    const t = await setup();
    const byAgent = await t.outbox.send(ADA_KEY, "From the agent", { byAgent: true });
    expect(t.store.isSentByAgent(byAgent.id)).toBe(true);
    expect(t.store.hasUserSentMessage(ADA_KEY)).toBe(false);
    const byUser = await t.outbox.send(ADA_KEY, "From me");
    expect(t.store.isSentByAgent(byUser.id)).toBe(false);
    expect(t.store.hasUserSentMessage(ADA_KEY)).toBe(true);
  });

  it("pushes to the phone and marks the message sent", async () => {
    const t = await setup();
    const message = await t.outbox.send(ADA_KEY, "Hello");

    expect(message).toMatchObject({
      threadKey: ADA_KEY,
      direction: "outgoing",
      sender: null,
      body: "Hello",
      source: "local",
      status: "sent",
      read: true,
      sentAt: T0 * 1000,
    });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.fake.pushes).toEqual([
      { recipients: ["+15550100001"], body: "Hello", outcome: "accepted" },
    ]);
    expect(t.store.outboxEntry(message.id)).toBeNull();
    expect(t.store.getThread(ADA_KEY)?.lastMessage?.id).toBe(message.id);
    const changes = t.seen.filter((e) => e.event === "message.changed");
    expect(changes.length).toBe(2);
    expect(changes.at(-1)?.data).toEqual({ threadKey: ADA_KEY, ids: [message.id] });
    expect(t.seen.filter((e) => e.event === "message.sendStatus").map((e) => e.data)).toEqual([
      { id: message.id, status: "pending" },
      { id: message.id, status: "sent" },
    ]);
  });

  it("normalizes the thread key and refuses threads it can't reply to", async () => {
    const t = await setup();
    expect((await t.outbox.send(`tel:${ADA}`, "Hi")).threadKey).toBe(ADA_KEY);
    expect((await t.outbox.send("email:Ada@Example.com", "Hi")).threadKey).toBe(
      "email:ada@example.com",
    );
    expect(t.fake.pushes.map((p) => p.recipients)).toEqual([["+15550100001"], ["ada@example.com"]]);

    for (const key of [ADA, "sender:AMAZON", "group:name:book-club", "group:members:a,b"]) {
      expect((await rejection(t.outbox.send(key, "Hi"))).code).toBe("INVALID_INPUT");
    }
    expect((await rejection(t.outbox.send(ADA_KEY, "  "))).code).toBe("INVALID_INPUT");
    expect(t.fake.pushes.length).toBe(2);
  });

  it("marks failed pushes failed with their error code", async () => {
    const t = await setup();
    t.fake.failNextPush("PERMISSION_DENIED");
    const message = await t.outbox.send(ADA_KEY, "Nope");
    expect(message.status).toBe("failed");
    expect(t.store.outboxEntry(message.id)).toMatchObject({
      attempts: 1,
      lastError: "PERMISSION_DENIED",
      pushingSince: null,
    });
  });

  it("marks pushes that may have gone out unknown", async () => {
    const t = await setup();
    const outcomes: Array<"unconfirmed" | "pending" | "TIMEOUT"> = [
      "unconfirmed",
      "pending",
      "TIMEOUT",
    ];
    for (const outcome of outcomes) {
      t.fake.failNextPush(outcome);
      const message = await t.outbox.send(ADA_KEY, outcome);
      expect(message.status).toBe("unknown");
    }
  });

  it("retries failed and unknown messages, and only those", async () => {
    const t = await setup();
    t.fake.failNextPush("INTERNAL");
    const message = await t.outbox.send(ADA_KEY, "Again");
    expect(message.status).toBe("failed");

    t.fake.failNextPush("unconfirmed");
    expect((await t.outbox.retry(message.id)).status).toBe("unknown");
    const retried = await t.outbox.retry(message.id);
    expect(retried.status).toBe("sent");
    expect(retried.id).toBe(message.id);
    expect(t.fake.pushes.map((p) => p.body)).toEqual(["Again", "Again", "Again"]);
    expect(t.store.listMessages(ADA_KEY).length).toBe(1);

    expect((await rejection(t.outbox.retry(message.id))).code).toBe("CONFLICT");
    expect((await rejection(t.outbox.retry("missing"))).code).toBe("NOT_FOUND");
  });

  it("holds messages while the phone is away and sends them in order on connect", async () => {
    const t = await setup();
    t.fake.disconnect();
    await t.flush();

    const first = await t.outbox.send(ADA_KEY, "one");
    t.tick();
    const second = await t.outbox.send(ADA_KEY, "two");
    expect([first.status, second.status]).toEqual(["pending", "pending"]);
    expect(t.fake.pushes).toEqual([]);

    t.tick(60);
    t.fake.reconnect();
    await t.flush();
    expect(t.fake.pushes.map((p) => p.body)).toEqual(["one", "two"]);
    expect(t.store.getMessage(first.id)?.status).toBe("sent");
    expect(t.store.getMessage(second.id)?.status).toBe("sent");
    expect(t.store.outboxEntries()).toEqual([]);
  });

  it("fails held messages after the hold window", async () => {
    const t = await setup({ holdMs: 300_000 });
    t.fake.disconnect();
    await t.flush();
    const message = await t.outbox.send(ADA_KEY, "Too late");

    t.tick(299);
    expect(t.outbox.expire()).toBe(0);
    t.tick(2);
    expect(t.outbox.expire()).toBe(1);
    expect(t.store.getMessage(message.id)?.status).toBe("failed");
    expect(t.store.outboxEntry(message.id)?.lastError).toBe("NOT_CONNECTED");

    t.fake.reconnect();
    await t.flush();
    expect(t.fake.pushes).toEqual([]);
    expect((await t.outbox.retry(message.id)).status).toBe("sent");
  });

  it("keeps a message to your own number apart from its echo", async () => {
    const t = await setup({}, { ownNumber: ME });
    const message = await t.outbox.send(ME_KEY, "Note to self");
    await t.flush();

    const messages = t.store.listMessages(ME_KEY);
    expect(messages.map((m) => [m.direction, m.body, m.status])).toEqual([
      ["incoming", "Note to self", "received"],
      ["outgoing", "Note to self", "sent"],
    ]);
    expect(messages[1]?.id).toBe(message.id);
  });

  it("sends the same text twice as two messages", async () => {
    const t = await setup();
    const a = await t.outbox.send(ADA_KEY, "ok");
    const b = await t.outbox.send(ADA_KEY, "ok");
    expect(a.id).not.toBe(b.id);
    expect(t.store.listMessages(ADA_KEY).length).toBe(2);
  });

  it("drops a deleted message from the outbox", async () => {
    const t = await setup();
    t.fake.disconnect();
    await t.flush();
    const message = await t.outbox.send(ADA_KEY, "Never mind");
    t.store.deleteMessage(message.id);
    t.fake.reconnect();
    await t.flush();
    expect(t.fake.pushes).toEqual([]);
    expect(t.store.outboxEntry(message.id)).toBeNull();
  });
});

describe("Outbox watchdog", () => {
  function hangingLink() {
    let settle: (outcome: PushOutcome) => void = () => {};
    let calls = 0;
    const link = {
      pushMessage: () => {
        calls += 1;
        return new Promise<PushOutcome>((resolve) => (settle = resolve));
      },
    } as unknown as MapLinkHandle;
    return { link, settle: (o: PushOutcome) => settle(o), calls: () => calls };
  }

  function standalone(link: MapLinkHandle | null, store?: Store) {
    const db = store ?? Store.open(nodeSqliteDb(new DatabaseSync(":memory:")));
    const outbox = new Outbox({
      store: db,
      events: new EventBus(),
      link: () => link,
      watchdogMs: 20,
      sweepIntervalMs: 0,
    });
    return { store: db, outbox };
  }

  it("marks a push that doesn't end in time unknown, then settles it late", async () => {
    const hang = hangingLink();
    const { store, outbox } = standalone(hang.link);
    const message = await outbox.send(ADA_KEY, "Slow");
    expect(message.status).toBe("unknown");
    expect(store.outboxEntry(message.id)?.lastError).toBe("TIMEOUT");
    expect((await rejection(outbox.retry(message.id))).code).toBe("CONFLICT");

    hang.settle("accepted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getMessage(message.id)?.status).toBe("sent");
    expect(hang.calls()).toBe(1);
  });

  it("marks a send interrupted by a restart unknown", async () => {
    const hang = hangingLink();
    const first = standalone(hang.link);
    const message = first.store.queueOutgoing({
      threadKey: ADA_KEY,
      body: "Crash",
      recipients: ["+15550100001"],
    });
    first.store.beginSendAttempt(message.id);
    const held = first.store.queueOutgoing({
      threadKey: ADA_KEY,
      body: "Waiting",
      recipients: ["+15550100001"],
    });

    standalone(null, first.store);
    expect(first.store.getMessage(message.id)?.status).toBe("unknown");
    expect(first.store.getMessage(held.id)?.status).toBe("pending");
  });
});

describe("Outbox send delays", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const agentDraft = (store: Store, text: string, via: "user" | "policy") =>
    store.insertAgentDraft({
      to: ADA_KEY,
      agentName: "Claude Code",
      intent: "send",
      text,
      state: via === "policy" ? "scheduled" : "queued",
    });

  it("holds a message for its delay, sorted at its send time, then sends it", async () => {
    const t = await setup();
    const message = await t.outbox.send(ADA_KEY, "Soon", { delayMs: 40 });
    expect(message).toMatchObject({ status: "scheduled", sendAt: T0 * 1000 + 40 });
    expect(message.sentAt).toBe(T0 * 1000 + 40);
    expect(t.fake.pushes).toEqual([]);
    // A message without a delay isn't held up behind it.
    const now = await t.outbox.send(ADA_KEY, "Now");
    expect(now.status).toBe("sent");
    expect(t.store.listMessages(ADA_KEY).map((m) => m.body)).toEqual(["Soon", "Now"]);

    t.tick(2);
    await sleep(60);
    await t.flush();
    const sent = t.store.getMessage(message.id)!;
    expect(sent.status).toBe("sent");
    // Re-stamped with when it really went.
    expect(sent.sentAt).toBe((T0 + 2) * 1000);
    expect(sent.sendAt).toBeUndefined();
    expect(t.fake.pushes.map((p) => p.body)).toEqual(["Now", "Soon"]);
    expect(
      t.seen
        .filter((e) => e.event === "message.sendStatus" && e.data.id === message.id)
        .map((e) => (e.data as { status: string }).status),
    ).toEqual(["scheduled", "pending", "sent"]);
  });

  it("cancels a scheduled message so it never reaches the phone, and sends one now", async () => {
    const t = await setup();
    const message = await t.outbox.send(ADA_KEY, "Oops", { delayMs: 60_000 });
    const cancelled = t.outbox.cancel(message.id);
    expect(cancelled).toEqual({ threadKey: ADA_KEY, body: "Oops", agentDraftId: null });
    expect(t.store.getMessage(message.id)).toBeNull();
    expect(t.store.outboxEntry(message.id)).toBeNull();
    expect(t.store.getThread(ADA_KEY)?.lastMessage).toBeNull();
    expect((await rejection(Promise.resolve().then(() => t.outbox.cancel(message.id)))).code).toBe(
      "NOT_FOUND",
    );

    const later = await t.outbox.send(ADA_KEY, "Go", { delayMs: 60_000 });
    const now = await t.outbox.sendNow(later.id);
    expect(now.status).toBe("sent");
    expect(t.fake.pushes.map((p) => p.body)).toEqual(["Go"]);
    expect((await rejection(t.outbox.sendNow(later.id))).code).toBe("NOT_FOUND");
    // Already sent: too late to cancel.
    expect((await rejection(Promise.resolve().then(() => t.outbox.cancel(later.id)))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("cancels a message waiting for the phone, but not one that's being pushed", async () => {
    const t = await setup();
    t.fake.disconnect();
    await t.flush();
    const held = await t.outbox.send(ADA_KEY, "Held");
    expect(held.status).toBe("pending");
    expect(t.outbox.cancel(held.id).body).toBe("Held");

    t.store.queueOutgoing({ threadKey: ADA_KEY, body: "Pushing", recipients: [ADA] });
    const [pushing] = t.store.outboxEntries("pending");
    t.store.beginSendAttempt(pushing!.messageId);
    const busy = await rejection(Promise.resolve().then(() => t.outbox.cancel(pushing!.messageId)));
    expect(busy).toMatchObject({ code: "CONFLICT", message: "Already sending" });
  });

  it("a timer that fires long after its time doesn't send", async () => {
    const t = await setup();
    const mine = await t.outbox.send(ADA_KEY, "Mine", { delayMs: 30 });
    const fromDraft = agentDraft(t.store, "From a draft", "user");
    const userSent = await t.outbox.send(ADA_KEY, "From a draft", {
      delayMs: 30,
      agent: { name: "Claude Code", edited: false, via: "user" },
      agentDraftId: fromDraft.id,
    });
    const direct = agentDraft(t.store, "Direct", "policy");
    const directSent = await t.outbox.send(ADA_KEY, "Direct", {
      byAgent: true,
      agent: { name: "Claude Code", edited: false, via: "policy" },
      delayMs: 30,
      agentDraftId: direct.id,
    });
    // The computer slept through it.
    t.tick(60);
    await sleep(50);
    await t.flush();
    expect(t.fake.pushes).toEqual([]);
    // Yours fails, and can be retried.
    expect(t.store.getMessage(mine.id)?.status).toBe("failed");
    expect(t.store.outboxEntry(mine.id)?.lastError).toBe(PAUSED_ERROR);
    expect(t.store.getMessage(mine.id)?.failure).toEqual({ code: "PAUSED" });
    const retried = await t.outbox.retry(mine.id);
    expect(retried.status).toBe("sent");
    expect(retried).not.toHaveProperty("failure");
    // An agent draft you sent goes back to its queue; an agent's direct send is cancelled.
    expect(t.store.getMessage(userSent.id)).toBeNull();
    expect(t.store.getAgentDraft(fromDraft.id)).toMatchObject({ state: "queued" });
    expect(t.store.getAgentDraft(fromDraft.id)).not.toHaveProperty("messageId");
    expect(t.store.getMessage(directSent.id)).toBeNull();
    expect(t.store.getAgentDraft(direct.id)?.state).toBe("cancelled");
  });

  it("a restart re-arms future sends and treats overdue ones like stale timers", async () => {
    const t = await setup();
    const future = await t.outbox.send(ADA_KEY, "Future", { delayMs: 40 });
    const overdue = await t.outbox.send(ADA_KEY, "Overdue", { delayMs: 1000 });
    const due = await t.outbox.send(ADA_KEY, "Due", { delayMs: 1000 });
    t.outbox.stop();
    // Down for a while: "Overdue" was due 19 s ago, "Due" within the grace period.
    t.store.db.exec("UPDATE outbox SET send_at = ? WHERE message_id = ?", [
      T0 * 1000 - 19_000,
      overdue.id,
    ]);
    t.store.db.exec("UPDATE outbox SET send_at = ? WHERE message_id = ?", [
      T0 * 1000 - 5_000,
      due.id,
    ]);
    const restarted = new Outbox({
      store: t.store,
      events: t.events,
      link: () => t.engine.mapLink,
      defaultRegion: () => "US",
      sweepIntervalMs: 0,
      now: () => T0 * 1000,
    });
    await restarted.idle();
    await t.flush();
    await restarted.idle();
    expect(t.store.getMessage(overdue.id)?.status).toBe("failed");
    // Tincan wasn't running at the time, which the app tells apart from a suspend.
    expect(t.store.getMessage(overdue.id)?.failure).toEqual({ code: RESTARTED_ERROR });
    expect(t.store.getMessage(due.id)?.status).toBe("sent");
    expect(t.store.getMessage(future.id)?.status).toBe("scheduled");
    await sleep(60);
    await restarted.idle();
    expect(t.store.getMessage(future.id)?.status).toBe("sent");
    expect(t.fake.pushes.map((p) => p.body)).toEqual(["Due", "Future"]);
    restarted.stop();
  });

  it("deleting a conversation stops its timers", async () => {
    const t = await setup();
    const message = await t.outbox.send(ADA_KEY, "Never", { delayMs: 30 });
    t.store.deleteThread(ADA_KEY);
    t.outbox.dropThread(ADA_KEY);
    await sleep(50);
    await t.flush();
    expect(t.fake.pushes).toEqual([]);
    expect(t.store.getMessage(message.id)).toBeNull();
  });

  it("an echo never matches a message still held for its delay", async () => {
    const t = await setup();
    const held = await t.outbox.send(ME_KEY, "Same text", { delayMs: 60_000 });
    const echo = {
      threadKey: ME_KEY,
      direction: "incoming" as const,
      sender: ME_KEY,
      body: "Same text",
      sentAt: T0 * 1000,
      receivedAt: T0 * 1000,
      source: "map" as const,
      status: "received" as const,
      read: false,
      device: t.fake.address,
      mapHandle: "echo-1",
    };
    expect(t.store.matchSelfEcho(echo)).toBe(false);
    expect(t.store.getMessage(held.id)?.mapHandle).toBeUndefined();
    // And a copy from the phone's sent folder isn't folded into it either.
    const copy = t.store.insertMessage({
      ...echo,
      direction: "outgoing",
      sender: null,
      sentAt: held.sentAt,
      status: "sent",
      mapHandle: "sent-1",
    });
    expect(copy.inserted).toBe(true);
    expect(copy.message?.id).not.toBe(held.id);
    // Once it has gone, its echo matches as before.
    await t.outbox.sendNow(held.id);
    expect(t.store.matchSelfEcho({ ...echo, mapHandle: "echo-2" })).toBe(true);
  });
});

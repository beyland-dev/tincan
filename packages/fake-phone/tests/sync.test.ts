import { DatabaseSync } from "node:sqlite";
import {
  EventBus,
  Store,
  SyncEngine,
  nodeSqliteDb,
  type SyncEngineOptions,
} from "@beyland/tincan-core";
import type { TincanEvent } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone } from "../src/index.ts";

const T0 = 1_750_000_000;
const ADA = "5550100001";
const BOB = "5550100002";
const ADA_KEY = "tel:+15550100001";
const BOB_KEY = "tel:+15550100002";

async function setup(options: Partial<SyncEngineOptions> = {}) {
  let seconds = T0;
  const fake = new FakePhone({ now: () => seconds });
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), {
    now: () => seconds * 1000,
  });
  const events = new EventBus();
  const seen: TincanEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const errors: string[] = [];
  const start = () =>
    SyncEngine.start({
      store,
      port: fake.port,
      address: fake.address,
      events,
      defaultRegion: () => "US",
      relistIntervalMs: 0,
      now: () => seconds * 1000,
      onError: (context) => errors.push(context),
      ...options,
    });
  return {
    fake,
    store,
    seen,
    errors,
    start,
    tick: (s = 1) => (seconds += s),
    /** Lets the phone's callbacks and the engine's queue run until both are quiet. */
    flush: async (engine: SyncEngine) => {
      for (let i = 0; i < 4; i++) {
        await fake.settle();
        await engine.idle();
      }
    },
  };
}

const bodies = (store: Store, key: string) => store.listMessages(key).map((m) => m.body);

describe("SyncEngine", () => {
  it("backfills the listed inbox on first connect without notifying", async () => {
    const t = await setupSeeded(12);
    const engine = await t.start();
    await t.flush(engine);

    expect(bodies(t.store, ADA_KEY)).toEqual(Array.from({ length: 10 }, (_, i) => `m${11 - i}`));
    expect(t.store.pendingNotifications()).toEqual([]);
    expect(t.store.openGaps()).toEqual([]);
    expect(engine.status).toMatchObject({ link: { kind: "connected" }, syncing: false });
    expect(engine.status.lastSyncAt).toBe((T0 + 12) * 1000);

    const message = t.store.listMessages(ADA_KEY).at(-1)!;
    expect(message).toMatchObject({
      direction: "incoming",
      sender: ADA_KEY,
      source: "map",
      status: "received",
      sentAt: (T0 + 2) * 1000,
      read: false,
    });

    const syncStates = t.seen.flatMap((e) => (e.event === "sync.changed" ? [e.data.state] : []));
    expect(syncStates).toEqual(["connecting", "connected", "syncing", "connected"]);
    const changed = t.seen.find((e) => e.event === "message.changed");
    expect(changed?.data).toMatchObject({ threadKey: ADA_KEY });
    expect(t.seen.find((e) => e.event === "thread.changed")?.data).toEqual({ keys: [ADA_KEY] });
    expect(t.errors).toEqual([]);
    await engine.stop();
  });

  it("notifies only for live arrivals", async () => {
    const t = await setup();
    const engine = await t.start();
    await t.flush(engine);
    t.tick();
    t.fake.receive({ from: BOB, name: "Bob", body: "live one" });
    await t.flush(engine);

    expect(bodies(t.store, BOB_KEY)).toEqual(["live one"]);
    expect(t.store.pendingNotifications().map((m) => m.body)).toEqual(["live one"]);
    await engine.stop();
  });

  it("notifies for every arrival in a burst, though the first pass lists them all", async () => {
    const t = await setup();
    const engine = await t.start();
    await t.flush(engine);
    t.tick();
    t.fake.receive({ from: BOB, body: "one" });
    t.fake.receive({ from: BOB, body: "two" });
    t.fake.receive({ from: BOB, body: "three" });
    await t.flush(engine);

    expect(t.store.pendingNotifications().map((m) => m.body)).toEqual(["one", "two", "three"]);
    await engine.stop();
  });

  it("dedupes on re-list", async () => {
    const t = await setupSeeded(3);
    const engine = await t.start();
    await t.flush(engine);
    const first = await engine.sync();
    expect(first).toMatchObject({ kind: "relist", listed: 3, added: [], readChanged: [] });
    expect(t.store.listMessages(ADA_KEY)).toHaveLength(3);
    await engine.stop();
  });

  it("catches up after a reconnect as already notified", async () => {
    const t = await setupSeeded(2);
    const engine = await t.start();
    await t.flush(engine);
    t.fake.disconnect();
    await t.flush(engine);
    expect(engine.status.link.kind).toBe("waiting");
    expect(engine.status.lastError).toEqual({ code: "NOT_CONNECTED", at: expect.any(Number) });

    t.tick();
    t.fake.receive({ from: BOB, body: "while away" });
    t.fake.reconnect();
    await t.flush(engine);

    expect(engine.status.lastError).toBeNull();
    expect(bodies(t.store, BOB_KEY)).toEqual(["while away"]);
    expect(t.store.pendingNotifications()).toEqual([]);
    expect(t.store.openGaps()).toEqual([]);
    await engine.stop();
  });

  it("counts failed opens in a row and resets them once connected", async () => {
    const t = await setupSeeded(1);
    const engine = await t.start();
    await t.flush(engine);
    expect(engine.status.failures).toBe(0);

    t.fake.forget();
    await t.flush(engine);
    for (let i = 0; i < 2; i++) {
      t.fake.disconnect();
      t.fake.reconnect();
      await t.flush(engine);
    }
    expect(engine.status.lastError?.code).toBe("NOT_FOUND");
    expect(engine.status.failures).toBe(3);

    t.fake.pair(true);
    t.fake.disconnect();
    t.fake.reconnect();
    await t.flush(engine);
    expect(engine.status.link.kind).toBe("connected");
    expect(engine.status).toMatchObject({ lastError: null, failures: 0 });
    await engine.stop();
  });

  it("records a gap when more than a window arrived while away", async () => {
    const t = await setupSeeded(2);
    const engine = await t.start();
    await t.flush(engine);
    const lastSeen = t.store.lastMessageAt(t.fake.address)!;
    t.fake.disconnect();
    await t.flush(engine);
    t.tick(60);
    t.fake.seed(Array.from({ length: 12 }, (_, i) => ({ from: BOB, body: `b${i}` })));
    t.fake.reconnect();
    await t.flush(engine);

    const gaps = t.store.openGaps(BOB_KEY);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ threadKey: null, fromAt: lastSeen, toAt: (T0 + 62) * 1000 });
    expect(t.store.listMessages(BOB_KEY)).toHaveLength(10);
    await engine.stop();
  });

  it("takes read changes made on the phone but keeps unmirrored local reads", async () => {
    const t = await setupSeeded(3);
    const engine = await t.start();
    await t.flush(engine);
    const [a, b] = t.fake.messages;
    const stored = (handle: string) => t.store.findByMapHandle(t.fake.address, handle)!;

    t.fake.setReadOnPhone(a!.handle);
    // Read in Tincan, not yet mirrored: the phone still lists it unread.
    t.store.setMessageRead(stored(b!.handle).id, true);
    const result = await engine.sync();

    expect(result?.readChanged).toEqual([stored(a!.handle).id]);
    expect(stored(a!.handle).read).toBe(true);
    expect(stored(b!.handle).read).toBe(true);

    // Unread on the phone later: that is a phone-side change.
    t.fake.setReadOnPhone(a!.handle, false);
    await engine.sync();
    expect(stored(a!.handle).read).toBe(false);
    await engine.stop();
  });

  it("mirrors reads made in Tincan to the phone", async () => {
    const t = await setupSeeded(3);
    const engine = await t.start();
    await t.flush(engine);

    const changes = t.store.markThreadRead(ADA_KEY);
    expect(changes).toHaveLength(3);
    expect(await engine.markReadOnPhone(changes)).toBe(3);
    expect(t.fake.messages.every((m) => m.read)).toBe(true);

    // The next listing shows them read on both sides: no change either way.
    const result = await engine.sync();
    expect(result?.readChanged).toEqual([]);
    expect(t.store.listMessages(ADA_KEY).every((m) => m.read)).toBe(true);
    await engine.stop();
  });

  it("doesn't refetch messages deleted in Tincan", async () => {
    const t = await setupSeeded(2);
    const engine = await t.start();
    await t.flush(engine);
    const [first] = t.store.listMessages(ADA_KEY);
    t.store.deleteMessage(first!.id);
    const result = await engine.sync();
    expect(result?.added).toEqual([]);
    expect(t.store.listMessages(ADA_KEY)).toHaveLength(1);
    await engine.stop();
  });

  it("converts U+FFFC attachment placeholders into attachmentHint and deduplicates self-thread echoes", async () => {
    const SELF = "+15550100009";
    const SELF_KEY = `tel:${SELF}`;
    const t = await setup({ ownHandles: () => [SELF_KEY] });
    t.fake.seed([{ from: ADA, body: "\uFFFC\uFFFC", timestamp: T0 }]);
    t.store.queueOutgoing({ threadKey: SELF_KEY, body: "reminder", recipients: [SELF] });
    t.fake.seed([{ from: SELF, body: "reminder", timestamp: T0 + 2 }]);

    const engine = await t.start();
    await t.flush(engine);

    const [adaMsg] = t.store.listMessages(ADA_KEY);
    expect(adaMsg?.body).toBe("");
    expect(adaMsg?.attachmentHint).toEqual({ count: 2 });

    // Only the outgoing self message exists; the incoming MAP echo was folded into it.
    const selfMsgs = t.store.listMessages(SELF_KEY);
    expect(selfMsgs).toHaveLength(1);
    expect(selfMsgs[0]?.direction).toBe("outgoing");
    expect(selfMsgs[0]?.mapHandle).toBeTruthy();
    await engine.stop();
  });

  it("does nothing while disconnected and stops the link", async () => {
    const t = await setup();
    t.fake.disconnect();
    const engine = await t.start();
    await t.flush(engine);
    expect(await engine.sync()).toBeNull();
    expect(await engine.markReadOnPhone([])).toBe(0);
    await engine.stop();
    await t.fake.settle();
    expect(engine.status.link.kind).toBe("stopped");
  });

  async function setupSeeded(count: number) {
    const t = await setup();
    t.fake.seed(
      Array.from({ length: count }, (_, i) => ({ from: ADA, body: `m${i}`, timestamp: T0 + i })),
    );
    t.tick(count);
    return t;
  }
});

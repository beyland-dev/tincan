import { DatabaseSync } from "node:sqlite";
import { ContactSync, Core, Outbox, Store, SyncEngine, nodeSqliteDb } from "@beyland/tincan-core";
import type { ClientInfo } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone } from "../src/index.ts";

const T0 = 1_750_000_000;
const ADA_KEY = "tel:+15550100001";
const cli: ClientInfo = { name: "test", kind: "cli" };
const mcp: ClientInfo = { name: "agent", kind: "mcp" };
const STRANGER_KEY = "tel:+15550100002";
const OWN_KEY = "tel:+15550100009";

async function setup() {
  let seconds = T0;
  const now = () => seconds * 1000;
  const fake = new FakePhone({
    now: () => seconds,
    ownerName: "Pat Owner",
    ownNumber: "5550100009",
  });
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now });
  const core = await Core.open({ version: "1.0.0", store, now });
  const events = core.events;
  const defaultRegion = () => "US";
  const sync = await SyncEngine.start({
    store,
    port: fake.port,
    address: fake.address,
    events,
    defaultRegion,
    relistIntervalMs: 0,
    now,
  });
  const outbox = new Outbox({
    store,
    events,
    link: () => sync.mapLink,
    defaultRegion,
    sweepIntervalMs: 0,
    now,
  });
  const contacts = new ContactSync({
    store,
    port: fake.port,
    address: fake.address,
    events,
    defaultRegion,
    now,
  });
  core.attach({ sync, outbox, contacts });
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settle();
      await sync.idle();
      await outbox.idle();
    }
  };
  await flush();
  return { fake, store, core, flush, tick: (s = 1) => (seconds += s) };
}

describe("commands against the fake phone", () => {
  it("syncs, lists, reads and replies", async () => {
    const t = await setup();
    t.fake.setContacts([{ name: "Ada Lovelace", tels: ["(555) 010-0001"] }]);
    t.fake.seed([{ from: "5550100001", name: "Ada Lovelace", body: "Lunch?", read: false }]);

    const result = await t.core.call("sync.now", { contacts: true }, cli);
    expect(result).toMatchObject({ synced: true, added: 1, contacts: { contacts: 1 } });

    const threads = await t.core.call("thread.list", {}, cli);
    expect(threads.map((thread) => [thread.key, thread.unread])).toEqual([[ADA_KEY, 1]]);

    const read = await t.core.call("thread.markRead", { key: "tel:5550100001" }, cli);
    expect(read).toEqual({ marked: 1, onPhone: 1 });
    expect(t.fake.messages.every((message) => message.read)).toBe(true);

    t.tick();
    const sent = await t.core.call("message.send", { to: "ada", text: "Sure!" }, cli);
    await t.flush();
    expect(sent).toMatchObject({ outcome: "sent", message: { threadKey: ADA_KEY, body: "Sure!" } });
    expect(t.fake.pushes.map((push) => push.recipients)).toEqual([["+15550100001"]]);
    expect(t.store.getMessage(sent.message!.id)?.status).toBe("sent");

    const status = await t.core.call("sync.status", {}, cli);
    expect(status.messages.state).toBe("connected");
    expect(status.contacts.lastSyncAt).toBe(T0 * 1000);
  });

  it("reports sync.now as not synced while the phone is away", async () => {
    const t = await setup();
    t.fake.disconnect();
    await t.flush();
    const result = await t.core.call("sync.now", {}, cli);
    expect(result).toMatchObject({ synced: false, contacts: null });
  });

  it("keeps agents within what they may read, with the phone's own contacts and owner card", async () => {
    const t = await setup();
    t.fake.setContacts([{ name: "Ada Lovelace", tels: ["(555) 010-0001"] }]);
    t.fake.seed([
      { from: "5550100001", name: "Ada Lovelace", body: "Lunch?" },
      { from: "5550100002", body: "Who's this?" },
    ]);
    await t.core.call("sync.now", { contacts: true }, cli);
    // A note to self: the phone delivers it back from the user's own number.
    t.tick();
    await t.core.call("message.send", { to: OWN_KEY, text: "Buy milk" }, cli);
    await t.flush();
    await t.core.call("sync.now", {}, cli);
    await t.flush();
    await t.core.call(
      "settings.set",
      {
        agents: {
          access: "full",
          read: "contacts",
          send: "always",
          handles: "visible",
          sendDelaySeconds: 0,
        },
      },
      cli,
    );
    const listed = async () =>
      (await t.core.call("thread.list", {}, mcp)).map((thread) => thread.key).sort();
    expect(await listed()).toEqual([ADA_KEY, OWN_KEY].sort());

    // `always` sends to the stranger without asking, and that doesn't make them readable.
    await t.core.call("settings.set", { agents: { read: "known" } }, cli);
    t.tick();
    const sent = await t.core.call("message.send", { to: STRANGER_KEY, text: "Hi!" }, mcp);
    expect(sent).toMatchObject({ outcome: "sent", draft: { state: "sent" } });
    await t.flush();
    await t.core.call("sync.now", {}, cli);
    await t.flush();
    expect(t.fake.pushes.at(-1)?.recipients).toEqual(["+15550100002"]);
    expect(await listed()).toEqual([ADA_KEY, OWN_KEY].sort());
    const read = await t.core
      .call("message.list", { threadKey: STRANGER_KEY }, mcp)
      .catch((error: unknown) => error);
    expect(read).toMatchObject({ code: "NOT_FOUND" });

    // The user writing back does.
    t.tick(600);
    await t.core.call("message.send", { to: STRANGER_KEY, text: "Who are you?" }, cli);
    await t.flush();
    expect(await listed()).toEqual([ADA_KEY, OWN_KEY, STRANGER_KEY].sort());
  });
});

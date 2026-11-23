import type { AncsSessionEvent, MapLinkEvent, NotifierEvent } from "@beyland/tincan-core";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone, IOS_INBOX_WINDOW } from "../src/index.ts";

const T0 = 1_750_000_000;

function phone(options: ConstructorParameters<typeof FakePhone>[0] = {}) {
  let now = T0;
  const fake = new FakePhone({ now: () => now, ownNumber: "+1 555 010 0000", ...options });
  return { fake, tick: (seconds = 1) => (now += seconds) };
}

async function mapLink(fake: FakePhone, address = fake.address) {
  const events: MapLinkEvent[] = [];
  const link = await fake.port.MapLink.start(address, {}, (event) => events.push(event));
  await fake.settle();
  return { link, events };
}

async function ancs(fake: FakePhone, content = true) {
  const events: AncsSessionEvent[] = [];
  const session = await fake.port.AncsSession.start(fake.address, { content }, (event) =>
    events.push(event),
  );
  await fake.settle();
  return { session, events };
}

const states = (events: Array<MapLinkEvent | AncsSessionEvent>) =>
  events.flatMap((event) => (event.kind === "state" ? [event.state.kind] : []));

describe("MAP", () => {
  it("connects at once and lists only the newest inbox window, newest first", async () => {
    const { fake } = phone();
    fake.seed(
      Array.from({ length: 12 }, (_, i) => ({
        from: "5550100001",
        body: `m${i}`,
        timestamp: T0 + i,
      })),
    );
    const { link, events } = await mapLink(fake);
    expect(states(events)).toEqual(["connecting", "connected"]);
    const state = link.state();
    expect(state.kind).toBe("connected");

    const listed = await link.listMessages("inbox");
    expect(listed).toHaveLength(IOS_INBOX_WINDOW);
    expect(listed.map((m) => m.subject)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${11 - i}`),
    );
    expect(listed[0]).toMatchObject({ folder: "/telecom/msg/inbox", read: false, sent: false });
    expect(listed[0]!.path.startsWith(state.kind === "connected" ? state.session : "?")).toBe(true);

    expect(await link.listMessages("telecom/msg/sent")).toEqual([]);
    expect(await link.listMessages("outbox")).toEqual([]);
    await expect(link.listMessages("drafts")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(link.listMessages("inbox", { maxCount: 70_000 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await link.listMessages("inbox", { offset: 2, maxCount: 3 })).toHaveLength(3);
    expect((await link.listMessages("inbox", { subjectLength: 1 }))[0]!.subject).toBe("m");
  });

  it("reports arrivals as messageAdded then a statusChanged notification", async () => {
    const { fake } = phone();
    const { link, events } = await mapLink(fake);
    events.length = 0;
    const message = fake.receive({ from: "5550100001", name: "Ada", body: "hi" });
    await fake.settle();
    expect(events.map((e) => (e.kind === "map" ? e.event.kind : e.kind))).toEqual([
      "messageAdded",
      "statusChanged",
    ]);
    const added = events[0]!;
    if (added.kind !== "map" || added.event.kind !== "messageAdded") throw new Error("unexpected");
    expect(added.event.handle).toBe(message.handle);

    const parsed = await link.getMessage(added.event.path);
    expect(parsed).toMatchObject({
      body: "hi",
      read: false,
      threadKey: "tel:5550100001",
      originator: { name: "Ada", tel: "5550100001" },
    });
    // Fetching doesn't mark it read, and reading on the phone sends nothing.
    fake.setReadOnPhone(message.handle);
    await fake.settle();
    expect(events).toHaveLength(2);
    expect((await link.listMessages("inbox"))[0]!.read).toBe(true);
  });

  it("gives raw thread keys like the native parser", async () => {
    const { fake } = phone();
    fake.seed([
      { from: "+1 (555) 010-0002", body: "a" },
      { from: "Ada@Example.com", body: "b" },
      { from: "AppleCard", body: "c" },
    ]);
    const { link } = await mapLink(fake);
    const keys = await Promise.all(
      (await link.listMessages("inbox")).map(
        async (m) => (await link.getMessage(m.path)).threadKey,
      ),
    );
    expect(keys.sort()).toEqual(["email:ada@example.com", "sender:applecard", "tel:+15550100002"]);
  });

  it("scopes message paths to the session that listed them", async () => {
    const { fake } = phone();
    fake.seed([{ from: "5550100001", body: "hi" }]);
    const { link } = await mapLink(fake);
    const [old] = await link.listMessages("inbox");
    fake.disconnect();
    fake.reconnect();
    await fake.settle();
    await expect(link.getMessage(old!.path)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [fresh] = await link.listMessages("inbox");
    expect(fresh!.path).not.toBe(old!.path);
    expect((await link.getMessage(fresh!.path)).body).toBe("hi");
  });

  it("closes the session and backs off while the phone is away", async () => {
    const { fake } = phone();
    const { link, events } = await mapLink(fake);
    events.length = 0;
    fake.disconnect();
    await fake.settle();
    expect(events.map((e) => (e.kind === "map" ? e.event.kind : e.kind))).toEqual([
      "sessionClosed",
      "state",
      "openFailed",
      "state",
    ]);
    expect(link.state()).toEqual({ kind: "waiting", attempt: 1, delayMs: 1000 });
    await expect(link.listMessages("inbox")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await expect(link.pushMessage(["5550100001"], "x")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });

    link.trigger("reconnect");
    expect(link.state()).toEqual({ kind: "waiting", attempt: 1, delayMs: 1000 });
    fake.reconnect();
    expect(link.state().kind).toBe("connected");
  });

  it("pauses for sleep and adapterDown and connects on resume", async () => {
    const { fake } = phone();
    const { link } = await mapLink(fake);
    link.trigger("adapterDown");
    link.trigger("sleep");
    expect(link.state()).toEqual({ kind: "paused", reason: "adapterDown" });
    link.trigger("adapterUp");
    expect(link.state().kind).toBe("connected");
    await link.shutdown();
    expect(link.state().kind).toBe("stopped");
    link.trigger("reconnect");
    expect(link.state().kind).toBe("stopped");
  });

  it("fails to connect to an unknown phone with NOT_FOUND", async () => {
    const { fake } = phone();
    const { link, events } = await mapLink(fake, "11:22:33:44:55:66");
    expect(events.find((e) => e.kind === "openFailed")).toMatchObject({ code: "NOT_FOUND" });
    expect(link.state().kind).toBe("waiting");
  });

  it("fails with NOT_FOUND while the phone isn't sharing messages", async () => {
    const { fake } = phone({ shareMessages: false });
    const { link, events } = await mapLink(fake);
    expect(events.find((e) => e.kind === "openFailed")).toMatchObject({ code: "NOT_FOUND" });
    expect(link.state().kind).toBe("waiting");
    fake.setShareMessages(true);
    expect(link.state().kind).toBe("connected");
    fake.setShareMessages(false);
    expect(link.state()).toMatchObject({ kind: "waiting", attempt: 1 });
  });

  it("accepts pushes, echoes ones to the own number and plays scripted failures", async () => {
    const { fake } = phone();
    const { link, events } = await mapLink(fake);
    expect(await link.pushMessage(["5550100001"], "one")).toBe("accepted");
    await expect(link.pushMessage([], "x")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    fake.failNextPush("TIMEOUT");
    fake.failNextPush("unconfirmed");
    await expect(link.pushMessage(["5550100001"], "two")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(await link.pushMessage(["5550100001"], "three")).toBe("unconfirmed");
    expect(fake.pushes.map((p) => p.outcome)).toEqual([
      "accepted",
      { error: "TIMEOUT" },
      "unconfirmed",
    ]);

    events.length = 0;
    await link.pushMessage(["(555) 010-0000"], "note to self");
    await fake.settle();
    expect(fake.messages.at(-1)).toMatchObject({ from: "15550100000", body: "note to self" });
    expect(events.some((e) => e.kind === "map" && e.event.kind === "messageAdded")).toBe(true);
  });
});

describe("ANCS", () => {
  it("shows Messages notifications for arrivals and replays the backlog as preExisting", async () => {
    const { fake } = phone();
    fake.notify({ appId: "com.example.mail", appName: "Mail", title: "Old", category: "email" });
    const { session, events } = await ancs(fake);
    expect(states(events)).toEqual(["waiting", "ready"]);
    const backlog = events.flatMap((e) => (e.kind === "notification" ? [e.notification] : []));
    expect(backlog).toMatchObject([{ title: "Old", preExisting: true }]);

    events.length = 0;
    fake.receive({
      from: "5550100001",
      name: "Ada",
      body: "hi",
      notification: { subtitle: "Book club" },
    });
    await fake.settle();
    expect(events).toMatchObject([
      {
        kind: "notification",
        notification: {
          appId: "com.apple.MobileSMS",
          title: "Ada",
          subtitle: "Book club",
          body: "hi",
          category: "social",
          preExisting: false,
          hasNegativeAction: true,
        },
      },
    ]);

    fake.disconnect();
    fake.reconnect();
    await fake.settle();
    const replayed = (await session.recent(2)).map((n) => [n.title, n.preExisting]);
    expect(replayed).toEqual([
      ["Old", true],
      ["Ada", true],
    ]);
    // Each subscription numbers its notifications afresh.
    const uids = (await session.recent()).map((n) => n.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("performs actions and removes dismissed notifications", async () => {
    const { fake } = phone();
    const { session, events } = await ancs(fake);
    fake.receive({ from: "5550100001", body: "hi" });
    await fake.settle();
    const [delivered] = await session.recent();
    await expect(session.performAction(delivered!.uid, "positive")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(session.performAction(999, "negative")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    events.length = 0;
    await session.performAction(delivered!.uid, "negative");
    await fake.settle();
    expect(fake.actions).toEqual([{ uid: delivered!.uid, action: "negative" }]);
    expect(events).toEqual([{ kind: "removed", uid: delivered!.uid }]);
    expect(fake.notifications).toEqual([]);
  });

  it("waits for Share System Notifications and can hide content", async () => {
    const { fake } = phone({ shareNotifications: false });
    const { session, events } = await ancs(fake, false);
    expect(session.state().kind).toBe("waiting");
    fake.receive({ from: "5550100001", body: "secret" });
    fake.setShareNotifications(true);
    await fake.settle();
    expect(states(events)).toEqual(["waiting", "ready"]);
    expect(await session.recent()).toMatchObject([{ title: "", body: "", preExisting: true }]);
    fake.disconnect();
    expect(session.state()).toMatchObject({ kind: "unavailable", code: "NOT_CONNECTED" });
    await expect(session.performAction(0, "negative")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("PBAP", () => {
  it("pulls contacts with the owner card first, favourites and a version counter", async () => {
    const { fake } = phone({ ownerName: "Pat Owner" });
    fake.setContacts([
      { name: "Ada Lovelace", tels: ["+1 555 010 0001"], favorite: true },
      { name: "Grace", emails: ["grace@example.com"] },
    ]);
    const session = await fake.port.PbapSession.open(fake.address);
    const cards = await session.pullContacts();
    expect(cards.map((c) => c.name)).toEqual(["Pat Owner", "Ada Lovelace", "Grace"]);
    expect(cards[1]).toMatchObject({ family: "Lovelace" });
    expect((await session.pull("fav")).map((c) => c.name)).toEqual(["Ada Lovelace"]);
    expect(await session.size()).toBe(3);

    const before = await session.version();
    expect(before.primaryCounter).toHaveLength(32);
    fake.setContacts([]);
    expect((await session.version()).primaryCounter).not.toBe(before.primaryCounter);

    fake.setCallHistory("mch", [{ number: "5550100003", type: "MISSED", time: "20250101T120000" }]);
    expect(await session.pull("mch")).toMatchObject([{ callType: "MISSED" }]);

    await session.close();
    await expect(session.pullContacts()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("refuses unknown and unreachable phones", async () => {
    const { fake } = phone({ reachable: false });
    await expect(fake.port.PbapSession.open("11:22:33:44:55:66")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(fake.port.PbapSession.open(fake.address)).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("Bluetooth", () => {
  it("pairs, watches, disconnects and forgets the phone", async () => {
    const { fake } = phone({ paired: false });
    const bt = await fake.port.Bluetooth.open();
    expect(await bt.devices()).toEqual([]);
    await bt.startDiscovery();
    expect((await bt.devices()).map((d) => d.isIphone)).toEqual([true]);

    const seen: string[] = [];
    const watch = await bt.watchDevices((event) => seen.push(event.kind));
    await expect(bt.pair(fake.address, () => false)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    let passkey = "";
    await bt.pair(fake.address, (request) => {
      if (request.kind === "confirm") passkey = request.passkey;
      return true;
    });
    expect(passkey).toBe("123456");
    expect(fake.device).toMatchObject({ paired: true, connected: true });

    const { link } = await mapLink(fake);
    const before = link.state();
    // Like obexd, the link pages the phone again straight away, on a new session.
    await bt.disconnect(fake.address);
    expect(link.state().kind).toBe("connected");
    expect(link.state()).not.toEqual(before);
    await bt.connect(fake.address);

    await bt.forget(fake.address);
    await fake.settle();
    expect(seen.at(-1)).toBe("deviceRemoved");
    watch.close();
    await expect(bt.connect("11:22:33:44:55:66")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("desktop notifications", () => {
  it("records notifications and reports clicks", async () => {
    const { fake } = phone();
    const events: NotifierEvent[] = [];
    const notifier = await fake.port.Notifier.open((event) => events.push(event));
    const id = await notifier.notify({ title: "Ada", body: "hi", threadKey: "tel:+15550100001" });
    expect(
      await notifier.notify({
        title: "Ada",
        body: "hi 2",
        threadKey: "tel:+15550100001",
        replaces: id,
      }),
    ).toBe(id);
    expect(fake.desktop.shown.get(id)?.body).toBe("hi 2");
    expect(fake.desktop.history).toHaveLength(2);

    fake.desktop.click(id, "reply");
    await fake.settle();
    expect(events).toEqual([
      { kind: "action", id, threadKey: "tel:+15550100001", action: "reply" },
      { kind: "closed", id, threadKey: "tel:+15550100001", reason: "dismissed" },
    ]);
    expect(fake.desktop.shown.size).toBe(0);
  });
});

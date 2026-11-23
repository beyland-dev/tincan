import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  AncsWatcher,
  DesktopNotifier,
  EventBus,
  Store,
  SyncEngine,
  nodeSqliteDb,
} from "@beyland/tincan-core";
import { DEFAULT_SETTINGS, type Settings } from "@beyland/tincan-protocol";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { FakePhone } from "../src/index.ts";

const T0 = 1_750_000_000;
const ADA = "5550100001";
const BOB = "5550100002";
const ADA_KEY = "tel:+15550100001";
const PAIR = "group:members:ada+bob";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
  options: {
    preload?: (fake: FakePhone) => void;
    iconDir?: string;
    iconLifetimeMs?: number;
    copyCodes?: boolean;
  } = {},
) {
  let seconds = T0;
  const now = () => seconds * 1000;
  const fake = new FakePhone({ now: () => seconds });
  options.preload?.(fake);
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now });
  const events = new EventBus();
  const errors: unknown[] = [];
  const onError = (_context: string, error: unknown) => errors.push(error);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const activated: string[] = [];
  const copied: string[] = [];
  const cancelled: string[] = [];
  const notifier = await DesktopNotifier.start({
    store,
    events,
    port: fake.port,
    settings: () => settings,
    iconDir: options.iconDir,
    iconLifetimeMs: options.iconLifetimeMs,
    delayMs: 60_000,
    onActivate: (key) => activated.push(key),
    ...(options.copyCodes ? { onCopyCode: (code: string) => void copied.push(code) } : {}),
    onCancelSend: (id: string) => void cancelled.push(id),
    onError,
  });
  const watcher = await AncsWatcher.start({
    port: fake.port,
    address: fake.address,
    events,
    onError,
  });
  const engine = await SyncEngine.start({
    store,
    port: fake.port,
    address: fake.address,
    events,
    defaultRegion: () => "US",
    relistIntervalMs: 0,
    now,
    onError,
  });
  /** Lets the sync engine store what arrived, without showing notifications yet. */
  const stored = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settle();
      await engine.idle();
    }
  };
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await fake.settle();
      await engine.idle();
    }
    await notifier.flush();
    await fake.settle();
    await notifier.idle();
  };
  await flush();
  return {
    fake,
    store,
    events,
    settings,
    notifier,
    watcher,
    engine,
    errors,
    activated,
    copied,
    cancelled,
    flush,
    stored,
    tick: (s = 1) => (seconds += s),
    shown: () => [...fake.desktop.shown.values()],
  };
}

describe("desktop notifications", () => {
  it("offers a Copy code button for a one-time code, which copies without opening the thread", async () => {
    const t = await setup({ copyCodes: true });
    t.fake.receive({ from: ADA, body: "Your verification code is 482913" });
    await t.flush();
    const [id] = [...t.fake.desktop.shown.keys()];
    expect(t.shown()[0]?.actions).toEqual([{ id: "copy-code", label: "Copy code" }]);

    t.fake.desktop.click(id!, "copy-code");
    await t.flush();
    expect(t.copied).toEqual(["482913"]);
    expect(t.activated).toEqual([]);

    t.tick();
    t.fake.receive({ from: BOB, body: "see you at 7" });
    await t.flush();
    expect(t.shown()[0]?.actions).toBeUndefined();

    t.settings.notifications.preview = "hidden";
    t.tick();
    t.fake.receive({ from: ADA, body: "Your code is 1234" });
    await t.flush();
    expect(t.shown().every((n) => n.actions === undefined)).toBe(true);
    expect(t.errors).toEqual([]);
  });

  it("shows one notification per conversation and replaces it as messages arrive", async () => {
    const t = await setup();
    t.fake.receive({ from: ADA, name: "Ada", body: "hi" });
    await t.flush();
    expect(t.shown()).toEqual([{ title: "+15550100001", body: "hi", threadKey: ADA_KEY }]);

    t.tick();
    t.fake.receive({ from: ADA, name: "Ada", body: "are you there?" });
    t.tick();
    t.fake.receive({ from: ADA, name: "Ada", body: "hello??" });
    await t.flush();
    expect(t.fake.desktop.shown.size).toBe(1);
    expect(t.shown()[0]).toMatchObject({ body: "hello??", threadKey: ADA_KEY });
    expect(t.fake.desktop.history.map((n) => n.id)).toEqual([1, 1]);
    expect(t.store.pendingNotifications()).toEqual([]);
    expect(t.errors).toEqual([]);
  });

  it("names the sender in a group and hides content as the preview setting asks", async () => {
    const t = await setup();
    t.fake.receive({ from: ADA, body: "dinner?", notification: false });
    await t.stored();
    // The user moved it to a group before its notification showed.
    const [dinner] = t.store.listMessages(ADA_KEY);
    t.store.recordGroup(PAIR, { named: false, name: null, participants: ["Ada", "Bob"] });
    t.store.moveMessage(dinner!.id, PAIR, "group");
    await t.flush();
    expect(t.shown()).toEqual([
      { title: expect.any(String), body: "+15550100001: dinner?", threadKey: PAIR },
    ]);

    t.settings.notifications.preview = "sender";
    t.fake.receive({ from: BOB, body: "sure", notification: false });
    await t.flush();
    const bob = t.shown().find((n) => n.threadKey !== PAIR)!;
    expect(bob.body).toBe("New message");
    expect(bob.title).not.toBe("Tincan");

    t.settings.notifications.preview = "hidden";
    t.fake.receive({ from: BOB, body: "see you at 7", notification: false });
    await t.flush();
    expect(t.shown().find((n) => n.threadKey === bob.threadKey)).toMatchObject({
      title: "Tincan",
      body: "2 new messages",
    });
    expect(JSON.stringify(t.fake.desktop.history.slice(-2))).not.toContain("see you");
  });

  it("skips muted conversations, read messages and history", async () => {
    const t = await setup({
      preload: (fake) => fake.seed([{ from: BOB, body: "from before Tincan ran" }]),
    });
    expect(t.shown()).toEqual([]);

    t.fake.receive({ from: ADA, body: "hi" });
    await t.flush();
    t.store.setThreadMuted(ADA_KEY, true);
    t.fake.desktop.close(1);
    await t.flush();
    t.fake.receive({ from: ADA, body: "again" });
    await t.flush();
    expect(t.shown()).toEqual([]);

    t.fake.receive({ from: BOB, body: "already read", read: true });
    await t.flush();
    expect(t.shown()).toEqual([]);
    expect(t.store.pendingNotifications()).toEqual([]);
  });

  it("withdraws the notification once the conversation is read", async () => {
    const t = await setup();
    t.fake.receive({ from: ADA, body: "hi" });
    await t.flush();
    expect(t.fake.desktop.shown.size).toBe(1);

    t.store.markThreadRead(ADA_KEY);
    t.events.emit("thread.changed", { keys: [ADA_KEY] });
    await t.flush();
    expect(t.fake.desktop.shown.size).toBe(0);
  });

  it("opens the conversation when clicked and starts fresh after a close", async () => {
    const t = await setup();
    t.fake.receive({ from: ADA, body: "hi" });
    await t.flush();
    t.fake.desktop.click(1);
    await t.flush();
    expect(t.activated).toEqual([ADA_KEY]);

    t.fake.receive({ from: ADA, body: "one more" });
    await t.flush();
    expect(t.fake.desktop.history.at(-1)).toMatchObject({ id: 2, body: "one more" });
    expect(t.fake.desktop.history.at(-1)!.replaces).toBeUndefined();
  });

  describe("contact photos as icons", () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    /** A private runtime folder, as `$XDG_RUNTIME_DIR/tincan` is, and the data folder beside it. */
    const folders = () => {
      const root = mkdtempSync(join(tmpdir(), "tincan-notifier-"));
      dirs.push(root);
      const data = join(root, "data");
      mkdirSync(data, { mode: 0o700 });
      return { run: join(root, "run"), data };
    };
    const withAda = async (options: Parameters<typeof setup>[0] = {}) => {
      const t = await setup(options);
      t.store.replaceContacts([
        {
          id: "ada",
          name: "Ada Lovelace",
          favorite: false,
          handles: [{ handle: ADA_KEY, label: null }],
        },
      ]);
      t.store.putContactPhoto("abc.jpg", "image/jpeg", JPEG);
      t.store.setContactPhoto("ada", "abc.jpg");
      return t;
    };
    const iconPath = (t: Awaited<ReturnType<typeof setup>>) => {
      const icon = t.shown()[0]?.icon;
      return icon ? fileURLToPath(icon) : null;
    };

    it("writes the photo to a short-lived 0600 file in the runtime folder, removed on close", async () => {
      const { run, data } = folders();
      const t = await withAda({ iconDir: run });
      t.fake.receive({ from: ADA, body: "hi" });
      await t.flush();
      expect(t.shown()[0]).toMatchObject({ title: "Ada Lovelace" });
      const path = iconPath(t)!;
      expect(t.shown()[0]!.icon!.startsWith(`${pathToFileURL(run).href}/`)).toBe(true);
      expect(readFileSync(path)).toEqual(JPEG);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(run).mode & 0o777).toBe(0o700);
      // Nothing about the photo is written anywhere else, the data folder included.
      expect(readdirSync(data)).toEqual([]);

      t.fake.desktop.close([...t.fake.desktop.shown.keys()][0]!);
      await t.flush();
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(run)).toEqual([]);
      expect(t.errors).toEqual([]);
    });

    it("removes a replaced notification's icon, and every icon when it stops", async () => {
      const { run } = folders();
      const t = await withAda({ iconDir: run });
      t.fake.receive({ from: ADA, body: "hi" });
      await t.flush();
      const first = iconPath(t)!;
      t.tick();
      t.fake.receive({ from: ADA, body: "again" });
      await t.flush();
      const second = iconPath(t)!;
      expect(second).not.toBe(first);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);

      await t.notifier.stop();
      expect(readdirSync(run)).toEqual([]);
    });

    it("removes an icon after its lifetime even if the notification stays", async () => {
      const { run } = folders();
      const t = await withAda({ iconDir: run, iconLifetimeMs: 20 });
      t.fake.receive({ from: ADA, body: "hi" });
      await t.flush();
      const path = iconPath(t)!;
      expect(existsSync(path)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(existsSync(path)).toBe(false);
      expect(t.shown()).toHaveLength(1);
    });

    it("cleans up icons left behind by an earlier run", async () => {
      const { run } = folders();
      mkdirSync(run, { mode: 0o700 });
      writeFileSync(join(run, "notify-icon-0123abcd.jpg"), JPEG);
      writeFileSync(join(run, "tincan.sock.other"), "");
      await setup({ iconDir: run });
      expect(readdirSync(run)).toEqual(["tincan.sock.other"]);
    });

    it("shows no photo, and writes nothing, without a private runtime folder", async () => {
      const t = await withAda();
      t.fake.receive({ from: ADA, body: "hi" });
      await t.flush();
      expect(t.shown()[0]).toMatchObject({ title: "Ada Lovelace", body: "hi" });
      expect(t.shown()[0]!.icon).toBeUndefined();

      const { run } = folders();
      mkdirSync(run, { mode: 0o755 });
      chmodSync(run, 0o755);
      const shared = await withAda({ iconDir: run });
      shared.fake.receive({ from: ADA, body: "hi" });
      await shared.flush();
      expect(shared.shown()[0]).toMatchObject({ title: "Ada Lovelace", body: "hi" });
      expect(shared.shown()[0]!.icon).toBeUndefined();
      expect(readdirSync(run)).toEqual([]);
    });
  });

  it("waits a moment before showing, so a burst of messages shows as one notification", async () => {
    const t = await setup();
    t.fake.receive({ from: ADA, body: "hi", notification: false });
    await t.stored();
    expect(t.shown()).toEqual([]);
    await t.flush();
    expect(t.shown()).toHaveLength(1);
  });

  it("announces queued agent drafts once per conversation, and opens it when clicked", async () => {
    const t = await setup();
    const NEW = "tel:+15550100077";
    const draft = (to: string, text: string) => {
      const created = t.store.insertAgentDraft({
        to,
        agentName: "Claude Code",
        intent: "send",
        text,
      });
      t.events.emit("draft.changed", { id: created.id, state: "queued", threadKey: to });
      return created;
    };
    const first = draft(ADA_KEY, "Lunch at noon?");
    draft(ADA_KEY, "Or 1?");
    draft(NEW, "Hello there");
    await t.notifier.flushDrafts();
    await t.notifier.idle();
    expect(t.shown()).toEqual(
      expect.arrayContaining([
        {
          title: "Claude Code drafted 2 messages",
          body: "To +15550100001: Or 1?",
          threadKey: `draft:${ADA_KEY}`,
        },
        {
          title: "Claude Code drafted a message",
          body: "To +15550100077: Hello there",
          threadKey: `draft:${NEW}`,
        },
      ]),
    );
    // Clicking opens the conversation, or the new recipient.
    const [newId] = [...t.fake.desktop.shown].find(([, n]) => n.threadKey === `draft:${NEW}`)!;
    t.fake.desktop.click(newId);
    await t.fake.settle();
    expect(t.activated).toEqual([NEW]);

    // Gone once nothing is queued there.
    for (const d of t.store.listAgentDrafts({ to: ADA_KEY })) {
      const done = t.store.setAgentDraftState(d.id, "discarded")!;
      t.events.emit("draft.changed", { id: done.id, state: "discarded", threadKey: ADA_KEY });
    }
    await t.notifier.idle();
    // (The clicked one closed itself.)
    expect(t.shown()).toEqual([]);
    expect(first.id).toMatch(/^drf_/);

    // Honors notifications.preview.
    t.settings.notifications.preview = "hidden";
    draft(ADA_KEY, "secret");
    await t.notifier.flushDrafts();
    await t.notifier.idle();
    expect(t.shown().find((n) => n.threadKey === `draft:${ADA_KEY}`)).toEqual({
      title: "Tincan",
      body: "An AI agent drafted a message",
      threadKey: `draft:${ADA_KEY}`,
    });
  });

  it("shows an agent's direct send during its delay with a Cancel button, until it goes", async () => {
    const t = await setup();
    t.settings.notifications.preview = "sender";
    const created = t.store.insertAgentDraft({
      to: ADA_KEY,
      agentName: "Claude Code",
      intent: "send",
      text: "On my way",
      state: "scheduled",
    });
    const message = t.store.queueOutgoing({
      threadKey: ADA_KEY,
      body: "On my way",
      recipients: [ADA],
      agent: { name: "Claude Code", edited: false, via: "policy" },
      sendAt: Date.now() + 10_000,
      agentDraftId: created.id,
    });
    t.events.emit("draft.changed", { id: created.id, state: "scheduled", threadKey: ADA_KEY });
    await t.notifier.idle();
    const [[id, shown]] = [...t.fake.desktop.shown];
    expect(shown).toMatchObject({
      title: "Claude Code is sending to +15550100001 in 10 s",
      threadKey: `sending:${message.id}`,
      actions: [{ id: "cancel-send", label: "Cancel" }],
    });
    expect(shown!.body).toBe("");
    // Once it goes (or is cancelled), the notice closes.
    t.events.emit("message.sendStatus", { id: message.id, status: "pending" });
    await t.notifier.idle();
    expect(t.fake.desktop.shown.size).toBe(0);

    // Its Cancel button cancels it, without opening the app.
    t.events.emit("draft.changed", { id: created.id, state: "scheduled", threadKey: ADA_KEY });
    await t.notifier.idle();
    const [again] = [...t.fake.desktop.shown.keys()];
    expect(again).not.toBe(id);
    t.fake.desktop.click(again!, "cancel-send");
    await t.fake.settle();
    expect(t.cancelled).toEqual([message.id]);
    expect(t.activated).toEqual([]);
    expect(t.shown()).toEqual([]);
  });

  it("doesn't mirror other apps' notifications", async () => {
    const t = await setup();
    t.fake.notify({
      appId: "com.example.calendar",
      appName: "Calendar",
      title: "Standup",
      body: "in 10 minutes",
    });
    await t.flush();
    expect(t.shown()).toEqual([]);
  });

  it("stops cleanly", async () => {
    const t = await setup();
    await t.notifier.stop();
    t.fake.receive({ from: ADA, body: "hi" });
    await t.flush().catch(() => {});
    expect(t.shown()).toEqual([]);
    await t.watcher.stop();
    await t.engine.stop();
  });
});

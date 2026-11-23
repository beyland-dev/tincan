import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TincanClient } from "@beyland/tincan-client";
import { Core, nodeSqliteDb, Store } from "@beyland/tincan-core";
import type { RuntimePaths } from "@beyland/tincan-protocol/paths";
import type { ClientInfo, TincanEvent } from "@beyland/tincan-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { acquireLock, startDaemon, type Daemon } from "../src/index.ts";
import { eventForClient } from "../src/agent-events.ts";

let root: string;
let paths: RuntimePaths;
const children: ChildProcess[] = [];
const daemons: Daemon[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-runtime-"));
  const dir = path.join(root, "run");
  paths = { dir, socket: path.join(dir, "tincan.sock"), lock: path.join(dir, "tincan.lock") };
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

/** A live process whose command line is `argv` (after node's own). */
async function liveProcess(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...argv], {
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  children.push(child);
  await new Promise((r) => child.once("spawn", r));
  return child;
}

async function start(version = "0.0.0-test"): Promise<Daemon> {
  const daemon = await startDaemon({ core: await Core.open({ version }), paths });
  daemons.push(daemon);
  return daemon;
}

describe("single-instance lock", () => {
  it("replaces a lock whose pid was reused by an unrelated process", async () => {
    await start();
    await daemons.pop()!.close();
    const unrelated = await liveProcess(["sleep-forever"]);
    await writeFile(paths.lock, `${unrelated.pid}\n`);
    await start("again");
    expect(await readFile(paths.lock, "utf8")).toBe(`${process.pid}\n`);
  });

  it("respects a lock held by a live tincan daemon even before it listens", async () => {
    await start();
    await daemons.pop()!.close();
    const other = await liveProcess(["/usr/bin/tincan", "daemon"]);
    await writeFile(paths.lock, `${other.pid}\n`);
    await expect(start()).rejects.toMatchObject({ code: "BUSY", details: { pid: other.pid } });
    expect(await readFile(paths.lock, "utf8")).toBe(`${other.pid}\n`);
  });

  it("respects a lock whose socket still answers, whatever its pid", async () => {
    await start();
    await daemons.pop()!.close();
    await writeFile(paths.lock, "999999999\n");
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(paths.socket, r));
    try {
      await expect(start()).rejects.toMatchObject({ code: "BUSY" });
      expect((await stat(paths.socket)).isSocket()).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("lets only one of several racing daemons take over a stale lock", async () => {
    await start();
    await daemons.pop()!.close();
    await writeFile(paths.lock, "999999999\n");
    const script = `
      const { acquireLock } = await import(${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)});
      try {
        await acquireLock(process.env.LOCK, { socket: process.env.SOCK });
        console.log("won");
        // Hold the lock until the test has every answer, so no racer can find it stale because
        // the winner already exited (it's killed in afterEach).
        setInterval(() => {}, 1000);
      } catch (error) {
        console.log(error.code);
      }`;
    const racers = Array.from({ length: 6 }, () => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, "tincan", "daemon"],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, LOCK: paths.lock, SOCK: paths.socket },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      children.push(child);
      return new Promise<string>((resolve) => {
        let out = "";
        child.stdout!.on("data", (d) => {
          out += d;
          if (out.includes("\n")) resolve(out.trim());
        });
        child.once("exit", () => resolve(out.trim()));
      });
    });
    const results = await Promise.all(racers);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "BUSY")).toHaveLength(5);
    // No temporary or set-aside lock files are left behind.
    expect((await readdir(paths.dir)).filter((f) => f.startsWith("tincan.lock."))).toEqual([]);
  });

  it("leaves a lock alone that replaced the stale one it inspected", async () => {
    await start();
    await daemons.pop()!.close();
    const unrelated = await liveProcess(["sleep-forever"]);
    const winner = await liveProcess(["/usr/bin/tincan", "daemon"]);
    await writeFile(paths.lock, `${unrelated.pid}\n`);
    const readCmdline = async (pid: number) => {
      if (pid !== unrelated.pid) return ["/usr/bin/tincan", "daemon"];
      // While this daemon judges the old lock stale, another one takes over first.
      const next = `${paths.lock}.next`;
      await writeFile(next, `${winner.pid}\n`);
      await rename(next, paths.lock);
      return ["sleep-forever"];
    };
    await expect(
      acquireLock(paths.lock, { socket: paths.socket, readCmdline }),
    ).rejects.toMatchObject({
      code: "BUSY",
      details: { pid: winner.pid },
    });
    expect(await readFile(paths.lock, "utf8")).toBe(`${winner.pid}\n`);
    expect((await readdir(paths.dir)).filter((f) => f.startsWith("tincan.lock."))).toEqual([]);
  });

  it("waits out a takeover in progress", async () => {
    await start();
    await daemons.pop()!.close();
    await writeFile(paths.lock, "999999999\n");
    const taker = await liveProcess(["/usr/bin/tincan", "daemon"]);
    const token = `${paths.lock}.takeover.0`;
    await writeFile(token, `${taker.pid}\n`);
    await expect(start()).rejects.toMatchObject({ code: "BUSY", details: { pid: taker.pid } });
    expect(await readFile(paths.lock, "utf8")).toBe("999999999\n");
    expect(await readFile(token, "utf8")).toBe(`${taker.pid}\n`);
  });

  it("takes over past a takeover token left by a daemon that died", async () => {
    await start();
    await daemons.pop()!.close();
    await writeFile(paths.lock, "999999999\n");
    await writeFile(`${paths.lock}.takeover.0`, "999999998\n");
    await start("again");
    expect(await readFile(paths.lock, "utf8")).toBe(`${process.pid}\n`);
    // The dead token is cleaned up with the stale lock it guarded.
    expect((await readdir(paths.dir)).filter((f) => f.startsWith("tincan.lock."))).toEqual([]);
  });

  it("releases only its own lock", async () => {
    const lock = path.join(root, "own.lock");
    const release = await acquireLock(lock);
    await unlink(lock);
    await writeFile(lock, "12345\n");
    await release();
    expect(await readFile(lock, "utf8")).toBe("12345\n");
  });

  it("leaves a successor's socket alone on shutdown", async () => {
    const daemon = await start();
    // Simulate a successor that replaced the socket after a takeover.
    await unlink(paths.socket);
    const successor = net.createServer();
    await new Promise<void>((r) => successor.listen(paths.socket, r));
    try {
      await daemons.pop()!.close();
      expect((await stat(paths.socket)).isSocket()).toBe(true);
      expect(daemon.connections).toBe(0);
    } finally {
      await new Promise((r) => successor.close(r));
    }
  });
});

describe("transport limits", () => {
  it("answers every request when many are sent at once", async () => {
    await start();
    const socket = net.createConnection(paths.socket);
    const count = 500;
    const ids = new Set<number>();
    const done = new Promise<void>((resolve) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          if (typeof message.id === "number" && message.result) ids.add(message.id);
        }
        if (ids.size === count) resolve();
      });
    });
    const client = { kind: "cli", name: "flood" };
    socket.write(
      Array.from({ length: count }, (_, i) =>
        JSON.stringify({ id: i, method: "version", client }),
      ).join("\n") + "\n",
    );
    await done;
    socket.destroy();
    expect(ids.size).toBe(count);
  });

  it("logs a client name without its control characters", async () => {
    const logs: string[] = [];
    const core = await Core.open({ version: "t" });
    const daemon = await startDaemon({ core, paths, log: (m) => logs.push(m) });
    daemons.push(daemon);
    const socket = net.createConnection(paths.socket);
    await new Promise((r) => socket.once("data", r));
    const client = { kind: "cli", name: "evil\nfake log line\u001b[31m" };
    socket.write(`${JSON.stringify({ id: 1, method: "events.subscribe", client })}\n`);
    await new Promise((r) => socket.once("data", r));
    // Stop reading and flood events until the daemon gives up on this subscriber.
    socket.pause();
    const closed = new Promise((r) => socket.once("close", r));
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 40 && !socket.destroyed; i++) {
      core.events.emit("thread.changed", { keys: [big] });
      await new Promise((r) => setImmediate(r));
    }
    socket.resume();
    await closed;
    const line = logs.find((l) => l.includes("stopped reading"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).toContain("cli/evil?fake log line?[31m");
  });
});

describe("events for agents", () => {
  const mcp: ClientInfo = { kind: "mcp", name: "agent" };
  const cli: ClientInfo = { kind: "cli", name: "test" };
  const ALICE = "tel:+12065550101";
  const SHORT = "tel:12345";

  async function setup(agents: Record<string, unknown>) {
    const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")));
    const core = await Core.open({ version: "t", store, settings: { agents } as never });
    store.ensureThread(ALICE);
    store.ensureThread("tel:+12065550102");
    store.hideHandle("tel:+12065550102", "+12065550102");
    store.ensureThread(SHORT);
    return core;
  }

  const thread = (keys: string[]): TincanEvent => ({
    event: "thread.changed",
    seq: 1,
    data: { keys },
  });

  it("gives agents nothing but settings while agents are off", async () => {
    const core = await setup({ access: "off", read: "all" });
    expect(eventForClient(core, mcp, thread([ALICE]))).toBeNull();
    const settings: TincanEvent = { event: "settings.changed", seq: 2, data: core.settings };
    // Only the agent policy, as settings.get gives it to agents.
    expect(eventForClient(core, mcp, settings)).toEqual({
      ...settings,
      data: { agents: core.settings.agents },
    });
    expect(eventForClient(core, cli, settings)).toBe(settings);
    expect(eventForClient(core, cli, thread([ALICE]))).toEqual(thread([ALICE]));
  });

  it("drops conversation events when agents may not read", async () => {
    const core = await setup({ access: "assistant", read: "off" });
    expect(eventForClient(core, mcp, thread([ALICE]))).toBeNull();
    const message: TincanEvent = {
      event: "message.changed",
      seq: 1,
      data: { threadKey: ALICE, ids: ["m1"] },
    };
    expect(eventForClient(core, mcp, message)).toBeNull();
  });

  it("drops hidden and short-code threads and masks handles", async () => {
    const core = await setup({
      access: "assistant",
      read: "all",
      handles: "hidden",
      hideCodes: true,
    });
    const out = eventForClient(
      core,
      mcp,
      thread([ALICE, "tel:+12065550102", SHORT, "group:name:book-club"]),
    );
    expect(out).toEqual(thread([core.handleMasker.mask(ALICE), "group:name:book-club"]));
    expect(JSON.stringify(out)).not.toContain("+1206");
    expect(eventForClient(core, mcp, thread([SHORT]))).toBeNull();
    const message = eventForClient(core, mcp, {
      event: "message.changed",
      seq: 1,
      data: { threadKey: ALICE, ids: ["m1"] },
    });
    expect(message).toEqual({
      event: "message.changed",
      seq: 1,
      data: {
        threadKey: core.handleMasker.mask(ALICE),
        ids: [core.handleMasker.maskMessageId("m1")],
      },
    });
    expect(
      eventForClient(core, mcp, {
        event: "message.changed",
        seq: 1,
        data: { threadKey: "tel:+12065550102", ids: [] },
      }),
    ).toBeNull();
  });

  it("drops contacts and groups hidden from agents", async () => {
    const core = await setup({ access: "assistant", read: "all" });
    const store = core.requireStore();
    store.replaceContacts([
      { id: "mom", name: "Mom", favorite: false, handles: [{ handle: ALICE, label: null }] },
      {
        id: "bob",
        name: "Bob",
        favorite: false,
        handles: [{ handle: "tel:+12065550103", label: null }],
      },
    ]);
    store.hideContact("mom");
    store.ensureThread("group:name:family", "group");
    store.setThreadMembers("group:name:family", [ALICE, "tel:+12065550103"]);
    const contacts = (ids: string[]): TincanEvent => ({
      event: "contact.changed",
      seq: 1,
      data: { ids },
    });
    expect(eventForClient(core, mcp, contacts(["mom", "bob"]))).toEqual(contacts(["bob"]));
    expect(eventForClient(core, mcp, contacts(["mom"]))).toBeNull();
    expect(eventForClient(core, mcp, contacts([]))).toEqual(contacts([]));
    expect(eventForClient(core, mcp, thread([ALICE, "group:name:family"]))).toBeNull();
    expect(eventForClient(core, cli, contacts(["mom"]))).toEqual(contacts(["mom"]));
  });

  it("tells an agent only what became of its own drafts, even out of scope", async () => {
    const core = await setup({ access: "assistant", read: "contacts", send: "approve" });
    const store = core.requireStore();
    const mine = store.insertAgentDraft({
      to: "tel:+12065550102", // hidden from agents
      agentName: "agent",
      intent: "send",
      text: "x",
    });
    const theirs = store.insertAgentDraft({
      to: ALICE,
      agentName: "Someone Else",
      intent: "draft",
      text: "y",
    });
    const changed = (id: string): TincanEvent => ({
      event: "draft.changed",
      seq: 1,
      data: { id, state: "discarded", threadKey: "tel:+12065550102" },
    });
    expect(eventForClient(core, mcp, changed(mine.id))).toEqual({
      event: "draft.changed",
      seq: 1,
      data: { id: mine.id, state: "discarded" },
    });
    expect(eventForClient(core, mcp, changed(theirs.id))).toBeNull();
    expect(eventForClient(core, cli, changed(theirs.id))).toEqual(changed(theirs.id));
    core.updateSettings({ agents: { access: "off" } });
    expect(eventForClient(core, mcp, changed(mine.id))).toBeNull();
  });

  it("drops conversations outside agents.read's scope", async () => {
    const core = await setup({ access: "full", read: "contacts", handles: "visible" });
    const store = core.requireStore();
    store.replaceContacts([
      { id: "alice", name: "Alice", favorite: false, handles: [{ handle: ALICE, label: null }] },
    ]);
    const STRANGER = "tel:+12065550199";
    store.ensureThread(STRANGER);
    expect(eventForClient(core, mcp, thread([ALICE, STRANGER]))).toEqual(thread([ALICE]));
    expect(eventForClient(core, mcp, thread([STRANGER]))).toBeNull();
    const message = (threadKey: string): TincanEvent => ({
      event: "message.changed",
      seq: 1,
      data: { threadKey, ids: ["m1"] },
    });
    expect(eventForClient(core, mcp, message(ALICE))).not.toBeNull();
    expect(eventForClient(core, mcp, message(STRANGER))).toBeNull();
    const queued = store.queueOutgoing({ threadKey: STRANGER, body: "x", recipients: [] });
    const status: TincanEvent = {
      event: "message.sendStatus",
      seq: 1,
      data: { id: queued.id, status: "sent" },
    };
    expect(eventForClient(core, mcp, status)).toBeNull();
    // `all` lets the stranger through.
    core.updateSettings({ agents: { read: "all" } });
    expect(eventForClient(core, mcp, message(STRANGER))).not.toBeNull();
    expect(eventForClient(core, mcp, status)).toEqual(status);
  });

  it("redacts the phone's address and drops pairing for agents", async () => {
    const core = await setup({ access: "assistant", read: "all" });
    const device: TincanEvent = {
      event: "device.changed",
      seq: 1,
      data: { address: "AA:BB:CC:DD:EE:FF" },
    };
    expect(eventForClient(core, mcp, device)).toEqual({
      ...device,
      data: { address: "00:00:00:00:00:00" },
    });
    expect(eventForClient(core, cli, device)).toBe(device);
    const pairing: TincanEvent = { event: "pairing.changed", seq: 1, data: { state: "confirm" } };
    expect(eventForClient(core, mcp, pairing)).toBeNull();
    expect(eventForClient(core, cli, pairing)).toBe(pairing);
  });

  it("shows real keys when the user lets agents see handles, with full access only", async () => {
    const core = await setup({ access: "full", read: "all", handles: "visible", hideCodes: false });
    expect(eventForClient(core, mcp, thread([ALICE, SHORT]))).toEqual(thread([ALICE, SHORT]));
    core.updateSettings({ agents: { access: "assistant" } });
    expect(eventForClient(core, mcp, thread([ALICE, SHORT]))).toEqual(
      thread([core.handleMasker.mask(ALICE)]),
    );
  });

  it("filters events streamed to an mcp subscriber", async () => {
    const core = await setup({
      access: "assistant",
      read: "all",
      handles: "hidden",
      hideCodes: true,
    });
    const daemon = await startDaemon({ core, paths });
    daemons.push(daemon);
    const agent = await TincanClient.connect({ socketPath: paths.socket, client: mcp });
    const events: TincanEvent[] = [];
    const got = new Promise<void>((resolve) => {
      void agent.subscribe((event) => {
        events.push(event);
        if (event.event === "message.changed") resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    core.events.emit("thread.changed", { keys: [SHORT] });
    core.events.emit("message.changed", { threadKey: ALICE, ids: [] });
    await got;
    await agent.close();
    expect(events.map((e) => e.event)).toEqual(["message.changed"]);
    expect(JSON.stringify(events)).not.toContain("+1206");
  });
});

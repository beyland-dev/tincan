import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { TincanClient } from "@beyland/tincan-client";
import { Core } from "@beyland/tincan-core";
import type { RuntimePaths } from "@beyland/tincan-protocol/paths";
import { PROTOCOL_VERSION, type TincanEvent } from "@beyland/tincan-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { startDaemon, type Daemon } from "../src/index.ts";

const cli = { kind: "cli", name: "test" } as const;
let root: string;
let paths: RuntimePaths;
let core: Core;
let daemon: Daemon | undefined;
const clients: TincanClient[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-daemon-"));
  const dir = path.join(root, "tincan");
  paths = { dir, socket: path.join(dir, "tincan.sock"), lock: path.join(dir, "tincan.lock") };
  core = await Core.open({ version: "0.0.0-test" });
  daemon = await startDaemon({ core, paths });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await daemon?.close();
  await rm(root, { recursive: true, force: true });
});

async function connect(kind: "cli" | "mcp" | "desktop" = "cli") {
  const client = await TincanClient.connect({
    socketPath: paths.socket,
    client: { kind, name: "test" },
  });
  clients.push(client);
  return client;
}

function rawLines(socket: net.Socket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n").filter(Boolean);
      if (lines.length >= count) resolve(lines.slice(0, count).map((l) => JSON.parse(l)));
    });
  });
}

describe("daemon", () => {
  it("creates a private runtime directory and socket", async () => {
    expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.socket)).mode & 0o777).toBe(0o600);
  });

  it("greets clients and answers typed commands", async () => {
    const client = await connect();
    expect(client.hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.hello.methods).toContain("status");
    expect(client.hello.methods).toContain("events.subscribe");

    const status = await client.run("status");
    expect(status.daemon.version).toBe("0.0.0-test");
    expect(status.daemon.pid).toBe(process.pid);
    expect(status.phone.state).toBe("unpaired");
  });

  it("returns typed errors", async () => {
    const client = await connect();
    await expect(client.call("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      client.call("settings.set", { agents: { send: "sometimes" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("applies the agent policy to mcp clients", async () => {
    const agent = await connect("mcp");
    await expect(agent.call("settings.set", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const commands = await agent.run("commands", { includeInternal: true });
    expect(commands.map((c) => c.name)).not.toContain("settings.set");
  });

  it("rejects malformed requests without dropping the connection", async () => {
    const socket = net.createConnection(paths.socket);
    const lines = rawLines(socket, 4);
    socket.write("not json\n");
    socket.write(`${JSON.stringify({ id: 7, method: "status" })}\n`);
    socket.write(`${JSON.stringify({ id: 8, method: "version", client: cli })}\n`);
    const [hello, bad, missingClient, ok] = (await lines) as Record<string, any>[];
    socket.destroy();
    expect(hello!.hello).toBeDefined();
    expect(bad).toMatchObject({ id: null, error: { code: "INVALID_INPUT" } });
    expect(missingClient).toMatchObject({ id: 7, error: { code: "INVALID_INPUT" } });
    expect(ok).toMatchObject({ id: 8, result: { version: "0.0.0-test" } });
  });

  it("streams events to subscribers", async () => {
    const client = await connect();
    const events: TincanEvent[] = [];
    const received = new Promise<void>((resolve) => {
      void client.subscribe((event) => {
        events.push(event);
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    await client.run("settings.set", { agents: { read: "all" } });
    await received;
    expect(events[0]).toMatchObject({
      event: "settings.changed",
      data: { agents: { read: "all" } },
    });
  });

  it("refuses to start a second daemon", async () => {
    const other = await Core.open({ version: "x" });
    await expect(startDaemon({ core: other, paths })).rejects.toMatchObject({ code: "BUSY" });
    // The first daemon still answers.
    expect((await (await connect()).run("version")).version).toBe("0.0.0-test");
  });

  it("replaces a stale lock and socket", async () => {
    await daemon!.close();
    daemon = undefined;
    await writeFile(paths.lock, "999999999\n");
    // A daemon killed with SIGKILL leaves its socket file behind.
    spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(paths.socket)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect((await stat(paths.socket)).isSocket()).toBe(true);
    daemon = await startDaemon({ core: await Core.open({ version: "again" }), paths });
    expect((await (await connect()).run("version")).version).toBe("again");
  });

  it("refuses a runtime directory others can read", async () => {
    await daemon!.close();
    daemon = undefined;
    await chmod(paths.dir, 0o755);
    await expect(startDaemon({ core, paths })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("notifies clients when it stops", async () => {
    const client = await connect();
    const closed = new Promise<void>((resolve) => client.onClose(() => resolve()));
    await core.close();
    await daemon!.close();
    daemon = undefined;
    await closed;
    await expect(client.run("status")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeLine, PROTOCOL_VERSION } from "@beyland/tincan-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ensureDaemon, TincanClient, ReconnectingClient, runtimePaths } from "../src/index.ts";

const client = { kind: "cli", name: "test" } as const;
let dir: string;
let socketPath: string;
let server: net.Server | undefined;
const sockets = new Set<net.Socket>();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tincan-client-"));
  socketPath = path.join(dir, "s.sock");
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

function fakeDaemon(onConnection: (socket: net.Socket) => void): Promise<void> {
  server = net.createServer((socket) => {
    sockets.add(socket);
    onConnection(socket);
  });
  return new Promise((r) => server!.listen(socketPath, r));
}

const hello = (protocolVersion: number = PROTOCOL_VERSION) =>
  encodeLine({ hello: { protocolVersion, server: { name: "tincan", version: "t" }, methods: [] } });

describe("runtimePaths", () => {
  it("prefers TINCAN_SOCKET, then XDG_RUNTIME_DIR", () => {
    expect(runtimePaths({ TINCAN_SOCKET: "/x/y.sock" })).toEqual({
      dir: "/x",
      socket: "/x/y.sock",
      lock: "/x/tincan.lock",
    });
    expect(runtimePaths({ XDG_RUNTIME_DIR: "/run/user/1000" }).socket).toBe(
      "/run/user/1000/tincan/tincan.sock",
    );
    expect(runtimePaths({}).socket).toMatch(/tincan-\d+\/tincan\.sock$/);
  });
});

describe("TincanClient", () => {
  it("explains when the daemon is not running", async () => {
    await expect(TincanClient.connect({ socketPath, client })).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });

  it("refuses a daemon speaking another protocol version", async () => {
    await fakeDaemon((socket) => socket.write(hello(99)));
    await expect(TincanClient.connect({ socketPath, client })).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
  });

  it("times out requests the daemon never answers", async () => {
    await fakeDaemon((socket) => socket.write(hello()));
    const c = await TincanClient.connect({ socketPath, client, timeoutMs: 50 });
    await expect(c.call("status")).rejects.toMatchObject({ code: "TIMEOUT" });
    await c.close();
  });

  it("matches responses to requests and maps errors", async () => {
    await fakeDaemon((socket) => {
      socket.write(hello());
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          expect(request.client).toEqual(client);
          socket.write(
            request.method === "fail"
              ? encodeLine({ id: request.id, error: { code: "BUSY", message: "taken" } })
              : encodeLine({ id: request.id, result: { echo: request.params } }),
          );
        }
      });
    });
    const c = await TincanClient.connect({ socketPath, client });
    const [a, b] = await Promise.all([c.call("one", 1), c.call("two", 2)]);
    expect(a).toEqual({ echo: 1 });
    expect(b).toEqual({ echo: 2 });
    await expect(c.call("fail")).rejects.toMatchObject({ code: "BUSY", message: "taken" });
    await c.close();
  });

  it("rejects pending requests when the daemon goes away", async () => {
    await fakeDaemon((socket) => {
      socket.write(hello());
      socket.on("data", () => socket.destroy());
    });
    const c = await TincanClient.connect({ socketPath, client });
    await expect(c.call("status")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(c.closed).toBe(true);
  });
});

/** A fake daemon that answers every request with `{ok: method}` and acks subscriptions. */
function answering(socket: net.Socket, onRequest?: (method: string) => void): void {
  socket.write(hello());
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      onRequest?.(request.method);
      socket.write(encodeLine({ id: request.id, result: { ok: request.method } }));
    }
  });
}

describe("ensureDaemon", () => {
  it("connects straight away when the daemon is up", async () => {
    await fakeDaemon((socket) => answering(socket));
    const calls: Array<Array<string>> = [];
    const c = await ensureDaemon({
      socketPath,
      client,
      systemctl: async (args) => void calls.push(args),
    });
    expect(calls).toEqual([]);
    await c.close();
  });

  it("starts the systemd service and waits for the socket", async () => {
    const calls: Array<Array<string>> = [];
    const c = await ensureDaemon({
      socketPath,
      client,
      spawn: null,
      systemctl: async (args) => {
        calls.push(args);
        if (args[0] === "start") setTimeout(() => void fakeDaemon((s) => answering(s)), 50);
      },
    });
    expect(calls).toEqual([
      ["is-enabled", "--quiet", "tincan.service"],
      ["start", "tincan.service"],
    ]);
    expect(await c.call("status")).toEqual({ ok: "status" });
    await c.close();
  });

  it("spawns the daemon when no service is installed", async () => {
    const script = `require("node:net").createServer((s) => s.write(${JSON.stringify(hello())})).listen(${JSON.stringify(socketPath)}); setTimeout(() => process.exit(0), 3000);`;
    const c = await ensureDaemon({
      socketPath,
      client,
      systemctl: async () => {
        throw new Error("no unit");
      },
      spawn: { command: process.execPath, args: ["-e", script] },
    });
    expect(c.hello.protocolVersion).toBe(PROTOCOL_VERSION);
    await c.close();
  });

  it("gives up when it can't start anything", async () => {
    await expect(
      ensureDaemon({ socketPath, client, service: null, spawn: null }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});

describe("ReconnectingClient", () => {
  it("reconnects, keeps event handlers and reports its state", async () => {
    const methods: Array<string> = [];
    await fakeDaemon((socket) => answering(socket, (m) => methods.push(m)));
    const rc = new ReconnectingClient({
      connect: () => TincanClient.connect({ socketPath, client }),
      minDelayMs: 10,
    });
    const events: Array<string> = [];
    rc.subscribe((e) => events.push(e.event));
    const states: Array<string> = [];
    rc.onState((s) => states.push(s.state));
    await rc.ready();
    expect(await rc.run("status")).toEqual({ ok: "status" });

    for (const socket of sockets) socket.write(encodeLine({ event: "thread.changed", data: {} }));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["thread.changed"]);

    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((r) => setTimeout(r, 10));
    await rc.ready();
    expect(states).toContain("connecting");
    expect(states.at(-1)).toBe("connected");
    expect(methods.filter((m) => m === "events.subscribe")).toHaveLength(2);

    for (const socket of sockets) socket.write(encodeLine({ event: "message.changed", data: {} }));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["thread.changed", "message.changed"]);
    await rc.close();
    expect(rc.state.state).toBe("closed");
  });

  it("keeps retrying until the daemon appears", async () => {
    const rc = new ReconnectingClient({
      connect: () => TincanClient.connect({ socketPath, client }),
      minDelayMs: 10,
      maxDelayMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(rc.state).toMatchObject({ state: "connecting" });
    await expect(rc.call("status")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await fakeDaemon((socket) => answering(socket));
    await rc.ready();
    await rc.close();
  });
});

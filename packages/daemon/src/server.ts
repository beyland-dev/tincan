import { chmod, rename, unlink } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import type { Core } from "@beyland/tincan-core";
import {
  encodeLine,
  LineDecoder,
  TincanError,
  PROTOCOL_VERSION,
  Request,
  toWireError,
  TRANSPORT_METHODS,
  type ClientInfo,
  type Hello,
  type TincanEvent,
  type RequestId,
} from "@beyland/tincan-protocol";
import type { RuntimePaths } from "@beyland/tincan-protocol/paths";
import { eventForClient } from "./agent-events.ts";
import {
  acquireLock,
  ensureRuntimeDir,
  removeOwnSocket,
  removeStaleSocket,
  socketIdentity,
  type SocketIdentity,
} from "./runtime.ts";

/** Drop clients that stop reading instead of buffering replies and events forever. */
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
/** Local clients: the app, CLI runs and one MCP server per agent session. */
const MAX_CONNECTIONS = 128;
/** Requests a connection may have running at once; further lines wait (the socket is paused). */
const MAX_IN_FLIGHT = 64;

export interface DaemonOptions {
  core: Core;
  paths: RuntimePaths;
  log?: (message: string) => void;
}

export interface Daemon {
  readonly paths: RuntimePaths;
  readonly connections: number;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { core, paths } = options;
  const log = options.log ?? (() => {});

  await ensureRuntimeDir(paths.dir);
  const releaseLock = await acquireLock(paths.lock, { socket: paths.socket });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => handleConnection(socket, core, sockets, log));
  server.maxConnections = MAX_CONNECTIONS;
  let ownSocket: SocketIdentity | null = null;

  try {
    await removeStaleSocket(paths.socket);
    // Bind under a private name and rename it into place. Node unlinks the path it bound when the
    // server closes, so binding the real path would delete a successor's socket on shutdown; and
    // the socket never appears with the wrong mode.
    const bindPath = bindPathFor(paths);
    if (bindPath !== paths.socket) await unlink(bindPath).catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(bindPath, 0o600);
    if (bindPath !== paths.socket) await rename(bindPath, paths.socket);
    ownSocket = await socketIdentity(paths.socket);
    // Accept errors (e.g. EMFILE) are reported here; without a listener they'd crash the daemon.
    server.on("error", (error) => log(`server error: ${error.message}`));
    server.on("drop", () => log(`refusing a connection (more than ${MAX_CONNECTIONS} open)`));
  } catch (error) {
    if (server.listening) server.close();
    await removeOwnSocket(paths.socket, ownSocket);
    await releaseLock();
    throw error;
  }
  log(`listening on ${paths.socket}`);

  let closing: Promise<void> | undefined;
  return {
    paths,
    get connections() {
      return sockets.size;
    },
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.end();
        setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, 500).unref();
        await closed;
        // A daemon that replaced this one (after a stale-lock takeover) owns the path now.
        await removeOwnSocket(paths.socket, ownSocket);
        await releaseLock();
        log("stopped");
      })();
      return closing;
    },
  };
}

/** Unix socket paths are limited to 107 bytes; past that, bind the real path directly. */
function bindPathFor(paths: RuntimePaths): string {
  const temp = path.join(path.dirname(paths.socket), `.tincan-${process.pid}.sock`);
  return Buffer.byteLength(temp) <= 107 ? temp : paths.socket;
}

function handleConnection(
  socket: net.Socket,
  core: Core,
  sockets: Set<net.Socket>,
  log: (message: string) => void,
): void {
  sockets.add(socket);
  const decoder = new LineDecoder();
  let unsubscribe: (() => void) | undefined;
  let queue: string[] = [];
  let head = 0;
  let inFlight = 0;

  const send = (message: unknown, client?: ClientInfo) => {
    if (socket.destroyed || !socket.writable) return;
    if (socket.writableLength > MAX_PENDING_WRITE_BYTES) {
      log(`dropping a client that stopped reading (${describeClient(client)})`);
      socket.destroy();
      return;
    }
    socket.write(encodeLine(message));
  };
  const sendError = (id: RequestId | null, error: unknown) =>
    send({ id, error: toWireError(error) });

  const hello: Hello = {
    hello: {
      protocolVersion: PROTOCOL_VERSION,
      server: { name: "tincan", version: core.version },
      methods: [...core.registry.contracts().map((c) => c.name), ...TRANSPORT_METHODS],
    },
  };
  send(hello);

  socket.on("data", (chunk) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (error) {
      sendError(null, invalid((error as Error).message));
      socket.destroy();
      return;
    }
    for (const line of lines) queue.push(line);
    pump();
  });

  /** Runs queued lines up to `MAX_IN_FLIGHT` at a time, pausing reads while the queue is full. */
  function pump(): void {
    while (inFlight < MAX_IN_FLIGHT && head < queue.length) {
      const line = queue[head++]!;
      inFlight++;
      void handleLine(line).finally(() => {
        inFlight--;
        pump();
      });
    }
    if (head === queue.length) {
      queue = [];
      head = 0;
    }
    if (socket.destroyed) return;
    if (queue.length > 0) socket.pause();
    else if (socket.isPaused()) socket.resume();
  }

  socket.on("close", () => {
    unsubscribe?.();
    sockets.delete(socket);
  });
  socket.on("error", (error) => log(`connection error: ${error.message}`));

  async function handleLine(line: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      sendError(null, invalid("Request is not valid JSON"));
      return;
    }
    const parsed = Request.safeParse(json);
    if (!parsed.success) {
      const id = (json as { id?: unknown })?.id;
      const validId = typeof id === "number" || typeof id === "string" ? id : null;
      sendError(validId, invalid("Request must be {id, method, params?, client: {kind, name}}"));
      return;
    }
    const { id, method, params, client } = parsed.data;

    if (method === "events.subscribe") {
      unsubscribe ??= core.events.subscribe((event: TincanEvent) => {
        // Agents get events through the same policy as their commands.
        const visible = eventForClient(core, client, event);
        if (visible) send(visible, client);
      });
      send({ id, result: { seq: core.events.seq } }, client);
      return;
    }
    if (method === "events.unsubscribe") {
      unsubscribe?.();
      unsubscribe = undefined;
      send({ id, result: null }, client);
      return;
    }

    try {
      const result = await core.run(method, params, client);
      send({ id, result }, client);
    } catch (error) {
      sendError(id, error);
    }
  }
}

/** `kind/name` for logs; the name is client-supplied, so control characters are replaced. */
function describeClient(client: ClientInfo | undefined): string {
  if (!client) return "unidentified";
  const name = client.name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?").slice(0, 64);
  return `${client.kind}/${name}`;
}

function invalid(message: string): TincanError {
  return new TincanError("INVALID_INPUT", message);
}

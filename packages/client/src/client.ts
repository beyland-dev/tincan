import net from "node:net";
import {
  encodeLine,
  LineDecoder,
  TincanError,
  PROTOCOL_VERSION,
  type ClientInfo,
  type ContractName,
  type Hello,
  type InputOf,
  type TincanEvent,
  type OutputOf,
  type WireError,
} from "@beyland/tincan-protocol";
import { runtimePaths } from "@beyland/tincan-protocol/paths";
import { notRunning, verifySocket } from "./socket-check.ts";

export interface ConnectOptions {
  client: ClientInfo;
  /** Defaults to `runtimePaths().socket`. */
  socketPath?: string;
  /** Per-request timeout in ms (default 30 s; 0 disables it). */
  timeoutMs?: number;
  /** Time to wait for the connection and hello (default 5 s). */
  connectTimeoutMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

type EventHandler = (event: TincanEvent) => void;

/** A connection to the Tincan daemon. One instance per socket connection. */
export class TincanClient {
  readonly hello: Hello["hello"];
  readonly socketPath: string;
  readonly #socket: net.Socket;
  readonly #client: ClientInfo;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Set<EventHandler>();
  readonly #closeHandlers = new Set<(error?: Error) => void>();
  #nextId = 1;
  #subscribed = false;
  #closed = false;

  private constructor(
    socket: net.Socket,
    decoder: LineDecoder,
    hello: Hello["hello"],
    options: ConnectOptions & { socketPath: string },
  ) {
    this.#socket = socket;
    this.hello = hello;
    this.socketPath = options.socketPath;
    this.#client = options.client;
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    socket.on("data", (chunk) => {
      try {
        for (const line of decoder.push(chunk)) this.#onLine(line);
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.#onClose());
  }

  static async connect(options: ConnectOptions): Promise<TincanClient> {
    const socketPath = options.socketPath ?? runtimePaths().socket;
    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    const decoder = new LineDecoder();
    // Never talk to a socket another user could have planted (see `verifySocket`).
    await verifySocket(socketPath);

    return new Promise<TincanClient>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new TincanError("TIMEOUT", `No hello from the daemon at ${socketPath}`)),
        connectTimeoutMs,
      );

      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          fail(notRunning(socketPath));
        } else {
          fail(error);
        }
      });

      const onData = (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (error) {
          fail(error as Error);
          return;
        }
        if (lines.length === 0) return;
        socket.off("data", onData);
        clearTimeout(timer);
        const [first, ...rest] = lines;
        let hello: Hello["hello"];
        try {
          hello = (JSON.parse(first!) as Hello).hello;
          if (!hello || typeof hello.protocolVersion !== "number") throw new Error("missing hello");
        } catch {
          fail(new TincanError("PROTOCOL_MISMATCH", "The daemon did not greet with a hello"));
          return;
        }
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          fail(
            new TincanError(
              "PROTOCOL_MISMATCH",
              `Daemon speaks protocol ${hello.protocolVersion}; this client speaks ${PROTOCOL_VERSION}. Restart the daemon after upgrading.`,
            ),
          );
          return;
        }
        socket.removeAllListeners("error");
        const client = new TincanClient(socket, decoder, hello, { ...options, socketPath });
        for (const line of rest) client.#onLine(line);
        resolve(client);
      };
      socket.on("data", onData);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Run a known command with typed input and output. */
  run<N extends ContractName>(name: N, ...input: InputArgs<N>): Promise<OutputOf<N>> {
    return this.call(name, input[0]) as Promise<OutputOf<N>>;
  }

  /** Run any method by name. Rejects with `TincanError`. */
  call(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new TincanError("NOT_CONNECTED", "The connection to the daemon is closed"),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (this.#timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(
            new TincanError("TIMEOUT", `${method} did not answer within ${this.#timeoutMs} ms`),
          );
        }, this.#timeoutMs);
      }
      this.#pending.set(id, pending);
      this.#socket.write(encodeLine({ id, method, params, client: this.#client }));
    });
  }

  /** Receive daemon events. The first handler subscribes this connection. */
  async subscribe(handler: EventHandler): Promise<() => Promise<void>> {
    this.#handlers.add(handler);
    if (!this.#subscribed) {
      this.#subscribed = true;
      try {
        await this.call("events.subscribe");
      } catch (error) {
        this.#subscribed = false;
        this.#handlers.delete(handler);
        throw error;
      }
    }
    return async () => {
      this.#handlers.delete(handler);
      if (this.#handlers.size === 0 && this.#subscribed && !this.#closed) {
        this.#subscribed = false;
        await this.call("events.unsubscribe");
      }
    };
  }

  /** Called once when the connection closes (by either side). */
  onClose(handler: (error?: Error) => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      // A peer that never reads would keep a half-closed socket open forever.
      const force = setTimeout(() => this.#socket.destroy(), 500);
      this.#socket.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      this.#socket.end();
    });
  }

  #onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: WireError; event?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.event === "string") {
      for (const handler of this.#handlers) {
        try {
          handler(message as TincanEvent);
        } catch {
          // Handler errors are the caller's; keep delivering.
        }
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(TincanError.fromWire(message.error));
    else pending.resolve(message.result);
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new TincanError("NOT_CONNECTED", "The daemon closed the connection");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const handler of this.#closeHandlers) handler();
  }
}

/** Commands whose input is entirely optional can be run without an argument. */
type InputArgs<N extends ContractName> =
  undefined extends InputOf<N>
    ? [input?: InputOf<N>]
    : {} extends InputOf<N>
      ? [input?: InputOf<N>]
      : [input: InputOf<N>];

import {
  TincanError,
  type ContractName,
  type Hello,
  type InputOf,
  type TincanEvent,
  type OutputOf,
} from "@beyland/tincan-protocol";
import type { TincanClient } from "./client.ts";

export type ConnectionState =
  | { state: "connecting"; attempt: number; error?: string }
  | { state: "connected"; hello: Hello["hello"] }
  | { state: "closed" };

export interface ReconnectOptions {
  /** Opens a connection: `() => TincanClient.connect(…)` or `() => ensureDaemon(…)`. */
  connect: () => Promise<TincanClient>;
  /** Delay before the first retry (default 250 ms); doubles up to `maxDelayMs`. */
  minDelayMs?: number;
  /** Longest wait between retries (default 5 s). */
  maxDelayMs?: number;
}

type EventHandler = (event: TincanEvent) => void;

/**
 * A daemon connection that comes back by itself. Event handlers survive reconnects; requests made
 * while disconnected fail fast with `NOT_CONNECTED`. Callers refetch what they show when `onState`
 * reports `connected` again, since events sent while disconnected are lost.
 */
export class ReconnectingClient {
  readonly #options: Required<ReconnectOptions>;
  readonly #handlers = new Set<EventHandler>();
  readonly #stateHandlers = new Set<(state: ConnectionState) => void>();
  #client: TincanClient | undefined;
  #attached: TincanClient | undefined;
  #state: ConnectionState = { state: "connecting", attempt: 0 };
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;
  #waiters: Array<() => void> = [];

  constructor(options: ReconnectOptions) {
    this.#options = { minDelayMs: 250, maxDelayMs: 5_000, ...options };
    void this.#open(0);
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Resolves once connected (immediately if already). */
  ready(): Promise<void> {
    if (this.#state.state === "connected") return Promise.resolve();
    if (this.#stopped) return Promise.reject(closedError());
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  run<N extends ContractName>(name: N, ...input: InputArgs<N>): Promise<OutputOf<N>> {
    return this.call(name, input[0]) as Promise<OutputOf<N>>;
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (!this.#client || this.#client.closed) return Promise.reject(closedError());
    return this.#client.call(method, params);
  }

  /** Receive daemon events across reconnects. Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    if (this.#handlers.size === 1 && this.#client) void this.#attach(this.#client);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#setState({ state: "closed" });
    await this.#client?.close();
    this.#client = undefined;
  }

  async #open(attempt: number): Promise<void> {
    if (this.#stopped) return;
    let client: TincanClient;
    try {
      client = await this.#options.connect();
    } catch (error) {
      if (this.#stopped) return;
      const next = attempt + 1;
      this.#setState({ state: "connecting", attempt: next, error: (error as Error).message });
      const delay = Math.min(
        this.#options.minDelayMs * 2 ** Math.min(attempt, 10),
        this.#options.maxDelayMs,
      );
      this.#timer = setTimeout(() => void this.#open(next), delay);
      return;
    }
    if (this.#stopped) {
      await client.close();
      return;
    }
    this.#client = client;
    client.onClose(() => {
      if (this.#client !== client || this.#stopped) return;
      this.#client = undefined;
      this.#setState({ state: "connecting", attempt: 0 });
      void this.#open(0);
    });
    if (this.#handlers.size > 0) await this.#attach(client);
    if (this.#client !== client) return;
    this.#setState({ state: "connected", hello: client.hello });
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #attach(client: TincanClient): Promise<void> {
    if (this.#attached === client) return;
    this.#attached = client;
    try {
      await client.subscribe((event) => {
        for (const handler of this.#handlers) {
          try {
            handler(event);
          } catch {
            // The caller's problem; keep delivering.
          }
        }
      });
    } catch {
      if (this.#attached === client) this.#attached = undefined;
      // The connection dropped mid-subscribe; onClose reconnects.
    }
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    for (const handler of this.#stateHandlers) {
      try {
        handler(state);
      } catch {
        // Ignore.
      }
    }
  }
}

const closedError = () => new TincanError("NOT_CONNECTED", "Not connected to the Tincan daemon");

type InputArgs<N extends ContractName> =
  undefined extends InputOf<N>
    ? [input?: InputOf<N>]
    : {} extends InputOf<N>
      ? [input?: InputOf<N>]
      : [input: InputOf<N>];

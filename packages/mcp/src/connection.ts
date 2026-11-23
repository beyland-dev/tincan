import { TincanClient } from "@beyland/tincan-client";
import type { ClientInfo, TincanEvent } from "@beyland/tincan-protocol";

/** What the MCP server needs from a daemon connection (a `TincanClient` or a test double). */
export interface TincanConnection {
  call(method: string, params?: unknown): Promise<unknown>;
  /** Receive daemon events (used to follow `settings.changed`). */
  subscribe?(handler: (event: TincanEvent) => void): Promise<unknown>;
  /** Called after each (re)connection, so state read from the daemon can be refreshed. */
  onConnect?(listener: () => void): void;
}

export interface DaemonConnectionOptions {
  socketPath?: string;
  client?: ClientInfo;
}

/**
 * A daemon connection that connects on first use and reconnects after the daemon restarts, so an
 * MCP server started before the daemon still works once it's up. Requests have no timeout:
 * `draft.get` may wait up to a minute for a draft's outcome.
 */
export class DaemonConnection implements TincanConnection {
  readonly #options: DaemonConnectionOptions;
  readonly #handlers = new Set<(event: TincanEvent) => void>();
  readonly #connectListeners = new Set<() => void>();
  #client: Promise<TincanClient> | undefined;
  #closed = false;

  constructor(options: DaemonConnectionOptions = {}) {
    this.#options = options;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const client = await this.#connect();
    return client.call(method, params);
  }

  async subscribe(handler: (event: TincanEvent) => void): Promise<void> {
    this.#handlers.add(handler);
    await this.#connect();
  }

  onConnect(listener: () => void): void {
    this.#connectListeners.add(listener);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = await this.#client?.catch(() => undefined);
    this.#client = undefined;
    await client?.close();
  }

  async #connect(): Promise<TincanClient> {
    const current = this.#client;
    if (current) {
      const existing = await current.catch(() => undefined);
      if (existing && !existing.closed) return existing;
      if (this.#client === current) this.#client = undefined;
    }
    if (this.#closed) throw new Error("The daemon connection is closed");
    if (!this.#client) {
      const connecting = this.#open().catch((error: unknown) => {
        if (this.#client === connecting) this.#client = undefined;
        throw error;
      });
      this.#client = connecting;
    }
    return this.#client;
  }

  async #open(): Promise<TincanClient> {
    const client = await TincanClient.connect({
      socketPath: this.#options.socketPath,
      client: this.#options.client ?? { kind: "mcp", name: "tincan-mcp" },
      timeoutMs: 0,
    });
    if (this.#handlers.size) {
      await client.subscribe((event) => {
        for (const handler of this.#handlers) handler(event);
      });
    }
    for (const listener of this.#connectListeners) listener();
    return client;
  }
}

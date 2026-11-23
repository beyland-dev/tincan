import type { device } from "@beyland/tincan-protocol";
import type { Core } from "./core.ts";
import { CONNECTION_LOG_LIMIT } from "./store/store.ts";

export type ConnectionEvent = device.ConnectionEvent;
export type ConnectionEventKind = device.ConnectionEventKind;

/**
 * Records how the phone's connection, its messages access, pairing and the adapter change over time,
 * so `doctor`, `tincan device history` and the desktop's diagnostics can say what happened. Entries
 * hold states, addresses and error codes only, never names. Kept in the store when there is one.
 */
export class ConnectionLog {
  readonly #core: Core;
  #memory: ConnectionEvent[] = [];
  readonly #last = new Map<ConnectionEventKind, string>();

  constructor(core: Core) {
    this.#core = core;
    core.events.subscribe((event) => {
      switch (event.event) {
        case "device.changed":
        case "sync.changed":
          this.#observePhone();
          return;
        case "pairing.changed":
          this.#observePairing();
          return;
        default:
          return;
      }
    });
  }

  /** Adds an entry unless it repeats the last one of its kind. */
  record(
    kind: ConnectionEventKind,
    state: string,
    address: string | null,
    code: string | null = null,
  ): void {
    const key = `${state}|${address ?? ""}|${code ?? ""}`;
    if (this.#last.get(kind) === key) return;
    this.#last.set(kind, key);
    const event: ConnectionEvent = { at: this.#core.now(), kind, state, address, code };
    const store = this.#core.store;
    if (store) {
      store.logConnection(event);
      return;
    }
    this.#memory.push(event);
    if (this.#memory.length > CONNECTION_LOG_LIMIT) this.#memory.shift();
  }

  /** The newest `limit` entries, oldest first. */
  list(limit: number = CONNECTION_LOG_LIMIT): ConnectionEvent[] {
    const store = this.#core.store;
    return store ? store.connectionLog(limit) : this.#memory.slice(-limit);
  }

  #observePhone(): void {
    const { state, device } = this.#core.phone;
    if (!device) {
      // Only worth saying once there was a phone to lose.
      if (this.#last.has("phone")) this.record("phone", "none", null);
      return;
    }
    // A disconnect the user asked for isn't a drop.
    this.record("phone", device.paused ? "paused" : state, device.address);
    const map = device.profiles.map;
    const code =
      map === "ready" ? null : (this.#core.services.sync?.status.lastError?.code ?? null);
    this.record("messages", map, device.address, code);
  }

  #observePairing(): void {
    const status = this.#core.control?.pairing.status();
    if (!status) return;
    this.record("pairing", status.state, status.address, status.error?.code ?? null);
  }
}

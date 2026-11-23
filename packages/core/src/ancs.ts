import type { EventBus } from "./events.ts";
import type {
  AncsNotification,
  AncsOptions,
  AncsSessionEvent,
  AncsSessionHandle,
  AncsSessionState,
  PhonePort,
} from "./phone.ts";

export interface AncsWatcherOptions {
  /** Only `AncsSession` is used. */
  port: Pick<PhonePort, "AncsSession">;
  address: string;
  events: EventBus;
  /** Every new notification, any app's: for desktop notifications. Not ones already on the phone. */
  onNotification?: (notification: AncsNotification) => void;
  /** A notification was cleared on the phone. */
  onRemoved?: (uid: number) => void;
  sessionOptions?: AncsOptions | null;
  onError?: (context: string, error: unknown) => void;
}

/**
 * Subscribes to the phone's notifications over ANCS and hands them on. Emits `notifications.changed`
 * when the subscription's state changes; a `waiting` state carries the hint to turn on Share
 * System Notifications.
 */
export class AncsWatcher {
  readonly address: string;
  readonly #events: EventBus;
  readonly #onNotification: (notification: AncsNotification) => void;
  readonly #onRemoved: (uid: number) => void;
  readonly #onError: (context: string, error: unknown) => void;
  #session: AncsSessionHandle | null = null;
  #state: AncsSessionState = { kind: "waiting", hint: "" };

  private constructor(options: AncsWatcherOptions) {
    this.address = options.address.toUpperCase();
    this.#events = options.events;
    this.#onNotification = options.onNotification ?? (() => {});
    this.#onRemoved = options.onRemoved ?? (() => {});
    this.#onError = options.onError ?? (() => {});
  }

  static async start(options: AncsWatcherOptions): Promise<AncsWatcher> {
    const watcher = new AncsWatcher(options);
    watcher.#session = await options.port.AncsSession.start(
      options.address,
      { content: true, ...options.sessionOptions },
      (event) => watcher.#onEvent(event),
    );
    watcher.#state = watcher.#session.state();
    return watcher;
  }

  get state(): AncsSessionState {
    return this.#state;
  }

  /** The phone's current notifications, newest first. Empty unless the session is ready. */
  async recent(limit?: number): Promise<AncsNotification[]> {
    if (!this.#session || this.#state.kind !== "ready") return [];
    return this.#session.recent(limit ?? null);
  }

  async stop(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    await session?.close();
  }

  #onEvent(event: AncsSessionEvent): void {
    try {
      switch (event.kind) {
        case "state":
          this.#state = event.state;
          this.#events.emit("notifications.changed", { state: event.state.kind });
          return;
        case "notification": {
          const n = event.notification;
          // What was on the phone before the session started is history, not news.
          if (n.preExisting) return;
          this.#onNotification(n);
          return;
        }
        case "removed":
          this.#onRemoved(event.uid);
          return;
      }
    } catch (error) {
      this.#onError("ancs", error);
    }
  }
}

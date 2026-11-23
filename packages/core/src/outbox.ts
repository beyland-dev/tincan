import {
  errorCodeOf,
  TincanError,
  type ErrorCode,
  type Message,
  type SendFailureCode,
} from "@beyland/tincan-protocol";
import { emitDraftChanged, STALE_SEND_MS, syncDraftWithMessage, takeBackDraft } from "./drafts.ts";
import type { EventBus } from "./events.ts";
import { canReply, normalizeThreadKey } from "./keys.ts";
import type { MapLinkHandle, PushOutcome } from "./phone.ts";
import type { Store } from "./store/store.ts";

export interface OutboxOptions {
  store: Store;
  events: EventBus;
  /** The MAP link while the phone is connected (`SyncEngine.mapLink`), else null. */
  link: () => MapLinkHandle | null;
  defaultRegion?: () => string | undefined;
  /** How long a message waits for the phone to connect before it fails (default 5 min). */
  holdMs?: number;
  /**
   * How long Tincan waits for a push to end before marking it `unknown` (default 45 s: the link's
   * 30-second transfer timeout plus a margin). A push that ends later still updates the message.
   */
  watchdogMs?: number;
  /** How often held messages are checked for expiry (default 15 s; 0 = never). */
  sweepIntervalMs?: number;
  now?: () => number;
  onError?: (context: string, error: unknown) => void;
}

const DEFAULT_HOLD_MS = 5 * 60_000;
const DEFAULT_WATCHDOG_MS = 45_000;
const DEFAULT_SWEEP_MS = 15_000;

/** What `send` records about an AI agent's message. */
export interface OutgoingAgent {
  name: string;
  edited: boolean;
  /** `user`: the user sent it from an agent draft. `policy`: the agent sent it directly. */
  via: "user" | "policy";
}

export interface SendOptions {
  /** An AI agent sent it, not the user. */
  byAgent?: boolean;
  agent?: OutgoingAgent;
  /** The send delay: hold it `scheduled` this long before it goes to the phone (default 0). */
  delayMs?: number;
  /** The agent draft it's sent from (it moves to `scheduled`, then follows the message). */
  agentDraftId?: string;
}

/** What `cancel` took back. */
export interface Cancelled {
  threadKey: string;
  body: string;
  agentDraftId: string | null;
}

/** The last error of the user's message whose send timer fired long after its time (a suspend). */
export const PAUSED_ERROR = "PAUSED" satisfies SendFailureCode;
/** The last error of the user's message whose time passed while Tincan wasn't running. */
export const RESTARTED_ERROR = "RESTARTED" satisfies SendFailureCode;

/**
 * Sends messages from Tincan (ADR 0006). A send is stored `pending` with a local outbox entry, then
 * pushed to the phone. iOS sends no sending or delivery reports, so a completed push is `sent`, a
 * failed one `failed` and one that doesn't end in time `unknown`. While the phone is away, messages
 * wait up to `holdMs` and go out, in order, when it connects.
 *
 * With a send delay a message is first `scheduled`, held here until its `sendAt`: it can be
 * cancelled (`cancel`) or sent at once (`sendNow`) until then. Its timer runs outside the serial
 * send queue, so it never holds up a message sent without a delay. A timer that fires more than
 * `STALE_SEND_MS` late (after a suspend) doesn't send: an agent draft the user sent goes back to
 * its queue, an agent's direct send is cancelled and the user's own message fails (retryable).
 */
export class Outbox {
  readonly #store: Store;
  readonly #events: EventBus;
  readonly #link: () => MapLinkHandle | null;
  readonly #defaultRegion: () => string | undefined;
  readonly #holdMs: number;
  readonly #watchdogMs: number;
  readonly #now: () => number;
  readonly #onError: (context: string, error: unknown) => void;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #unsubscribe: () => void;
  #queue: Promise<unknown> = Promise.resolve();
  #sweep: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: OutboxOptions) {
    this.#store = options.store;
    this.#events = options.events;
    this.#link = options.link;
    this.#defaultRegion = options.defaultRegion ?? (() => undefined);
    this.#holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.#watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
    this.#recover();
    this.#unsubscribe = this.#events.subscribe((event) => {
      if (event.event === "sync.changed" && event.data.state === "connected") void this.flush();
    });
    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    if (sweepMs > 0) {
      this.#sweep = setInterval(() => this.expire(), sweepMs);
      this.#sweep.unref?.();
    }
  }

  /**
   * Queues `body` for the one-to-one thread `threadKey` and pushes it if the phone is connected.
   * Resolves with the message once the push ends (or at once, `pending`, while the phone is away).
   * `byAgent` records that an AI agent sent it, not the user.
   */
  async send(threadKey: string, body: string, options: SendOptions = {}): Promise<Message> {
    if (this.#stopped) throw new TincanError("NOT_CONNECTED", "Tincan is shutting down");
    const key = normalizeThreadKey(threadKey, this.#defaultRegion());
    if (key === null || !canReply(key)) {
      throw new TincanError(
        "INVALID_INPUT",
        "Tincan can only send to a phone number or email address",
      );
    }
    if (body.trim() === "") throw new TincanError("INVALID_INPUT", "The message is empty");
    const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 0));
    const sendAt = delayMs > 0 ? this.#now() + delayMs : null;
    const message = this.#store.queueOutgoing({
      threadKey: key,
      body,
      recipients: [recipientFor(key)],
      byAgent: options.byAgent,
      agent: options.agent,
      sendAt,
      agentDraftId: options.agentDraftId,
    });
    const draft = options.agentDraftId ? this.#store.getAgentDraft(options.agentDraftId) : null;
    if (draft) emitDraftChanged(this.#events, draft);
    this.#changed([message.id]);
    if (sendAt !== null) {
      this.#arm(message.id, sendAt);
      return this.#message(message.id);
    }
    await this.#enqueue(() => this.#attempt(message.id));
    return this.#message(message.id);
  }

  /** Sends a `scheduled` message now, skipping what's left of its delay. */
  async sendNow(id: string): Promise<Message> {
    if (this.#stopped) throw new TincanError("NOT_CONNECTED", "Tincan is shutting down");
    const message = this.#store.getMessage(id);
    if (!message || !this.#store.outboxEntry(id)) {
      throw new TincanError("NOT_FOUND", "No such message");
    }
    if (message.status !== "scheduled") {
      throw new TincanError("CONFLICT", `The message is ${message.status}`);
    }
    this.#disarm(id);
    if (this.#store.dispatchScheduled(id)) this.#changed([id]);
    await this.#enqueue(() => this.#attempt(id));
    return this.#message(id);
  }

  /**
   * Takes back a message that hasn't reached the phone: still `scheduled`, or waiting for the
   * phone with no push running. It's deleted, as if never sent. `CONFLICT` once it's sending.
   * What becomes of an agent draft it was sent from is the caller's to decide.
   */
  cancel(id: string): Cancelled {
    if (this.#inFlight.has(id)) throw new TincanError("CONFLICT", "Already sending");
    const result = this.#store.cancelOutgoing(id);
    if (result === null) throw new TincanError("NOT_FOUND", "No such message");
    if (result === "busy") throw new TincanError("CONFLICT", "Already sending");
    this.#disarm(id);
    this.#removed(result.threadKey, id);
    return result;
  }

  /** Stops the send timers of a conversation's scheduled messages (it was deleted). */
  dropThread(threadKey: string): void {
    for (const id of this.#store.scheduledInThread(threadKey)) this.#disarm(id);
  }

  /** Sends a `failed` or `unknown` message again. */
  async retry(id: string): Promise<Message> {
    if (this.#stopped) throw new TincanError("NOT_CONNECTED", "Tincan is shutting down");
    const message = this.#store.getMessage(id);
    if (!message) throw new TincanError("NOT_FOUND", "No such message");
    if (message.status !== "failed" && message.status !== "unknown") {
      throw new TincanError("CONFLICT", `The message is ${message.status}`);
    }
    if (!this.#store.outboxEntry(id)) throw new TincanError("NOT_FOUND", "No such message");
    if (this.#inFlight.has(id)) throw new TincanError("CONFLICT", "The message is still sending");
    this.#store.requeueOutgoing(id);
    this.#changed([id]);
    await this.#enqueue(() => this.#attempt(id));
    return this.#message(id);
  }

  /** Pushes every waiting message, oldest first. Called when the phone connects. */
  flush(): Promise<void> {
    return this.#enqueue(async () => {
      this.expire();
      for (const entry of this.#store.outboxEntries("pending")) {
        if (!this.#link()) return;
        await this.#attempt(entry.messageId);
      }
    });
  }

  /** Fails messages that have waited longer than `holdMs` for the phone. Returns how many. */
  expire(): number {
    const cutoff = this.#now() - this.#holdMs;
    const expired: string[] = [];
    for (const entry of this.#store.outboxEntries("pending")) {
      if (this.#inFlight.has(entry.messageId) || entry.updatedAt > cutoff) continue;
      this.#store.finishSendAttempt(entry.messageId, "failed", "NOT_CONNECTED");
      expired.push(entry.messageId);
    }
    this.#changed(expired);
    return expired.length;
  }

  /** Resolves when queued sends have run (pushes still past their watchdog may be running). */
  async idle(): Promise<void> {
    for (;;) {
      const queue = this.#queue;
      await queue;
      if (queue === this.#queue) return;
    }
  }

  stop(): void {
    this.#stopped = true;
    // Scheduled messages stay scheduled: the next outbox picks them up (see `#recover`).
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#unsubscribe();
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
  }

  // --- Sending -------------------------------------------------------------

  async #attempt(id: string): Promise<void> {
    if (this.#stopped || this.#inFlight.has(id)) return;
    const message = this.#store.getMessage(id);
    const entry = this.#store.outboxEntry(id);
    if (!message || !entry || message.status !== "pending") return;
    const link = this.#link();
    if (!link) return;

    this.#store.beginSendAttempt(id);
    const push = this.#push(link, id, entry.recipients, message.body);
    this.#inFlight.set(id, push);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<"watchdog">((resolve) => {
      timer = setTimeout(() => resolve("watchdog"), this.#watchdogMs);
      timer.unref?.();
    });
    const first = await Promise.race([push.then(() => "done" as const), watchdog]);
    clearTimeout(timer);
    if (first === "watchdog" && this.#store.getMessage(id)?.status === "pending") {
      this.#store.finishSendAttempt(id, "unknown", "TIMEOUT");
      this.#changed([id]);
    }
  }

  async #push(link: MapLinkHandle, id: string, recipients: string[], body: string): Promise<void> {
    let status: "sent" | "failed" | "unknown";
    let error: ErrorCode | null = null;
    try {
      status = outcomeStatus(await link.pushMessage(recipients, body));
    } catch (failure) {
      error = errorCodeOf(failure);
      // A transfer that neither completed nor failed in time may still have gone out.
      status = error === "TIMEOUT" ? "unknown" : "failed";
      this.#onError("push", failure);
    }
    try {
      const current = this.#store.getMessage(id);
      // The watchdog may have marked it unknown; a late answer still settles it.
      if (current && (current.status === "pending" || current.status === "unknown")) {
        this.#store.finishSendAttempt(id, status, error);
        this.#changed([id]);
      }
    } catch (failure) {
      this.#onError("outbox", failure);
    } finally {
      this.#inFlight.delete(id);
    }
  }

  // --- Send delays ---------------------------------------------------------

  #arm(id: string, sendAt: number): void {
    this.#disarm(id);
    const timer = setTimeout(() => this.#fire(id), Math.max(0, sendAt - this.#now()));
    timer.unref?.();
    this.#timers.set(id, timer);
  }

  #disarm(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
  }

  /** A send timer fired (or a restart found it due): dispatch it, unless it's stale. */
  #fire(id: string, restarted = false): void {
    this.#timers.delete(id);
    if (this.#stopped) return;
    try {
      const message = this.#store.getMessage(id);
      const entry = this.#store.outboxEntry(id);
      if (!message || !entry || message.status !== "scheduled") return;
      const sendAt = entry.sendAt ?? this.#now();
      if (this.#now() - sendAt > STALE_SEND_MS) {
        this.#stale(id, message, restarted);
        return;
      }
      if (!this.#store.dispatchScheduled(id)) return;
      this.#changed([id]);
      void this.#enqueue(() => this.#attempt(id)).catch(() => {});
    } catch (error) {
      this.#onError("outbox", error);
    }
  }

  /**
   * The time to send passed long ago (the computer slept through it): an agent draft the user
   * sent goes back to its queue, an agent's direct send is cancelled, and the user's own message
   * fails so they can retry it, with why: `RESTARTED` when Tincan wasn't running at the time,
   * else `PAUSED`.
   */
  #stale(id: string, message: Message, restarted: boolean): void {
    if (!message.agent) {
      this.#store.finishSendAttempt(id, "failed", restarted ? RESTARTED_ERROR : PAUSED_ERROR);
      this.#changed([id]);
      return;
    }
    const result = this.#store.cancelOutgoing(id);
    if (result === null || result === "busy") return;
    this.#removed(result.threadKey, id);
    if (result.agentDraftId) {
      takeBackDraft(this.#store, this.#events, result.agentDraftId, message.agent.via === "user");
    }
  }

  // --- Plumbing ------------------------------------------------------------

  /**
   * After a crash mid-push the phone may have taken the message: it becomes `unknown`. Scheduled
   * messages get their timers back; ones already due go now, or count as stale (see `#stale`).
   */
  #recover(): void {
    const interrupted = this.#store
      .outboxEntries("pending")
      .filter((entry) => entry.pushingSince !== null)
      .map((entry) => entry.messageId);
    for (const id of interrupted) this.#store.finishSendAttempt(id, "unknown");
    this.#changed(interrupted);
    for (const entry of this.#store.outboxEntries("scheduled")) {
      const sendAt = entry.sendAt ?? this.#now();
      if (sendAt > this.#now()) this.#arm(entry.messageId, sendAt);
      else this.#fire(entry.messageId, true);
    }
  }

  /** Announces a message that was taken back (and deleted). */
  #removed(threadKey: string, id: string): void {
    this.#events.emit("message.changed", { threadKey, ids: [id] });
    this.#events.emit("thread.changed", { keys: [threadKey] });
  }

  #message(id: string): Message {
    const message = this.#store.getMessage(id);
    if (!message) throw new TincanError("NOT_FOUND", "The message was deleted");
    return message;
  }

  #changed(ids: string[]): void {
    const byThread = new Map<string, string[]>();
    for (const id of ids) {
      const message = this.#store.getMessage(id);
      if (!message) continue;
      this.#events.emit("message.sendStatus", { id, status: message.status });
      byThread.set(message.threadKey, [...(byThread.get(message.threadKey) ?? []), id]);
      syncDraftWithMessage(this.#store, this.#events, id);
    }
    for (const [threadKey, messageIds] of byThread) {
      this.#events.emit("message.changed", { threadKey, ids: messageIds });
    }
    if (byThread.size > 0) this.#events.emit("thread.changed", { keys: [...byThread.keys()] });
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task);
    this.#queue = run.catch((error: unknown) => this.#onError("outbox", error));
    return run;
  }
}

/** The address the phone takes for a one-to-one thread key. */
export function recipientFor(key: string): string {
  if (key.startsWith("tel:")) return key.slice("tel:".length);
  if (key.startsWith("email:")) return key.slice("email:".length);
  throw new TincanError("INVALID_INPUT", "Tincan can only send to a phone number or email address");
}

function outcomeStatus(outcome: PushOutcome): "sent" | "unknown" {
  return outcome === "accepted" ? "sent" : "unknown";
}

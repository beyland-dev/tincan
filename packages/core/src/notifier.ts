import {
  findVerificationCode,
  type Message,
  type Settings,
  type Thread,
} from "@beyland/tincan-protocol";
import type { EventBus } from "./events.ts";
import { NotificationIcons } from "./notification-icons.ts";
import type { DesktopNotification, NotifierEvent, NotifierHandle, PhonePort } from "./phone.ts";
import type { Store } from "./store/store.ts";

/** How long arrivals wait before showing, so a burst of messages shows as one notification. */
const DEFAULT_DELAY_MS = 1_500;

/** The button on a notification whose message carries a one-time code. */
export const COPY_CODE_ACTION = "copy-code";

/** The button on an agent's direct send, during its delay, that cancels it. */
export const CANCEL_SEND_ACTION = "cancel-send";

/** Notification keys for a conversation's queued agent drafts and for an agent's send in its delay. */
const DRAFT_PREFIX = "draft:";
const SENDING_PREFIX = "sending:";

/** The desktop app's `.desktop` id, so servers show its icon and group its notifications. */
const DESKTOP_ENTRY = "tincan-desktop";

export interface DesktopNotifierOptions {
  store: Store;
  events: EventBus;
  /** Only `Notifier` is used. */
  port: Pick<PhonePort, "Notifier">;
  /** The current settings, read at each use. */
  settings: () => Settings;
  /**
   * Tincan's private runtime folder in RAM (`runtimeIconDir()`), where contact photos are written
   * briefly as notification icons. Null: notifications show no photos.
   */
  iconDir?: string | null;
  /** How long an icon file stays at most (default 5 min). */
  iconLifetimeMs?: number;
  delayMs?: number;
  /** A message notification was clicked. */
  onActivate?: (threadKey: string, activationToken: string | undefined) => void;
  /** The Cancel button on an agent's send during its delay was pressed. */
  onCancelSend?: (messageId: string) => Promise<void> | void;
  /**
   * Puts a one-time code on the clipboard. With it, notifications for messages that carry one get
   * a Copy code button.
   */
  onCopyCode?: (code: string) => Promise<void> | void;
  /** Failures it recovered from. `context` names the step; never message content. */
  onError?: (context: string, error: unknown) => void;
}

/**
 * Shows desktop notifications: one per conversation for messages that arrive live (see
 * `Store.pendingNotifications`), replaced as more arrive and withdrawn once the thread is read.
 * The phone's notifications from other apps are deliberately not mirrored.
 */
export class DesktopNotifier {
  readonly #store: Store;
  readonly #settings: () => Settings;
  readonly #icons: NotificationIcons;
  /** The icon URI of each shown notification, by key. */
  readonly #iconOf = new Map<string, string>();
  readonly #delayMs: number;
  readonly #onActivate: (threadKey: string, activationToken: string | undefined) => void;
  readonly #onCopyCode: ((code: string) => Promise<void> | void) | null;
  readonly #onCancelSend: ((messageId: string) => Promise<void> | void) | null;
  /** Conversations with newly queued agent drafts, waiting to be announced. */
  readonly #draftKeys = new Set<string>();
  #draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** The conversation of each agent send shown in its delay, by message id. */
  readonly #sending = new Map<string, string>();
  readonly #onError: (context: string, error: unknown) => void;
  readonly #unsubscribe: () => void;
  #handle: NotifierHandle | null = null;
  /** Shown notification ids by thread key. */
  readonly #shown = new Map<string, number>();
  /** The one-time code each shown notification's Copy code button copies, by thread key. */
  readonly #codes = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  private constructor(options: DesktopNotifierOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#onError = options.onError ?? (() => {});
    this.#icons = NotificationIcons.open(options.iconDir ?? null, {
      lifetimeMs: options.iconLifetimeMs,
      onError: this.#onError,
    });
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.#onActivate = options.onActivate ?? (() => {});
    this.#onCopyCode = options.onCopyCode ?? null;
    this.#onCancelSend = options.onCancelSend ?? null;
    this.#unsubscribe = options.events.subscribe((event) => {
      if (event.event === "message.changed") this.#schedule();
      else if (event.event === "thread.changed")
        void this.#enqueue(() => this.#withdraw(event.data.keys));
      else if (event.event === "draft.changed") this.#onDraft(event.data.id, event.data.state);
      else if (event.event === "message.sendStatus" && event.data.status !== "scheduled")
        void this.#enqueue(() => this.#sent(event.data.id));
    });
  }

  /** Connects to the notification server and shows what is already waiting. */
  static async start(options: DesktopNotifierOptions): Promise<DesktopNotifier> {
    const notifier = new DesktopNotifier(options);
    try {
      notifier.#handle = await options.port.Notifier.open((event) => notifier.#onEvent(event), {
        appName: "Tincan",
        desktopEntry: DESKTOP_ENTRY,
      });
    } catch (error) {
      notifier.#unsubscribe();
      notifier.#icons.clear();
      throw error;
    }
    notifier.#schedule();
    return notifier;
  }

  /** Shows waiting message notifications now. */
  flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#enqueue(() => this.#showPending());
  }

  /** Waits for queued work. */
  async idle(): Promise<void> {
    let queue: Promise<void>;
    do {
      queue = this.#queue;
      await queue;
    } while (queue !== this.#queue);
  }

  /** Stops listening. Notifications already shown stay, without their photos. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#draftTimer = null;
    await this.idle();
    this.#handle?.close();
    this.#handle = null;
    this.#iconOf.clear();
    this.#icons.clear();
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#enqueue(() => this.#showPending());
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped && !this.#handle) return;
      try {
        await work();
      } catch (error) {
        this.#onError("notify", error);
      }
    });
    this.#queue = run;
    return run;
  }

  async #showPending(): Promise<void> {
    const store = this.#store;
    const byThread = new Map<string, Message[]>();
    for (const message of store.pendingNotifications()) {
      store.markNotified(message.id);
      if (message.direction !== "incoming" || message.read) continue;
      const list = byThread.get(message.threadKey) ?? [];
      list.push(message);
      byThread.set(message.threadKey, list);
    }
    for (const [key, messages] of byThread) {
      const thread = store.getThread(key);
      if (!thread || thread.muted || thread.unread === 0) continue;
      const latest = messages.at(-1)!;
      const shown = this.#messageNotification(thread, latest);
      const code = this.#codeIn(latest);
      if (code) this.#codes.set(key, code);
      else this.#codes.delete(key);
      await this.#show(key, {
        ...shown,
        ...(code ? { actions: [{ id: COPY_CODE_ACTION, label: "Copy code" }] } : {}),
      });
    }
  }

  /** Shows waiting agent-draft notifications now (normally they wait `delayMs`). */
  flushDrafts(): Promise<void> {
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#draftTimer = null;
    return this.#enqueue(() => this.#showDrafts());
  }

  #onDraft(id: string, state: string): void {
    const draft = this.#store.getAgentDraft(id);
    if (!draft) return;
    if (state === "queued") {
      // One notification per conversation, for a burst of drafts.
      this.#draftKeys.add(draft.to);
      if (this.#stopped || this.#draftTimer) return;
      this.#draftTimer = setTimeout(() => {
        this.#draftTimer = null;
        void this.#enqueue(() => this.#showDrafts());
      }, this.#delayMs);
      this.#draftTimer.unref?.();
      return;
    }
    void this.#enqueue(async () => {
      if (this.#store.countQueuedAgentDrafts({ to: draft.to }) === 0) {
        await this.#dismiss(`${DRAFT_PREFIX}${draft.to}`);
      }
      const message = draft.messageId ? this.#store.getMessage(draft.messageId) : null;
      if (
        state === "scheduled" &&
        message?.status === "scheduled" &&
        message.agent?.via === "policy"
      ) {
        await this.#showSending(draft.agentName, message.id, message.threadKey, message.sendAt);
      } else if (state !== "scheduled") {
        for (const [messageId, key] of this.#sending) {
          if (key === draft.to && (!draft.messageId || draft.messageId === messageId)) {
            await this.#sent(messageId);
          }
        }
      }
    });
  }

  /** Announces conversations with newly queued agent drafts, replacing older notices. */
  async #showDrafts(): Promise<void> {
    const keys = [...this.#draftKeys];
    this.#draftKeys.clear();
    const preview = this.#settings().notifications.preview;
    for (const key of keys) {
      const queued = this.#store.listAgentDrafts({ states: ["queued"], to: key, limit: 500 });
      if (queued.length === 0) continue;
      const latest = queued.at(-1)!;
      const agents = new Set(queued.map((d) => d.agentName));
      const who = agents.size === 1 ? latest.agentName : "AI agents";
      const what = queued.length === 1 ? "drafted a message" : `drafted ${queued.length} messages`;
      const title = `${who} ${what}`;
      const shown =
        preview === "hidden"
          ? { title: "Tincan", body: "An AI agent drafted a message" }
          : preview === "sender"
            ? { title, body: `For ${this.#recipient(key)}. Open Tincan to review` }
            : { title, body: `To ${this.#recipient(key)}: ${latest.text ?? latest.body}` };
      await this.#show(`${DRAFT_PREFIX}${key}`, shown);
    }
  }

  /** An agent's direct send is waiting out its delay: say so, with a way to cancel it. */
  async #showSending(
    agentName: string,
    messageId: string,
    threadKey: string,
    sendAt: number | undefined,
  ): Promise<void> {
    const preview = this.#settings().notifications.preview;
    const seconds =
      sendAt === undefined ? 0 : Math.max(1, Math.round((sendAt - Date.now()) / 1000));
    const when = seconds > 0 ? ` in ${seconds} s` : "";
    const shown =
      preview === "hidden"
        ? { title: "Tincan", body: `An AI agent is sending a message${when}` }
        : { title: `${agentName} is sending to ${this.#recipient(threadKey)}${when}`, body: "" };
    if (preview === "full") {
      const text = this.#store.getMessage(messageId)?.body;
      if (text) shown.body = text;
    }
    this.#sending.set(messageId, threadKey);
    await this.#show(`${SENDING_PREFIX}${messageId}`, {
      ...shown,
      ...(this.#onCancelSend ? { actions: [{ id: CANCEL_SEND_ACTION, label: "Cancel" }] } : {}),
    });
  }

  /** The send went (or was cancelled): its notice goes. */
  async #sent(messageId: string): Promise<void> {
    if (!this.#sending.has(messageId)) return;
    this.#sending.delete(messageId);
    await this.#dismiss(`${SENDING_PREFIX}${messageId}`);
  }

  #recipient(key: string): string {
    return this.#store.contactForHandle(key)?.name ?? key.replace(/^(tel|email|sender):/, "");
  }

  /** The code a Copy code button would copy; never offered when previews are hidden. */
  #codeIn(message: Message): string | null {
    if (!this.#onCopyCode || this.#settings().notifications.preview === "hidden") return null;
    return findVerificationCode(message.body);
  }

  #messageNotification(thread: Thread, latest: Message): Omit<DesktopNotification, "threadKey"> {
    const preview = this.#settings().notifications.preview;
    const more = thread.unread > 1 ? `${thread.unread} new messages` : "New message";
    if (preview === "hidden") return { title: "Tincan", body: more };
    const icon = this.#icon(thread);
    if (preview === "sender") return { title: thread.title, body: more, ...icon };
    const text = placeholderText(latest.body) ?? (latest.body || describeAttachment(latest));
    const body =
      thread.kind === "group" && latest.sender ? `${this.#name(latest.sender)}: ${text}` : text;
    return { title: thread.title, body, ...icon };
  }

  #name(handle: string): string {
    return this.#store.contactForHandle(handle)?.name ?? handle.replace(/^(tel|email|sender):/, "");
  }

  /** The contact's photo, written to a short-lived file in RAM (see `NotificationIcons`). */
  #icon(thread: Thread): { icon?: string } {
    if (!this.#handle || thread.kind !== "direct" || thread.members.length !== 1) return {};
    const contact = this.#store.contactForHandle(thread.members[0]!);
    const photo = contact && this.#store.getContactPhoto(contact.id);
    const icon = photo && this.#icons.write(photo);
    return icon ? { icon } : {};
  }

  async #show(key: string, shown: Omit<DesktopNotification, "threadKey">): Promise<void> {
    const handle = this.#handle;
    if (!handle) {
      if (shown.icon) this.#icons.release(shown.icon);
      return;
    }
    const replaces = this.#shown.get(key);
    let id: number;
    try {
      id = await handle.notify({
        ...shown,
        threadKey: key,
        ...(replaces === undefined ? {} : { replaces }),
      });
    } catch (error) {
      if (shown.icon) this.#icons.release(shown.icon);
      throw error;
    }
    this.#shown.set(key, id);
    // The notification it replaced no longer needs its icon.
    this.#releaseIcon(key);
    if (shown.icon) this.#iconOf.set(key, shown.icon);
  }

  #releaseIcon(key: string): void {
    const icon = this.#iconOf.get(key);
    if (icon === undefined) return;
    this.#iconOf.delete(key);
    this.#icons.release(icon);
  }

  async #dismiss(key: string): Promise<void> {
    const id = this.#shown.get(key);
    if (id === undefined) return;
    this.#shown.delete(key);
    this.#codes.delete(key);
    this.#releaseIcon(key);
    await this.#handle?.dismiss(id);
  }

  /** Withdraws notifications for threads that were read, muted or deleted. */
  async #withdraw(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      if (!this.#shown.has(key)) continue;
      const thread = this.#store.getThread(key);
      if (!thread || thread.muted || thread.unread === 0) await this.#dismiss(key);
    }
  }

  #onEvent(event: NotifierEvent): void {
    if (this.#shown.get(event.threadKey) === event.id && event.kind === "closed") {
      // The code stays: a server may report the close before the button click that caused it.
      this.#shown.delete(event.threadKey);
      this.#releaseIcon(event.threadKey);
    }
    const sending = event.threadKey.startsWith(SENDING_PREFIX)
      ? event.threadKey.slice(SENDING_PREFIX.length)
      : null;
    if (event.kind === "action" && event.action === CANCEL_SEND_ACTION && sending) {
      if (this.#onCancelSend) {
        void Promise.resolve()
          .then(() => this.#onCancelSend!(sending))
          .catch((error: unknown) => this.#onError("cancel-send", error));
      }
    } else if (event.kind === "action" && event.action === COPY_CODE_ACTION) {
      const code = this.#codes.get(event.threadKey);
      if (code && this.#onCopyCode) {
        void Promise.resolve()
          .then(() => this.#onCopyCode!(code))
          .catch((error: unknown) => this.#onError("copy-code", error));
      }
    } else if (event.kind === "action") {
      // Draft and sending notices open their conversation (or the new recipient's).
      const key = event.threadKey.startsWith(DRAFT_PREFIX)
        ? event.threadKey.slice(DRAFT_PREFIX.length)
        : sending !== null
          ? (this.#sending.get(sending) ?? this.#store.getMessage(sending)?.threadKey)
          : event.threadKey;
      if (key === undefined) return;
      try {
        this.#onActivate(key, event.activationToken);
      } catch (error) {
        this.#onError("activate", error);
      }
    }
  }
}

/**
 * iMessage stands in U+FFFC for an attachment and U+FFFD for an app item (a shared location, a
 * payment, a game) in the text MAP gives Tincan. A body that is only those says what it was.
 */
export function placeholderText(body: string): string | null {
  if (!/^[\uFFFC\uFFFD\s]+$/.test(body)) return null;
  const attachments = [...body].filter((c) => c === "\uFFFC").length;
  if (attachments > 0) return attachments > 1 ? `${attachments} attachments` : "1 attachment";
  return "Shared a location or Messages app item";
}

function describeAttachment(message: Message): string {
  const hint = message.attachmentHint;
  if (!hint) return "";
  const kind = hint.kinds?.length === 1 ? hint.kinds[0]! : "attachment";
  const noun = kind === "file" ? "attachment" : kind;
  const count = hint.count ?? 1;
  return count > 1 ? `${count} ${noun}s` : `1 ${noun}`;
}

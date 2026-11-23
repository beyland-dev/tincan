import { createHmac, randomBytes } from "node:crypto";
import {
  findVerificationCode,
  TincanError,
  type Contact,
  type ContactDetails,
  type Group,
  type LabeledValue,
  type Message,
  type Thread,
} from "@beyland/tincan-protocol";
import { handleFor, isShortCode } from "./keys.ts";
import type { Store } from "./store/store.ts";

const SECRET_KEY = "agent.handleSecret";
const TOKENS_INDEXED_KEY = "agent.tokensIndexed";
export const CODE_REDACTED = "[Verification code hidden from AI agents]";
export const DEFAULT_AGENT_SEND_LIMIT = 10;
export const DEFAULT_AGENT_SEND_WINDOW_MS = 10 * 60_000;

/** Formats epoch milliseconds as an ISO-8601 string in the local timezone (`YYYY-MM-DDTHH:mm:ss±HH:MM`). */
export function formatLocalIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`
  );
}

/** True when a thread belongs to a short code or alphanumeric sender (OTP/automated traffic). */
export function isShortCodeThread(key: string): boolean {
  return isShortCode(key);
}

/**
 * Words that mark a text as carrying a one-time secret. Broader than the desktop's copy-code
 * heuristic: over-redacting a text for an agent is cheap, leaking a sign-in code is not.
 */
const CODE_WORDS =
  /code|passcode|password|passkey|otp\b|one[- ]time|verif|confirm|token|2fa|mfa\b|two[- ]factor|two[- ]step|authenticat|\bpin\b|log ?in|sign[- ]?in|magic[- ]?link|reset|código|codice/iu;
const NOT_CODES =
  /\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|gift|referral|dress|source|error|status|tracking) codes?\b/giu;
/** Links, with a scheme, `www.` or a bare domain (ending in a letter TLD) followed by a path. */
const URLS =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,7}\.[a-z][a-z0-9-]{1,23}\/\S*/giu;
// Catches 3-10 digit numeric codes and 5-10 char alphanumeric OTPs (must contain both letters and digits).
const EXTENDED_NUMERIC_OTP =
  /(?<![\p{L}\p{N}$€£¥₹.,/@+:]|\d[ -])\d{3,10}(?![\p{L}\p{N}%°]|[.,:/]\d|[ -]\d)/u;
const EXTENDED_ALNUM_OTP =
  /(?<![\p{L}\p{N}./@+:-])(?:[A-Z0-9]{1,4}-)?(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*[0-9])[A-Z0-9-]{5,10}(?![\p{L}\p{N}./@+:-])/u;
/** Digits written in groups ("48 29 13", "4-8-2-9-1-3"). Separators keep it linear. */
const SPACED_DIGITS =
  /(?<![\p{L}\p{N}$€£¥₹.,/@+:-])\d{1,4}(?:[ -]\d{1,4}){1,7}(?![\p{L}\p{N}%°]|[.,:/]\d)/gu;
const LINK_REDACTED = "[Link hidden from AI agents]";

/** NFKC folds full-width and other compatibility digits; other scripts' digits become ASCII. */
function normalizeDigits(text: string): string {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => {
    const cp = digit.codePointAt(0)!;
    if (cp < 0x80) return digit;
    // Unicode decimal digits come in runs of whole decades, 0 to 9.
    let start = cp;
    while (cp - start < 100 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

/** True when `body` looks like it carries a one-time verification code (numeric or alphanumeric). */
export function isVerificationCodeMessage(body: string): boolean {
  if (!body) return false;
  const text = normalizeDigits(body);
  if (findVerificationCode(text) !== null) return true;
  const blank = (match: string) => " ".repeat(match.length);
  const cleaned = text.replace(URLS, blank).replace(NOT_CODES, blank);
  if (!CODE_WORDS.test(cleaned)) return false;
  if (EXTENDED_NUMERIC_OTP.test(cleaned) || EXTENDED_ALNUM_OTP.test(cleaned)) return true;
  for (const match of cleaned.matchAll(SPACED_DIGITS)) {
    const digits = match[0].replace(/[ -]/g, "").length;
    if (digits >= 4 && digits <= 10) return true;
  }
  return false;
}

/**
 * Text as an agent may see it with `agents.hideCodes`: a text carrying a one-time code is hidden
 * entirely, and links in texts that talk about signing in, codes, confirming or resetting (magic
 * sign-in and password-reset links) are hidden. Anything else is returned as is.
 */
export function redactForAgents(text: string): string {
  if (!text) return text;
  if (isVerificationCodeMessage(text)) return CODE_REDACTED;
  const normalized = normalizeDigits(text);
  if (!CODE_WORDS.test(normalized)) return text;
  const redacted = normalized.replace(URLS, LINK_REDACTED);
  return redacted === normalized ? text : redacted;
}

/** True when an agent must not see `text` as is (it carries a code or a sign-in link). */
export function hasAgentSecret(text: string): boolean {
  return redactForAgents(text) !== text;
}

/** Redacts a message body and any tapback quotes when they carry a verification code or link. */
export function redactCodeMessage(message: Message): Message {
  const body = redactForAgents(message.body);
  const bodyHasCode = body !== message.body;
  let reactionsChanged = false;
  const reactions = message.reactions.map((r) => {
    const text = bodyHasCode ? CODE_REDACTED : redactForAgents(r.text);
    if (text === r.text) return r;
    reactionsChanged = true;
    return { ...r, text };
  });
  if (!bodyHasCode && !reactionsChanged) return message;
  return { ...message, body, reactions };
}

/** Emails and phone numbers written inside free text (a name, a note, an address). */
const EMBEDDED_EMAIL = /[^\s@<>()[\]{}"',;:]{1,64}@[^\s@<>()[\]{}"',;:]{1,253}\.[\p{L}]{2,24}/gu;
const EMBEDDED_PHONE = /\+?\(?\d[\d\s().-]{4,30}\d/gu;
const HIDDEN_ADDRESS = "[hidden]";

/**
 * Stable, opaque per-store mapping from real `tel:` / `email:` handles to `handle:<token>` IDs
 * so AI agents can reference contacts and conversations without seeing real phone numbers or emails.
 * Every token handed out is remembered in the store, so resolving one is a lookup, not a scan.
 */
export class HandleMasker {
  readonly #secret: Buffer;
  readonly #store: Store | null;
  readonly #handleToToken = new Map<string, string>();
  readonly #tokenToHandle = new Map<string, string>();
  readonly #msgIdToToken = new Map<string, string>();
  readonly #tokenToMsgId = new Map<string, string>();

  constructor(store: Store | null) {
    this.#store = store;
    const saved = store?.getSetting(SECRET_KEY);
    if (typeof saved === "string" && /^[0-9a-f]{64}$/i.test(saved)) {
      this.#secret = Buffer.from(saved, "hex");
    } else {
      this.#secret = randomBytes(32);
      store?.setSetting(SECRET_KEY, this.#secret.toString("hex"));
    }
  }

  #digest(value: string): string {
    return createHmac("sha256", this.#secret)
      .update(value)
      .digest()
      .subarray(0, 12)
      .toString("base64url");
  }

  #remember(token: string, value: string, kind: "handle" | "message"): void {
    if (kind === "handle") {
      this.#handleToToken.set(value, token);
      this.#tokenToHandle.set(token, value);
    } else {
      this.#msgIdToToken.set(value, token);
      this.#tokenToMsgId.set(token, value);
    }
    this.#store?.saveAgentToken(token, value);
  }

  /**
   * Masks `tel:`, `email:` and `group:members:` keys behind stable keyed-HMAC tokens; leaves
   * `group:name:`, `sender:` and already-masked tokens alone.
   */
  mask(handle: string): string {
    if (handle.startsWith("handle:")) return handle;
    const group = handle.startsWith("group:members:");
    if (group && this.#tokenToHandle.has(handle)) return handle;
    if (!group && !handle.startsWith("tel:") && !handle.startsWith("email:")) return handle;
    const cached = this.#handleToToken.get(handle);
    if (cached) return cached;
    const token = `${group ? "group:members:" : "handle:"}${this.#digest(handle)}`;
    this.#remember(token, handle, "handle");
    return token;
  }

  /** Masks a message ID with the store's HMAC key so unkeyed phone-message hashes can't be probed offline. */
  maskMessageId(id: string): string {
    if (id.startsWith("msg:")) return id;
    const cached = this.#msgIdToToken.get(id);
    if (cached) return cached;
    const token = `msg:${this.#digest(`msg:${id}`)}`;
    this.#remember(token, id, "message");
    return token;
  }

  /** Resolves a `msg:<token>` back to its stored message ID. */
  unmaskMessageId(token: string, store: Store | null = this.#store): string | null {
    if (!token.startsWith("msg:")) return null;
    const cached = this.#tokenToMsgId.get(token);
    if (cached) return cached;
    const value = store?.agentTokenValue(token) ?? null;
    if (value === null || this.maskMessageId(value) !== token) return null;
    return value;
  }

  /** Masks a display label (`name`, `title`, participant) if it is or contains a phone number or email. */
  maskDisplay(value: string, region?: string, fallbackHandle?: string): string {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (trimmed.startsWith("tel:") || trimmed.startsWith("email:")) return this.mask(trimmed);
    const parsed = looksLikeAddress(trimmed) ? handleFor(trimmed, region) : null;
    if (parsed && (parsed.startsWith("tel:") || parsed.startsWith("email:"))) {
      return this.mask(fallbackHandle ?? parsed);
    }
    return this.maskText(value, region);
  }

  /** Replaces phone numbers and email addresses written inside free text with opaque IDs. */
  maskText(value: string, region?: string): string {
    if (!/[0-9@]/.test(value)) return value;
    const replace = (match: string): string => {
      const handle = handleFor(match, region);
      return handle && (handle.startsWith("tel:") || handle.startsWith("email:"))
        ? this.mask(handle)
        : HIDDEN_ADDRESS;
    };
    return value.replace(EMBEDDED_EMAIL, replace).replace(EMBEDDED_PHONE, (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15 ? replace(match) : match;
    });
  }

  /** Resolves a `handle:<token>` or masked `group:members:<token>` back to its real key. */
  unmask(token: string, store: Store | null = this.#store): string | null {
    if (!token.startsWith("handle:") && !token.startsWith("group:members:")) return null;
    const cached = this.#tokenToHandle.get(token);
    if (cached) return cached;
    if (!store) return null;
    const value = store.agentTokenValue(token) ?? this.#indexLegacyHandles(store, token);
    if (value === null || this.mask(value) !== token) return null;
    return value;
  }

  /**
   * Tokens handed out before Tincan remembered them: index every known handle once (persisted), so
   * an agent's older IDs keep working. Later misses are a single lookup.
   */
  #indexLegacyHandles(store: Store, token: string): string | null {
    if (store.getSetting(TOKENS_INDEXED_KEY) === true) return null;
    store.db.transaction(() => {
      for (const handle of allKnownHandles(store)) this.mask(handle);
      store.setSetting(TOKENS_INDEXED_KEY, true);
    });
    return store.agentTokenValue(token);
  }

  maskMessage(message: Message): Message {
    const masked: Message = {
      ...message,
      id: this.maskMessageId(message.id),
      threadKey: this.mask(message.threadKey),
      sender: message.sender ? this.mask(message.sender) : null,
      reactions: message.reactions.map((r) => ({
        ...r,
        from: r.from ? this.mask(r.from) : null,
      })),
    };
    if (message.reactionTo !== undefined)
      masked.reactionTo = this.maskMessageId(message.reactionTo);
    return masked;
  }

  maskThread(thread: Thread, region?: string): Thread {
    const maskedKey = this.mask(thread.key);
    let title = thread.title;
    if (thread.kind === "group") {
      // Unnamed group titles join participant labels with ", "; mask any raw addresses among them.
      title = title
        .split(/,\s+/)
        .map((part) => this.maskDisplay(part, region))
        .join(", ");
    } else if (thread.key.startsWith("tel:") || thread.key.startsWith("email:")) {
      const rawAddress = thread.key.replace(/^(tel|email):/, "");
      const parsed = looksLikeAddress(title) ? handleFor(title, region) : null;
      if (
        title === rawAddress ||
        title === thread.key ||
        parsed === thread.key ||
        (parsed !== null && (parsed.startsWith("tel:") || parsed.startsWith("email:")))
      ) {
        title = maskedKey;
      } else {
        title = this.maskText(title, region);
      }
    } else {
      title = this.maskText(title, region);
    }
    return {
      ...thread,
      key: maskedKey,
      title,
      members: thread.members.map((m) => this.mask(m)),
      lastMessage: thread.lastMessage ? this.maskMessage(thread.lastMessage) : null,
    };
  }

  maskContact(contact: Contact, region?: string): Contact {
    const labels: Record<string, string> = {};
    if (contact.labels) {
      for (const [handle, label] of Object.entries(contact.labels)) {
        labels[this.mask(handle)] = this.maskText(label, region);
      }
    }
    const text = (value: string | undefined) =>
      value === undefined ? undefined : this.maskText(value, region);
    const labeled = (values: LabeledValue[] | undefined) =>
      values?.map((v) => ({
        label: v.label === null ? null : this.maskText(v.label, region),
        value: this.maskText(v.value, region),
      }));
    let details: ContactDetails | undefined;
    if (contact.details) {
      details = {};
      for (const [key, value] of Object.entries(contact.details) as Array<
        [keyof ContactDetails, ContactDetails[keyof ContactDetails]]
      >) {
        if (value === undefined) continue;
        if (key === "addresses" || key === "urls") {
          details[key] = labeled(value as LabeledValue[]);
        } else {
          details[key] = text(value as string);
        }
      }
    }
    return {
      ...contact,
      name: this.maskDisplay(contact.name, region, contact.handles[0]),
      handles: contact.handles.map((h) => this.mask(h)),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(details ? { details } : {}),
    };
  }

  maskGroup(group: Group, region?: string): Group {
    return {
      ...group,
      threadKey: this.mask(group.threadKey),
      name: group.name === null ? null : this.maskText(group.name, region),
      participants: group.participants.map((p) => this.maskDisplay(p, region)),
      roster: group.roster ? group.roster.map((h) => this.mask(h)) : null,
    };
  }
}

/** True when a display string looks like a phone number or email address rather than a person's name. */
function looksLikeAddress(value: string): boolean {
  if (value.includes("@")) return true;
  return !/\p{L}/u.test(value) && /[0-9]{4,}/.test(value);
}

function allKnownHandles(store: Store): Set<string> {
  const handles = new Set<string>();
  const add = (rows: Array<{ h: string | null }>) => {
    for (const row of rows) {
      if (
        row.h &&
        (row.h.startsWith("tel:") ||
          row.h.startsWith("email:") ||
          row.h.startsWith("group:members:"))
      ) {
        handles.add(row.h);
      }
    }
  };
  add(store.db.query<{ h: string }>("SELECT DISTINCT handle AS h FROM handles"));
  add(store.db.query<{ h: string }>("SELECT DISTINCT key AS h FROM threads"));
  add(store.db.query<{ h: string }>("SELECT DISTINCT thread_key AS h FROM groups"));
  add(store.db.query<{ h: string }>("SELECT DISTINCT handle AS h FROM thread_members"));
  add(
    store.db.query<{ h: string | null }>(
      "SELECT DISTINCT sender AS h FROM messages WHERE sender IS NOT NULL",
    ),
  );
  return handles;
}

export interface RateLimitSlot {
  commit(now: number): void;
  release(): void;
}

/** What agents do that is rate-limited: sends, and changes that reach the phone. */
export type AgentAction = "send" | "draft" | "markRead" | "mute" | "sync" | "contacts";

export interface AgentLimit {
  max: number;
  windowMs: number;
}

/**
 * The limits. `send` follows `agents.sendLimit` in a running Core; the others are generous for an
 * assistant, not a loop.
 */
export const DEFAULT_AGENT_LIMITS: Record<AgentAction, AgentLimit> = {
  send: { max: DEFAULT_AGENT_SEND_LIMIT, windowMs: DEFAULT_AGENT_SEND_WINDOW_MS },
  draft: { max: 30, windowMs: 10 * 60_000 },
  markRead: { max: 60, windowMs: 10 * 60_000 },
  mute: { max: 30, windowMs: 10 * 60_000 },
  sync: { max: 10, windowMs: 10 * 60_000 },
  contacts: { max: 3, windowMs: 10 * 60_000 },
};

/** The rate-limited action an agent's command counts against, if any. */
export function agentActionFor(command: string, input: unknown): AgentAction[] {
  switch (command) {
    case "message.send":
      return ["send"];
    case "message.draft.save":
      // Withdrawing a draft (empty text) is never limited.
      return (input as { text?: string } | null)?.text ? ["draft"] : [];
    case "thread.markRead":
      return ["markRead"];
    case "thread.mute":
      return ["mute"];
    case "contact.sync":
      return ["contacts"];
    case "sync.now":
      return (input as { contacts?: boolean } | null)?.contacts ? ["sync", "contacts"] : ["sync"];
    default:
      return [];
  }
}

const ACTION_NAMES: Record<AgentAction, string> = {
  send: "messages",
  draft: "drafts",
  markRead: "mark-read requests",
  mute: "mute changes",
  sync: "syncs",
  contacts: "contact syncs",
};

/**
 * Sliding-window rate limits for AI agents with synchronous in-flight reservation. Committed
 * actions are kept in the store (when there is one), so restarting the daemon doesn't reset them.
 */
export class AgentRateLimiter {
  readonly #store: Store | null;
  readonly #limits: Record<AgentAction, AgentLimit | (() => AgentLimit)>;
  readonly #memory = new Map<AgentAction, number[]>();
  readonly #inFlight = new Map<AgentAction, number>();

  /** A limit given as a function is read at every reservation, so it can change while running. */
  constructor(
    store: Store | null = null,
    limits: Partial<Record<AgentAction, AgentLimit | (() => AgentLimit)>> = {},
  ) {
    this.#store = store;
    this.#limits = { ...DEFAULT_AGENT_LIMITS, ...limits };
  }

  /** The limit for `kind` now. */
  limit(kind: AgentAction): AgentLimit {
    const limit = this.#limits[kind];
    return typeof limit === "function" ? limit() : limit;
  }

  /** Synchronously reserves a slot so concurrent calls cannot bypass the rate limit. */
  reserve(kind: AgentAction, now: number): RateLimitSlot {
    const { max, windowMs } = this.limit(kind);
    const inFlight = this.#inFlight.get(kind) ?? 0;
    if (this.#count(kind, now - windowMs) + inFlight >= max) {
      const setting =
        kind === "send"
          ? " The user can change the limit in Tincan settings (agents.sendLimit)."
          : "";
      throw new TincanError(
        "BUSY",
        `Agent rate limit reached (${max} ${ACTION_NAMES[kind]} per ${Math.round(windowMs / 60_000)} minutes). Wait before trying again.${setting}`,
      );
    }
    this.#inFlight.set(kind, inFlight + 1);
    let settled = false;
    const done = () => {
      settled = true;
      this.#inFlight.set(kind, Math.max(0, (this.#inFlight.get(kind) ?? 1) - 1));
    };
    return {
      commit: (at: number) => {
        if (settled) return;
        done();
        this.#record(kind, at, at - windowMs);
      },
      release: () => {
        if (!settled) done();
      },
    };
  }

  /** Reserves a slot for each of `kinds`, all or none. */
  reserveAll(kinds: readonly AgentAction[], now: number): RateLimitSlot | null {
    if (kinds.length === 0) return null;
    const slots: RateLimitSlot[] = [];
    try {
      for (const kind of kinds) slots.push(this.reserve(kind, now));
    } catch (error) {
      for (const slot of slots) slot.release();
      throw error;
    }
    return {
      commit: (at) => slots.forEach((slot) => slot.commit(at)),
      release: () => slots.forEach((slot) => slot.release()),
    };
  }

  #count(kind: AgentAction, since: number): number {
    if (this.#store) return this.#store.countAgentActions(kind, since);
    return (this.#memory.get(kind) ?? []).filter((at) => at > since).length;
  }

  #record(kind: AgentAction, at: number, keepAfter: number): void {
    if (this.#store) {
      this.#store.recordAgentAction(kind, at, keepAfter);
      return;
    }
    const kept = (this.#memory.get(kind) ?? []).filter((t) => t > keepAfter);
    kept.push(at);
    this.#memory.set(kind, kept);
  }
}

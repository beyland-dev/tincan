import type { Message, Thread } from "@beyland/tincan-protocol";

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A readable form of a handle: `+1 (555) 010-0001`, an email address, or a sender id. */
export function formatHandle(handle: string): string {
  const colon = handle.indexOf(":");
  const kind = handle.slice(0, colon);
  const value = handle.slice(colon + 1);
  if (kind !== "tel") return value;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : value;
}

/** Up to two initials for an avatar; `#` for a bare number. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "#";
  if (/^\d/.test(words[0]!)) return "#";
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

/** A hue (0–359) that stays the same for a name. */
export function hue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The short time in the conversation list: `14:05`, `Yesterday`, `Tue`, `3/14/25`. */
export function listTime(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days <= 0)
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(time).toLocaleDateString([], { weekday: "short" });
  return new Date(time).toLocaleDateString([], {
    year: "2-digit",
    month: "numeric",
    day: "numeric",
  });
}

/** The divider between days in a conversation. */
export function dayLabel(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(time);
  return date.toLocaleDateString([], {
    weekday: days < 7 ? "long" : undefined,
    month: days < 7 ? undefined : "long",
    day: days < 7 ? undefined : "numeric",
    year: new Date(now).getFullYear() === date.getFullYear() ? undefined : "numeric",
  });
}

export function clockTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * When a message happened: the phone's timestamp when it has one. One held for its send delay
 * sorts by when it will go.
 */
export function messageTime(message: Message): number {
  if (message.status === "scheduled" && message.sendAt) return message.sendAt;
  return message.sentAt ?? message.receivedAt;
}

/**
 * Whether the user has written in a conversation: a message they sent that reached the phone (or
 * is on its way). One still held for its send delay doesn't count, since it can be undone.
 */
export function wroteIn(thread: Thread, messages: readonly Message[]): boolean {
  const sent = (m: Message | null | undefined) =>
    m?.direction === "outgoing" && m.status !== "scheduled";
  return messages.some(sent) || sent(thread.lastMessage);
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Messages close together from the same sender share one bubble group. */
export function startsGroup(previous: Message | undefined, message: Message): boolean {
  if (!previous) return true;
  if (previous.direction !== message.direction || previous.sender !== message.sender) return true;
  return messageTime(message) - messageTime(previous) > 5 * MINUTE;
}

export function preview(thread: Thread, names: ReadonlyMap<string, string>): string {
  const last = thread.lastMessage;
  if (!last) return "";
  const body = placeholderLabel(last.body) ?? (last.body.trim() || attachmentLabel(last) || "");
  if (last.direction === "outgoing") return `You: ${body}`;
  if (thread.kind === "group" && last.sender) {
    const name = names.get(last.sender) ?? formatHandle(last.sender);
    return `${name.split(" ")[0]}: ${body}`;
  }
  return body;
}

/**
 * What stands in for things Tincan can't show. iMessage puts U+FFFC where an attachment was and
 * U+FFFD for an app item (a shared location, a payment, a game) in the text MAP gives Tincan.
 */
export interface Placeholders {
  attachments: number;
  appItems: number;
  /** The text around them. */
  text: string;
}

export function placeholders(body: string): Placeholders | null {
  if (!/[\uFFFC\uFFFD]/.test(body)) return null;
  let attachments = 0;
  let appItems = 0;
  for (const char of body) {
    if (char === "\uFFFC") attachments++;
    else if (char === "\uFFFD") appItems++;
  }
  return { attachments, appItems, text: body.replace(/[\uFFFC\uFFFD]/g, "").trim() };
}

export type AttachmentKind = "image" | "video" | "audio" | "file" | "sticker" | "contact";

export interface AttachmentPart {
  count: number;
  kind: AttachmentKind;
}

const IOS_KINDS: [RegExp, AttachmentKind][] = [
  [/^(image|photo)s?$/i, "image"],
  [/^(video|movie)s?$/i, "video"],
  [/^audio (file|message)s?$/i, "audio"],
  [/^stickers?$/i, "sticker"],
  [/^contact( card)?s?$/i, "contact"],
];

/**
 * iOS describes attachments in the text it sends over MAP when a message has nothing else:
 * "Attachment: 1 Image", "Attachments: 3 Images" or "Attachments: 2 Images, 1 Video".
 */
export function attachmentSummary(body: string): AttachmentPart[] | null {
  const match = /^Attachments?: (.+)$/.exec(body.trim());
  if (!match) return null;
  const parts: AttachmentPart[] = [];
  for (const item of match[1]!.split(/,\s*|\s+and\s+/)) {
    const part = /^(\d+) (.+)$/.exec(item.trim());
    if (!part) return null;
    const noun = part[2]!;
    const kind = IOS_KINDS.find(([pattern]) => pattern.test(noun))?.[1] ?? "file";
    parts.push({ count: Number(part[1]), kind });
  }
  return parts.length > 0 ? parts : null;
}

/** A conversation-list label for a message that is only placeholders. */
export function placeholderLabel(body: string): string | null {
  const found = placeholders(body);
  if (!found || found.text) return null;
  if (found.attachments > 0)
    return found.attachments === 1 ? "1 attachment" : `${found.attachments} attachments`;
  return "Location or Messages app item";
}

/** A message of one to three emoji and nothing else, drawn large without a bubble. */
export function isJumboEmoji(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)]
    .map((s) => s.segment)
    .filter((g) => g.trim() !== "");
  if (graphemes.length === 0 || graphemes.length > 3) return false;
  return graphemes.every(
    (g) =>
      /^\p{Regional_Indicator}{2}$/u.test(g) ||
      (/\p{Extended_Pictographic}/u.test(g) &&
        /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\u200D\uFE0F\u20E3]|\p{Emoji})+$/u.test(
          g,
        )),
  );
}

/**
 * The summary iOS sends instead of a link it previewed itself, such as
 * `Website: Title (⁦‪example.com‬⁩)`: the domain is wrapped in bidi isolates. Null for any other text.
 */
export function linkSummary(text: string): { label: string; title: string; host: string } | null {
  const match =
    /^([A-Z][\p{L} ]{1,24}): ([\s\S]+?) \(\u2066?\u202A?([a-z0-9.-]+\.[a-z]{2,})\u202C?\u2069?\)$/iu.exec(
      text.trim(),
    );
  if (!match || !/[\u2066-\u2069\u202A-\u202E]/.test(text)) return null;
  return { label: match[1]!, title: match[2]!.trim(), host: match[3]!.toLowerCase() };
}

export function attachmentLabel(message: Message): string | null {
  const hint = message.attachmentHint;
  if (!hint) return null;
  const count = hint.count ?? 1;
  const kind = hint.kinds?.length === 1 ? hint.kinds[0]! : "attachment";
  const noun = kind === "image" ? "photo" : kind === "file" ? "file" : kind;
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * What a message that didn't send says under it, before Try again: why, when the daemon knows a
 * reason worth telling (its send delay ended while the computer slept, or before Tincan restarted).
 */
export function sendFailureText(message: Pick<Message, "status" | "failure">): string {
  if (message.status === "unknown") return "It may not have sent.";
  switch (message.failure?.code) {
    case "PAUSED":
      return "Paused while your computer was asleep.";
    case "RESTARTED":
      return "Tincan was restarted before it was sent.";
    default:
      return "Not sent.";
  }
}

/** Merge messages into a conversation, oldest first, newer copies winning. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()]
    .filter((m) => !m.reactionTo)
    .sort((a, b) => messageTime(a) - messageTime(b) || a.receivedAt - b.receivedAt);
}

/**
 * Replaces the newest stretch of a conversation with a fresh page of its latest messages, so
 * messages that left it (moved, deleted, turned into a tapback) drop out. `complete`: the page
 * holds the whole conversation.
 */
export function replaceLatest(existing: Message[], page: Message[], complete: boolean): Message[] {
  if (complete || page.length === 0) return mergeMessages([], page);
  const oldest = Math.min(...page.map(messageTime));
  return mergeMessages(
    existing.filter((m) => messageTime(m) <= oldest),
    page,
  );
}

export interface LinkPart {
  url: string;
  text: string;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Splits message text into plain text and web links (bare `www.` links get https). */
export function linkify(text: string): Array<string | LinkPart> {
  const parts: Array<string | LinkPart> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let link = match[0];
    // Trailing punctuation and unbalanced closing brackets belong to the sentence, not the link.
    for (;;) {
      const end = link.at(-1)!;
      if (/[.,!?;:'"*]/.test(end)) link = link.slice(0, -1);
      else if (PAIRS[end] && count(link, end) > count(link, PAIRS[end]!)) link = link.slice(0, -1);
      else break;
    }
    if (/^www\.$/i.test(link) || /^https?:\/\/$/i.test(link)) continue;
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ url: /^www\./i.test(link) ? `https://${link}` : link, text: link });
    last = start + link.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A URL as it really reads, with an international host in its ASCII (punycode) form. */
export function asciiUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** The first web link in some text, if any. */
export function firstLink(text: string): string | undefined {
  return linkify(text).find((part): part is LinkPart => typeof part !== "string")?.url;
}

/** The URL when a message is nothing but one link. */
export function onlyLink(text: string): string | undefined {
  const parts = linkify(text.trim());
  const only = parts.length === 1 ? parts[0] : undefined;
  return only && typeof only !== "string" ? only.url : undefined;
}

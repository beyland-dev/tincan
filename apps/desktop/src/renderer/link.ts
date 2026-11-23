import type { OutputOf } from "@beyland/tincan-protocol";
import { clockTime, listTime, sameDay, startOfDay } from "./format.ts";

export type LinkEvent = OutputOf<"device.history">[number];

/** A stretch of time the phone was connected (`on`) or not. */
export interface Span {
  from: number;
  to: number;
  on: boolean;
  /** The span that runs up to now. */
  open?: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The phone's connected and disconnected stretches from the connection history, oldest first.
 * Disconnects shorter than `minGap` (a reconnect, or connecting at startup) are folded away; the
 * stretch running up to now is always kept. Nothing is reported before the first event.
 */
export function linkSpans(events: readonly LinkEvent[], now: number, minGap = MINUTE): Span[] {
  const phone = events.filter((event) => event.kind === "phone" && event.at <= now);
  const raw: Span[] = phone.map((event, i) => ({
    from: event.at,
    to: phone[i + 1]?.at ?? now,
    on: event.state === "connected",
  }));
  const merged = merge(raw).filter(
    (span, i, all) => span.on || i === all.length - 1 || span.to - span.from >= minGap,
  );
  const spans = merge(merged);
  const last = spans.at(-1);
  if (last) last.open = true;
  return spans;
}

function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && last.on === span.on) last.to = span.to;
    else if (last) out.push({ ...span, from: last.to });
    else out.push({ ...span });
  }
  return out;
}

/** Disconnected stretches, oldest first. */
export function gaps(spans: readonly Span[]): Span[] {
  return spans.filter((span) => !span.on);
}

export interface GapBreaks {
  /** Gaps to show just before the message at that index. */
  before: Map<number, Span[]>;
  /** Gaps after the last message. */
  after: Span[];
}

/**
 * Where disconnects fall in a conversation: each gap that started after the first message goes
 * before the first message newer than its start. Gaps that fall between the same two messages
 * are grouped, so a quiet thread shows one line rather than a stack of them.
 */
export function gapBreaks(times: readonly number[], spans: readonly Span[]): GapBreaks {
  const before = new Map<number, Span[]>();
  const after: Span[] = [];
  if (times.length === 0) return { before, after };
  const first = times[0]!;
  let i = 0;
  for (const gap of gaps(spans)) {
    if (gap.from < first) continue;
    while (i < times.length && times[i]! <= gap.from) i++;
    if (i >= times.length) after.push(gap);
    else before.set(i, [...(before.get(i) ?? []), gap]);
  }
  return { before, after };
}

/** How many of `times` fall inside the gap: messages fetched when the phone came back. */
export function caughtUp(times: readonly number[], gap: Span): number {
  return times.filter((time) => time >= gap.from && time <= gap.to).length;
}

const range = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

function dayPrefix(time: number, now: number): string {
  return sameDay(time, now) ? "" : `${listTime(time, now)} `;
}

/** `9:12 AM`, `Yesterday 9:12 PM`. */
export function formatTime(at: number, now = Date.now()): string {
  return dayPrefix(at, now) + clockTime(at);
}

/** `10:48 – 11:40 AM`, `Yesterday 9:12 – 9:40 PM`, `Mon 11:02 PM – 7:15 AM`. */
export function formatRange(from: number, to: number, now = Date.now()): string {
  if (sameDay(from, to)) return dayPrefix(from, now) + range.formatRange(from, to);
  return `${formatTime(from, now)} – ${formatTime(to, now)}`;
}

/** `4 min`, `1h 12m`, `2d 3h`. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** `twice`, `3 times`. */
export function times(count: number): string {
  return count === 2 ? "twice" : `${count} times`;
}

/** What the timeline covers: today, or at least the last three hours. */
export function timelineWindow(now: number): { from: number; to: number } {
  return { from: Math.min(startOfDay(now), now - 3 * HOUR), to: now };
}

/** Spans cut to a window; those outside it are dropped. */
export function clip(spans: readonly Span[], from: number, to: number): Span[] {
  return spans
    .filter((span) => span.to > from && span.from < to)
    .map((span) => ({ ...span, from: Math.max(span.from, from), to: Math.min(span.to, to) }));
}

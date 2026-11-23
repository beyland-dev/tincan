import type { Message, ProfileState } from "@beyland/tincan-protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { attachmentLabel, clockTime, hue, messageTime, placeholderLabel } from "../format.ts";
import {
  caughtUp,
  clip,
  formatDuration,
  formatRange,
  formatTime,
  linkSpans,
  timelineWindow,
  times,
  type Span,
} from "../link.ts";
import {
  connection,
  conversations,
  dialog,
  dockOpen,
  linkLog,
  notifications,
  select,
  startPairing,
  status,
  syncNow,
  threads,
} from "../store.ts";
import { Icon } from "./Icon.tsx";
import { Sensitive } from "./Sensitive.tsx";
import { richTip } from "./Tooltip.tsx";

const MAP_TEXT: Record<ProfileState, string> = {
  ready: "Connected",
  idle: "Connected",
  connecting: "Connecting to messages…",
  denied: "Messages not allowed",
  refused: "Not sharing messages",
  unavailable: "Messages unavailable",
};

const MISSED = "Anything else from then is only on your iPhone";

/** Re-render every half minute so durations and the timeline's "now" keep moving. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Head({ gap, title, duration }: { gap?: boolean; title: string; duration?: string }) {
  return (
    <div class="tip-head">
      <span class={`tip-swatch ${gap ? "gap" : ""}`} />
      {title}
      {duration && <span class="tip-aside">{duration}</span>}
    </div>
  );
}

/** What a disconnect meant: when, for how long, and what came through once the phone was back. */
export function GapTip({ gap, caught, now }: { gap: Span; caught: number; now: number }) {
  if (gap.open) {
    return (
      <>
        <Head gap title="Disconnected" duration={formatDuration(now - gap.from)} />
        <div class="tip-row">Since {formatTime(gap.from, now)}</div>
        <div class="tip-foot">New messages come through when your iPhone is back</div>
      </>
    );
  }
  return (
    <>
      <Head gap title="Disconnected" duration={formatDuration(gap.to - gap.from)} />
      <div class="tip-row">{formatRange(gap.from, gap.to, now)}</div>
      {caught > 0 && (
        <div class="tip-row">
          <span class="tip-ok">↻</span> {caught} caught up on reconnect
        </div>
      )}
      <div class="tip-foot">
        {caught > 0 ? MISSED : "Anything from then is only on your iPhone"}
      </div>
    </>
  );
}

const LIST = 5;

/** Several disconnects that fell between the same two messages. */
export function GapGroupTip({
  gaps,
  caught,
  now,
}: {
  gaps: Span[];
  caught: (gap: Span) => number;
  now: number;
}) {
  if (gaps.length === 1) return <GapTip gap={gaps[0]!} caught={caught(gaps[0]!)} now={now} />;
  const shown = gaps.slice(-LIST);
  return (
    <>
      <Head gap title={`Out of range ${times(gaps.length)}`} />
      {gaps.length > LIST && <div class="tip-row">+{gaps.length - LIST} earlier</div>}
      {shown.map((gap) => {
        const n = caught(gap);
        return (
          <div class="tip-line" key={gap.from}>
            <span>{formatRange(gap.from, gap.to, now)}</span>
            <span>
              {formatDuration(gap.to - gap.from)}
              {n > 0 && (
                <>
                  {" · "}
                  <span class="tip-ok">↻</span> {n} caught up
                </>
              )}
            </span>
          </div>
        );
      })}
      <div class="tip-foot">Anything missed is only on your iPhone</div>
    </>
  );
}

interface Heard {
  message: Message;
  title: string;
  at: number;
}

/** Incoming messages Tincan knows about since `from`, oldest first. */
function heardSince(from: number): Heard[] {
  const titles = new Map(threads.value.map((t) => [t.key, t.title]));
  const seen = new Map<string, Message>();
  for (const thread of threads.value) {
    if (thread.lastMessage) seen.set(thread.lastMessage.id, thread.lastMessage);
  }
  for (const conversation of Object.values(conversations.value)) {
    for (const message of conversation.messages) seen.set(message.id, message);
  }
  const out: Heard[] = [];
  for (const message of seen.values()) {
    const at = messageTime(message);
    if (message.direction !== "incoming" || message.reaction || at < from) continue;
    out.push({ message, at, title: titles.get(message.threadKey) ?? "Unknown" });
  }
  return out.sort((a, b) => a.at - b.at);
}

function bodyLine(message: Message): string {
  return placeholderLabel(message.body) ?? (message.body.trim() || attachmentLabel(message) || "");
}

function hourLabels(from: number, to: number): number[] {
  const hours = (to - from) / 3_600_000;
  const step = hours > 12 ? 3 : hours > 6 ? 2 : 1;
  const start = new Date(from);
  start.setMinutes(0, 0, 0);
  const out: number[] = [];
  for (let at = start.getTime(); at <= to; at += 3_600_000) {
    if (at < from || new Date(at).getHours() % step) continue;
    const x = (at - from) / (to - from);
    if (x > 0.03 && x < 0.95) out.push(at);
  }
  return out;
}

function Timeline({ now }: { now: number }) {
  const range = timelineWindow(now);
  const all = linkSpans(linkLog.value, now);
  const spans = clip(all, range.from, range.to);
  const heard = heardSince(range.from);
  const heardTimes = heard.map((h) => h.at);
  const pc = (at: number) => `${((at - range.from) / (range.to - range.from)) * 100}%`;
  const width = (from: number, to: number) => `calc(${pc(to)} - ${pc(from)})`;
  const firstSeen = all[0]?.from ?? now;
  const before = firstSeen > range.from ? Math.min(firstSeen, now) : null;

  return (
    <div class="link-strip">
      <div class="link-track" />
      {before !== null && (
        <div
          class="link-gap"
          data-tip={`Not connected yet · before ${clockTime(before)}`}
          data-tip-delay="short"
          ref={richTip(() => (
            <>
              <Head gap title="Not connected yet" duration={formatDuration(before - range.from)} />
              <div class="tip-row">Before {clockTime(before)}</div>
              <div class="tip-foot">Anything from then is only on your iPhone</div>
            </>
          ))}
          style={{ left: pc(range.from), width: width(range.from, before) }}
        />
      )}
      {spans.map((span) => {
        const original = all.find((s) => s.to >= span.to && s.from <= span.from) ?? span;
        if (!span.on) {
          const caught = caughtUp(heardTimes, original);
          return (
            <div
              key={span.from}
              class="link-gap"
              data-tip={`Disconnected · ${formatRange(original.from, original.to, now)}`}
              data-tip-delay="short"
              ref={richTip(() => (
                <GapTip gap={original} caught={caught} now={now} />
              ))}
              style={{ left: pc(span.from), width: width(span.from, span.to) }}
            />
          );
        }
        const count = heardTimes.filter((t) => t >= original.from && t <= original.to).length;
        return (
          <div
            key={span.from}
            class="link-seg"
            data-tip={`Connected · ${formatRange(original.from, original.to, now)}`}
            data-tip-delay="short"
            ref={richTip(() => (
              <>
                <Head title="Connected" duration={formatDuration(original.to - original.from)} />
                <div class="tip-row">
                  {original.open
                    ? `Since ${formatTime(original.from, now)}`
                    : formatRange(original.from, original.to, now)}
                </div>
                <div class="tip-row">
                  {count === 0
                    ? "Nothing came through"
                    : `${count} ${count === 1 ? "message" : "messages"} came through`}
                </div>
              </>
            ))}
            style={{ left: pc(span.from), width: width(span.from, span.to) }}
          />
        );
      })}
      {heard.map(({ message, title, at }) => (
        <button
          key={message.id}
          class="link-tick"
          aria-label={`${title}, ${clockTime(at)}`}
          data-tip={`${title} · ${clockTime(at)}`}
          data-tip-delay="short"
          ref={richTip(() => (
            <>
              <div class="tip-head">
                <span class="tip-dot" style={{ background: `hsl(${hue(title)} 45% 55%)` }} />
                {title}
                <span class="tip-aside">{clockTime(at)}</span>
              </div>
              <div class="tip-row quote">{bodyLine(message)}</div>
            </>
          ))}
          style={{ left: pc(at), background: `hsl(${hue(title)} 45% 55%)` }}
          onClick={() => {
            dockOpen.value = false;
            void select(message.threadKey);
          }}
        />
      ))}
      {hourLabels(range.from, range.to).map((at) => (
        <span key={at} class="link-hour" style={{ left: pc(at) }}>
          {new Date(at).toLocaleTimeString([], { hour: "numeric" })}
        </span>
      ))}
      <div class="link-now" />
    </div>
  );
}

/**
 * The foot of the sidebar: whether the phone is connected right now, and a click away from a
 * timeline of today's connects, disconnects and the messages that came through.
 */
export function ConnectionDock() {
  const now = useNow();
  const dock = useRef<HTMLDivElement>(null);
  const open = dockOpen.value;
  const conn = connection.value;
  const phone = status.value?.phone;
  const map = phone?.device?.profiles.map;
  const blocked = !phone?.device?.paused && (map === "refused" || map === "denied");
  // The name is on screen only blurred (beside the toggle, see below), never in a tip.
  const name = phone?.device?.name;
  const paired = conn.state === "connected" && !!phone && phone.state !== "unpaired";

  let tone: "ok" | "warn" | "off" = "off";
  let label: string;
  let tip: string;
  if (conn.state !== "connected") {
    label = conn.state === "closed" ? "Can't reach Tincan" : "Starting Tincan…";
    tip = label;
    tone = "warn";
  } else if (!phone || phone.state === "unpaired") {
    label = "No iPhone paired";
    tip = label;
  } else if (phone.device?.paused) {
    label = "Disconnected";
    tip = "iPhone disconnected — connect it in Settings";
  } else if (blocked) {
    label = MAP_TEXT[map ?? "unavailable"];
    tip = `iPhone: ${label.toLowerCase()}`;
    tone = "warn";
  } else if (phone.state === "connected" && map === "ready") {
    label = "Connected";
    tip = "iPhone connected";
    tone = "ok";
  } else if (phone.state === "connected" || phone.state === "connecting") {
    label = "Connecting…";
    tip = "Connecting to iPhone…";
    tone = "warn";
  } else {
    label = "Disconnected";
    tip = "iPhone is away — messages will come through when it's back";
  }
  const last = linkSpans(linkLog.value, now).at(-1);
  const away = tone === "off" && paired && last && !last.on ? formatDuration(now - last.from) : "";
  const ancs = notifications.value;

  useEffect(() => {
    if (!paired && dockOpen.value) dockOpen.value = false;
  }, [paired]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (dock.current && !dock.current.contains(e.target as Node)) dockOpen.value = false;
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  // The phone's name sits over the toggle's middle, as its own button (see `.dock-bar`).
  const named = paired && !!name;
  const lead = (
    <span class="dock-lead">
      <span class={`status-dot ${tone}`} />
      <span class={`dock-label ${tone}`}>{label}</span>
    </span>
  );

  return (
    <div class="dock-slot">
      <div ref={dock} class={`dock ${open ? "open" : ""}`}>
        <div class="dock-timeline" aria-hidden={!open}>
          {paired && <Timeline now={now} />}
        </div>
        <div class="dock-bar">
          {paired ? (
            <button
              class="dock-toggle"
              aria-expanded={open}
              data-tip-delay="long"
              data-tip={ancs ? `${tip} · notifications ${ancs}` : tip}
              onClick={() => (dockOpen.value = !open)}
            >
              {lead}
              <span class="dock-tail">
                {away && <span class="dock-away">{away}</span>}
                <span class="dock-chevron">
                  <Icon name="chevronDown" size={12} />
                </span>
              </span>
            </button>
          ) : (
            <span
              class="dock-toggle static"
              data-tip-delay="long"
              data-tip={ancs ? `${tip} · notifications ${ancs}` : tip}
            >
              {lead}
              <span class="dock-tail">{away && <span class="dock-away">{away}</span>}</span>
            </span>
          )}
          {named && (
            <Sensitive what="iPhone name" class="dock-phone">
              {name}
            </Sensitive>
          )}
          {conn.state === "connected" && (!phone || phone.state === "unpaired") && (
            <button class="link" onClick={() => void startPairing()}>
              Pair…
            </button>
          )}
          {blocked && (
            <button class="link" onClick={() => (dialog.value = "fixConnection")}>
              Fix…
            </button>
          )}
          {phone?.state === "connected" && (
            <button
              class="icon-button small"
              data-tip="Check for new messages"
              aria-label="Check for new messages"
              onClick={(e) => {
                spinOnce(e.currentTarget.querySelector("svg"));
                void syncNow();
              }}
            >
              <Icon name="refresh" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One full turn of an icon, to acknowledge a click. Restarts if clicked again mid-turn. */
function spinOnce(icon: Element | null): void {
  if (!icon || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const running of icon.getAnimations()) running.cancel();
  icon.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
    duration: 600,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  });
}

/**
 * A line in a conversation where the phone was out of reach between two messages. Every
 * disconnect between the same two messages shares one line, so a quiet thread doesn't fill up
 * with them.
 */
export function GapDivider({ gaps, times: heard }: { gaps: Span[]; times: readonly number[] }) {
  const now = Date.now();
  const first = gaps[0]!;
  const last = gaps.at(-1)!;
  if (last.open && gaps.length === 1) {
    return (
      <p
        class="gap-divider"
        data-tip={`Disconnected since ${formatTime(first.from, now)}`}
        data-tip-delay="short"
        ref={richTip(() => (
          <GapTip gap={first} caught={0} now={now} />
        ))}
      >
        Disconnected since {formatTime(first.from, now)}
      </p>
    );
  }
  const label =
    gaps.length === 1
      ? `Disconnected · ${formatRange(first.from, first.to, now)}`
      : `Out of range ${times(gaps.length)} · ${formatRange(first.from, last.to, now)}`;
  return (
    <p
      class="gap-divider"
      data-tip={label}
      data-tip-delay="short"
      ref={richTip(() => (
        <GapGroupTip gaps={gaps} caught={(gap) => caughtUp(heard, gap)} now={now} />
      ))}
    >
      {label}
    </p>
  );
}

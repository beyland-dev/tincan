/** Whole seconds until `sendAt`, rounded up so "1s" shows until the moment it goes. */
export function secondsLeft(sendAt: number, now: number): number {
  return Math.max(0, Math.ceil((sendAt - now) / 1000));
}

/** "8s", "1m 05s". */
export function shortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

/** "10 seconds", "1 minute 5 seconds", for screen readers. */
export function spokenDuration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(seconds, "second");
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? unit(m, "minute") : `${unit(m, "minute")} ${unit(s, "second")}`;
}

/**
 * The status line under a message held for its send delay: "Sending in 8s" for the user's own
 * messages (and agent drafts they sent), "Claude Code is sending in 8s" for an agent's direct
 * send. `left` is null when the daemon didn't say when it goes.
 */
export function scheduledLine(left: number | null, agent?: string): string {
  const who = agent ? `${agent} is sending` : "Sending";
  if (left === null) return agent ? `${who} soon` : "Waiting to send";
  return left === 0 ? `${who}…` : `${who} in ${shortDuration(left)}`;
}

/** Said once when a message starts its send delay. */
export function scheduledAnnouncement(
  recipient: string,
  seconds: number | null,
  agent?: string,
): string {
  const when = seconds === null ? "shortly" : `in ${spokenDuration(seconds)}`;
  return agent
    ? `${agent} is sending a message to ${recipient} ${when}. Press Control Shift Z to edit it instead.`
    : `Sending to ${recipient} ${when}. Press Control Shift Z to undo.`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How old an agent draft is, once it's old enough to say ("5 h", "3 d"); null for one under an
 * hour old. Drafts never expire, so an old one says so instead.
 */
export function draftAge(createdAt: number, now: number): string | null {
  const age = now - createdAt;
  if (age < HOUR) return null;
  if (age < DAY) return `${Math.floor(age / HOUR)} h`;
  return `${Math.floor(age / DAY)} d`;
}

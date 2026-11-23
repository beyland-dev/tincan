/**
 * The life of a `<Reveal>`: content that slides open and closed when a parent setting changes.
 *
 * - `hidden`: not rendered.
 * - `entering`: rendered collapsed, for one style pass, so the open transition has a start.
 * - `opening`: open, while the transition runs (content clipped).
 * - `shown`: open and settled (nothing clipped, so focus rings show).
 * - `leaving`: collapsed, while the transition runs; then it unmounts.
 */
export type RevealPhase = "hidden" | "entering" | "opening" | "shown" | "leaving";

/** `frame`: the collapsed start has been styled. `done`: the transition ended (or timed out). */
export type RevealEvent = "open" | "close" | "frame" | "done";

/** How long the slide takes; the CSS uses the same. */
export const REVEAL_MS = 200;

/**
 * Changes this soon after a reveal mounts happen at once: the settings it depends on are still
 * arriving as the dialog opens, which shouldn't look like the user changed something.
 */
export const REVEAL_GRACE_MS = 250;

export function initialPhase(open: boolean): RevealPhase {
  return open ? "shown" : "hidden";
}

/** The next phase; `instant` (reduced motion, or just mounted) skips the transition. */
export function revealNext(phase: RevealPhase, event: RevealEvent, instant = false): RevealPhase {
  switch (event) {
    case "open":
      if (instant) return "shown";
      if (phase === "hidden") return "entering";
      // Closing part way: turn around from where it is.
      if (phase === "leaving") return "opening";
      return phase;
    case "close":
      if (instant || phase === "hidden") return "hidden";
      return "leaving";
    case "frame":
      return phase === "entering" ? "opening" : phase;
    case "done":
      if (phase === "opening") return "shown";
      if (phase === "leaving") return "hidden";
      return phase;
  }
}

/** Whether to skip the slide: the user asked for less motion, or the reveal has only just mounted. */
export function revealInstant(reducedMotion: boolean, mountedAt: number, now: number): boolean {
  return reducedMotion || now - mountedAt < REVEAL_GRACE_MS;
}

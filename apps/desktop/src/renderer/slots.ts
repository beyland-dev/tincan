/**
 * The composer's slots: the user's own draft (always there, maybe empty) and the conversation's
 * queued agent drafts, oldest first. One is active at a time; switching never loses text.
 */

/** The user's own draft. Any other slot id is an agent draft's id. */
export const OWN = "own";
export type SlotId = string;

/**
 * The user's saved draft for the own slot, or undefined until it has arrived. A conversation's
 * comes with its details (`thread.get`: null when there's none); a new recipient's, with no
 * conversation yet, comes with the drafts (`message.draft.list`).
 */
export function savedOwnDraft(input: {
  /** A new recipient: drafts waiting, no conversation yet. */
  newRecipient: boolean;
  draftsLoaded: boolean;
  /** The new recipient's own draft from the list ("" when there's none). */
  newRecipientDraft: string;
  /** The conversation's draft from its details; undefined before they arrive. */
  detailDraft: string | null | undefined;
}): string | undefined {
  if (input.newRecipient) return input.draftsLoaded ? input.newRecipientDraft : undefined;
  return input.detailDraft === undefined ? undefined : (input.detailDraft ?? "");
}

/**
 * Which slot to show after the queue changed (`before` → `after`, agent draft ids oldest first):
 * - an agent draft that's still queued stays;
 * - one that left (sent, discarded) hands over to the draft after it, else the one before it,
 *   else the user's own draft;
 * - on the user's own draft, a newly arrived agent draft loads only while the user's text is
 *   empty, so text they're typing is never replaced.
 */
export function nextSlot(input: {
  active: SlotId;
  ownText: string;
  before: readonly string[];
  after: readonly string[];
}): SlotId {
  const { active, ownText, before, after } = input;
  if (active !== OWN) {
    if (after.includes(active)) return active;
    const at = before.indexOf(active);
    if (at >= 0) {
      const later = before.slice(at + 1).find((id) => after.includes(id));
      if (later) return later;
      const earlier = before
        .slice(0, at)
        .reverse()
        .find((id) => after.includes(id));
      if (earlier) return earlier;
    }
    return after.length > 0 && ownText.trim() === "" ? after[0]! : OWN;
  }
  const arrived = after.some((id) => !before.includes(id));
  return arrived && ownText.trim() === "" ? after[0]! : OWN;
}

/**
 * The slots in stepping order: the user's own draft first (only while it has text, or is the
 * one showing), then the agent drafts.
 */
export function slotOrder(active: SlotId, ownText: string, drafts: readonly string[]): SlotId[] {
  const own = active === OWN || ownText.trim() !== "";
  return own ? [OWN, ...drafts] : [...drafts];
}

/** The slot `delta` steps from the active one (Ctrl+] / Ctrl+[), stopping at either end. */
export function stepSlot(order: readonly SlotId[], active: SlotId, delta: number): SlotId {
  const at = order.indexOf(active);
  if (at < 0) return order[0] ?? OWN;
  return order[Math.max(0, Math.min(order.length - 1, at + delta))]!;
}

/** "‹ 2 of 3 ›" in the pill: shown only on an agent draft, when there's more than one. */
export function stepperPosition(
  active: SlotId,
  drafts: readonly string[],
): { index: number; total: number } | null {
  const at = drafts.indexOf(active);
  if (at < 0 || drafts.length < 2) return null;
  return { index: at + 1, total: drafts.length };
}

/** The pill while the user's own draft shows and agent drafts wait: "1 draft from Claude Code". */
export function queueLabel(drafts: ReadonlyArray<{ agentName: string }>): string {
  const n = drafts.length;
  const agents = new Set(drafts.map((d) => d.agentName));
  if (agents.size === 1) return `${n} draft${n === 1 ? "" : "s"} from ${drafts[0]!.agentName}`;
  return `${n} agent drafts`;
}

/** How long Enter does nothing after a send, or after a draft loads by itself. */
export const ENTER_GUARD_MS = 1000;

/** When Enter works again, after a send (or a draft loading on its own) at `now`. */
export function guardUntil(now: number): number {
  return now + ENTER_GUARD_MS;
}

/** Whether Enter is still ignored. */
export function enterBlocked(until: number, now: number): boolean {
  return now < until;
}

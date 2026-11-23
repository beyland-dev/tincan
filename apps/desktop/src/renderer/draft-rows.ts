import type { AgentDraft, Thread } from "@beyland/tincan-protocol";

/** The user's own saved draft, as `thread.list` gives it to the desktop app. */
export interface OwnDraft {
  text: string;
  updatedAt: number;
}

/** The user's own draft on a listed conversation, when the daemon includes it. */
export function ownDraftOf(thread: Thread): OwnDraft | null {
  const draft = (thread as Thread & { draft?: OwnDraft | null }).draft;
  return draft && draft.text.trim() ? draft : null;
}

/** An agent draft's current text (the user's edits included). */
export function draftText(draft: AgentDraft): string {
  return draft.text ?? draft.body;
}

/** Where a queued agent draft goes: its conversation, or for a new recipient, the recipient. */
export function draftKey(draft: AgentDraft): string {
  return draft.threadKey ?? draft.to;
}

/** What a list row says about its drafts: the newest one's text, and how many there are. */
export interface RowDraft {
  text: string;
  count: number;
  at: number;
}

/**
 * A row's drafts, the user's own and agents' alike (they look the same in the list), or null
 * when it has none.
 */
export function rowDraft(own: OwnDraft | null, agents: readonly AgentDraft[]): RowDraft | null {
  const all = [
    ...(own ? [{ text: own.text, at: own.updatedAt }] : []),
    ...agents.map((d) => ({ text: draftText(d), at: d.updatedAt })),
  ];
  if (all.length === 0) return null;
  const newest = all.reduce((a, b) => (b.at > a.at ? b : a));
  return { text: newest.text.replace(/\s+/g, " ").trim(), count: all.length, at: newest.at };
}

/**
 * Someone with no conversation yet that a draft is waiting for (agents' queued drafts, the user's
 * own saved draft, or both): a row of its own in the list.
 */
export interface PendingRecipient {
  to: string;
  drafts: AgentDraft[];
  /** The user's own saved draft to them (`message.draft.list`), if any. */
  own: OwnDraft | null;
  /** The newest draft's time, which places the row in the list. */
  at: number;
}

/** The user's own draft to someone with no conversation yet, as `message.draft.list` gives it. */
export interface OwnNewDraft extends OwnDraft {
  to: string;
}

/**
 * The new recipients among queued agent drafts and the user's own drafts to new recipients,
 * newest first. `keep` is a new recipient whose view is open: it keeps its row (by its last
 * time) after its last draft goes, so the view doesn't vanish while the user is typing.
 */
export function pendingRecipients(
  drafts: readonly AgentDraft[],
  own: readonly OwnNewDraft[],
  listed: ReadonlySet<string>,
  keep: { to: string; at: number } | null = null,
): PendingRecipient[] {
  const byTo = new Map<string, PendingRecipient>();
  const entry = (to: string) => {
    const found = byTo.get(to) ?? { to, drafts: [], own: null, at: 0 };
    byTo.set(to, found);
    return found;
  };
  for (const draft of drafts) {
    if (draft.state !== "queued" || draft.threadKey !== null || listed.has(draft.to)) continue;
    const row = entry(draft.to);
    row.drafts.push(draft);
    row.at = Math.max(row.at, draft.createdAt);
  }
  for (const mine of own) {
    if (listed.has(mine.to) || !mine.text.trim()) continue;
    const row = entry(mine.to);
    row.own = { text: mine.text, updatedAt: mine.updatedAt };
    row.at = Math.max(row.at, mine.updatedAt);
  }
  if (keep && !listed.has(keep.to) && !byTo.has(keep.to)) entry(keep.to).at = keep.at;
  return [...byTo.values()].sort((a, b) => b.at - a.at);
}

export type ListRow =
  | { kind: "thread"; key: string; thread: Thread }
  | { kind: "pending"; key: string; pending: PendingRecipient };

/**
 * The list with new recipients slotted in by their draft's time. Conversations keep the order
 * the daemon gave them (most recent first); `timeOf` says when each was last active.
 */
export function listRows(
  threads: readonly Thread[],
  pending: readonly PendingRecipient[],
  timeOf: (thread: Thread) => number,
): ListRow[] {
  const rows: ListRow[] = [];
  let p = 0;
  for (const thread of threads) {
    while (p < pending.length && pending[p]!.at >= timeOf(thread)) {
      rows.push({ kind: "pending", key: pending[p]!.to, pending: pending[p]! });
      p++;
    }
    rows.push({ kind: "thread", key: thread.key, thread });
  }
  for (; p < pending.length; p++) {
    rows.push({ kind: "pending", key: pending[p]!.to, pending: pending[p]! });
  }
  return rows;
}

/**
 * The next row with agent drafts after `current`, in list order, wrapping around (Ctrl+Shift+D).
 * Null when none has any.
 */
export function nextWithDrafts(
  order: readonly string[],
  withDrafts: ReadonlySet<string>,
  current: string | null,
): string | null {
  if (withDrafts.size === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  for (let i = 1; i <= order.length; i++) {
    const key = order[(at + i + order.length) % order.length]!;
    if (withDrafts.has(key) && key !== current) return key;
  }
  return null;
}

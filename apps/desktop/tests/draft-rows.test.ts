import type { AgentDraft, Thread } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  listRows,
  nextWithDrafts,
  ownDraftOf,
  pendingRecipients,
  rowDraft,
} from "../src/renderer/draft-rows.ts";

function draft(change: Partial<AgentDraft> = {}): AgentDraft {
  return {
    id: "drf_1",
    threadKey: "tel:+15550100001",
    to: "tel:+15550100001",
    agentName: "Claude Code",
    intent: "draft",
    body: "Lunch at noon?",
    text: "Lunch at noon?",
    edited: false,
    revision: 0,
    state: "queued",
    createdAt: 1_000,
    updatedAt: 1_000,
    resolvedAt: null,
    ...change,
  };
}

function thread(key: string, time: number, change: Partial<Thread> = {}): Thread {
  return {
    key,
    kind: "direct",
    title: key,
    members: [key],
    lastMessage: {
      id: `m-${key}`,
      threadKey: key,
      direction: "incoming",
      sender: key,
      body: "hi",
      sentAt: time,
      receivedAt: time,
      source: "map",
      status: "received",
      read: true,
      reactions: [],
    },
    unread: 0,
    muted: false,
    pinned: false,
    ...change,
  };
}

describe("rowDraft", () => {
  it("is null without drafts", () => {
    expect(rowDraft(null, [])).toBeNull();
  });

  it("treats the user's and agents' drafts alike, showing the newest", () => {
    expect(rowDraft({ text: "Mine", updatedAt: 5 }, [])).toEqual({ text: "Mine", count: 1, at: 5 });
    expect(rowDraft({ text: "Mine", updatedAt: 5 }, [draft({ updatedAt: 9 })])).toEqual({
      text: "Lunch at noon?",
      count: 2,
      at: 9,
    });
  });

  it("shows the user's edits and flattens line breaks", () => {
    expect(rowDraft(null, [draft({ text: "Lunch\n\nat one?" })])?.text).toBe("Lunch at one?");
    expect(rowDraft(null, [draft({ text: undefined })])?.text).toBe("Lunch at noon?");
  });

  it("reads the user's own draft from the list when it's there", () => {
    const t = thread("tel:+1", 0);
    expect(ownDraftOf(t)).toBeNull();
    const withDraft = { ...t, draft: { text: "Mine", updatedAt: 3 } } as Thread;
    expect(ownDraftOf(withDraft)).toEqual({ text: "Mine", updatedAt: 3 });
    expect(ownDraftOf({ ...t, draft: { text: "  ", updatedAt: 3 } } as Thread)).toBeNull();
  });
});

describe("pending recipients", () => {
  it("groups drafts to new recipients and skips listed ones", () => {
    const pending = pendingRecipients(
      [
        draft({ id: "a", threadKey: null, to: "tel:+1", createdAt: 10 }),
        draft({ id: "b", threadKey: null, to: "tel:+1", createdAt: 30 }),
        draft({ id: "c", threadKey: null, to: "tel:+2", createdAt: 20 }),
        draft({ id: "d", threadKey: null, to: "tel:+3", createdAt: 40 }),
        draft({ id: "e" }),
      ],
      [],
      new Set(["tel:+3"]),
    );
    expect(pending.map((p) => [p.to, p.drafts.length, p.at])).toEqual([
      ["tel:+1", 2, 30],
      ["tel:+2", 1, 20],
    ]);
  });

  it("slots them into the list by their draft's time", () => {
    const threads = [thread("t1", 50), thread("t2", 25), thread("t3", 5)];
    const pending = pendingRecipients(
      [
        draft({ id: "a", threadKey: null, to: "tel:+1", createdAt: 30 }),
        draft({ id: "b", threadKey: null, to: "tel:+2", createdAt: 1 }),
      ],
      [],
      new Set(),
    );
    const rows = listRows(threads, pending, (t) => t.lastMessage?.sentAt ?? 0);
    expect(rows.map((r) => r.key)).toEqual(["t1", "tel:+1", "t2", "t3", "tel:+2"]);
  });
});

describe("pending recipients with the user's own drafts", () => {
  it("gives a row to a new recipient with only the user's own draft", () => {
    const pending = pendingRecipients(
      [],
      [{ to: "tel:+4", text: "See you there", updatedAt: 70 }],
      new Set(),
    );
    expect(pending).toEqual([
      { to: "tel:+4", drafts: [], own: { text: "See you there", updatedAt: 70 }, at: 70 },
    ]);
    // It reads "Draft: …" like any other row.
    expect(rowDraft(pending[0]!.own, pending[0]!.drafts)).toEqual({
      text: "See you there",
      count: 1,
      at: 70,
    });
  });

  it("puts the user's draft and agents' drafts to the same person in one row", () => {
    const pending = pendingRecipients(
      [draft({ id: "a", threadKey: null, to: "tel:+1", createdAt: 10, updatedAt: 10 })],
      [{ to: "tel:+1", text: "Mine", updatedAt: 40 }],
      new Set(),
    );
    expect(pending.map((p) => [p.to, p.drafts.length, p.own?.text, p.at])).toEqual([
      ["tel:+1", 1, "Mine", 40],
    ]);
    expect(rowDraft(pending[0]!.own, pending[0]!.drafts)).toMatchObject({ text: "Mine", count: 2 });
  });

  it("leaves out blank drafts and recipients that now have a conversation", () => {
    const pending = pendingRecipients(
      [],
      [
        { to: "tel:+1", text: "  ", updatedAt: 5 },
        { to: "tel:+2", text: "Sent already", updatedAt: 6 },
      ],
      new Set(["tel:+2"]),
    );
    expect(pending).toEqual([]);
  });

  it("keeps the open recipient's row after its last draft goes", () => {
    const kept = pendingRecipients([], [], new Set(), { to: "tel:+5", at: 12 });
    expect(kept).toEqual([{ to: "tel:+5", drafts: [], own: null, at: 12 }]);
    expect(rowDraft(kept[0]!.own, kept[0]!.drafts)).toBeNull();
    // Not once it has a conversation: the real one takes its place.
    expect(pendingRecipients([], [], new Set(["tel:+5"]), { to: "tel:+5", at: 12 })).toEqual([]);
  });
});

describe("nextWithDrafts", () => {
  const order = ["a", "b", "c", "d"];
  it("finds the next row with drafts, wrapping around", () => {
    expect(nextWithDrafts(order, new Set(["b", "d"]), "b")).toBe("d");
    expect(nextWithDrafts(order, new Set(["b", "d"]), "d")).toBe("b");
    expect(nextWithDrafts(order, new Set(["c"]), null)).toBe("c");
  });

  it("is null when nothing else has drafts", () => {
    expect(nextWithDrafts(order, new Set(), "a")).toBeNull();
    expect(nextWithDrafts(order, new Set(["a"]), "a")).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  ENTER_GUARD_MS,
  enterBlocked,
  guardUntil,
  nextSlot,
  OWN,
  queueLabel,
  savedOwnDraft,
  slotOrder,
  stepperPosition,
  stepSlot,
} from "../src/renderer/slots.ts";

describe("nextSlot", () => {
  it("loads an arriving agent draft into an empty composer", () => {
    expect(nextSlot({ active: OWN, ownText: "", before: [], after: ["a"] })).toBe("a");
    expect(nextSlot({ active: OWN, ownText: "  ", before: [], after: ["a", "b"] })).toBe("a");
  });

  it("never replaces text the user is typing", () => {
    expect(nextSlot({ active: OWN, ownText: "On my", before: [], after: ["a"] })).toBe(OWN);
  });

  it("stays on the user's own draft when nothing new arrived", () => {
    expect(nextSlot({ active: OWN, ownText: "", before: ["a"], after: ["a"] })).toBe(OWN);
  });

  it("keeps an agent draft that's still queued", () => {
    expect(nextSlot({ active: "b", ownText: "", before: ["a", "b"], after: ["a", "b", "c"] })).toBe(
      "b",
    );
  });

  it("refills from the draft after the one that left, then the one before", () => {
    expect(nextSlot({ active: "a", ownText: "", before: ["a", "b", "c"], after: ["b", "c"] })).toBe(
      "b",
    );
    expect(nextSlot({ active: "c", ownText: "", before: ["a", "b", "c"], after: ["a", "b"] })).toBe(
      "b",
    );
  });

  it("brings the user's stashed draft back when the queue empties", () => {
    expect(nextSlot({ active: "a", ownText: "Mine", before: ["a"], after: [] })).toBe(OWN);
    expect(nextSlot({ active: "a", ownText: "", before: ["a"], after: [] })).toBe(OWN);
  });
});

describe("stepping", () => {
  it("steps through the user's draft and the agent drafts, stopping at the ends", () => {
    const order = slotOrder("a", "Mine", ["a", "b"]);
    expect(order).toEqual([OWN, "a", "b"]);
    expect(stepSlot(order, "a", 1)).toBe("b");
    expect(stepSlot(order, "b", 1)).toBe("b");
    expect(stepSlot(order, "a", -1)).toBe(OWN);
    expect(stepSlot(order, OWN, -1)).toBe(OWN);
  });

  it("leaves an empty own draft out unless it's showing", () => {
    expect(slotOrder("a", "", ["a", "b"])).toEqual(["a", "b"]);
    expect(slotOrder(OWN, "", ["a"])).toEqual([OWN, "a"]);
  });

  it("shows the stepper only on an agent draft with others queued", () => {
    expect(stepperPosition("b", ["a", "b", "c"])).toEqual({ index: 2, total: 3 });
    expect(stepperPosition("a", ["a"])).toBeNull();
    expect(stepperPosition(OWN, ["a", "b"])).toBeNull();
  });

  it("names who the waiting drafts are from", () => {
    expect(queueLabel([{ agentName: "Claude Code" }])).toBe("1 draft from Claude Code");
    expect(queueLabel([{ agentName: "Claude Code" }, { agentName: "Claude Code" }])).toBe(
      "2 drafts from Claude Code",
    );
    expect(queueLabel([{ agentName: "Claude Code" }, { agentName: "Cursor" }])).toBe(
      "2 agent drafts",
    );
  });
});

describe("Enter guard", () => {
  it("ignores Enter for a second after a send", () => {
    const until = guardUntil(10_000);
    expect(until).toBe(10_000 + ENTER_GUARD_MS);
    expect(enterBlocked(until, 10_000)).toBe(true);
    expect(enterBlocked(until, 10_999)).toBe(true);
    expect(enterBlocked(until, 11_000)).toBe(false);
    expect(enterBlocked(0, 10_000)).toBe(false);
  });
});

describe("savedOwnDraft", () => {
  const base = { draftsLoaded: true, newRecipientDraft: "", detailDraft: undefined };

  it("takes a conversation's draft from its details once they arrive", () => {
    expect(savedOwnDraft({ ...base, newRecipient: false })).toBeUndefined();
    expect(savedOwnDraft({ ...base, newRecipient: false, detailDraft: null })).toBe("");
    expect(savedOwnDraft({ ...base, newRecipient: false, detailDraft: "Mine" })).toBe("Mine");
  });

  it("takes a new recipient's saved draft from the drafts list", () => {
    const fresh = { ...base, newRecipient: true, newRecipientDraft: "See you there" };
    expect(savedOwnDraft(fresh)).toBe("See you there");
    expect(savedOwnDraft({ ...fresh, newRecipientDraft: "" })).toBe("");
    // Not before the drafts have loaded, so an empty box doesn't count as "no draft".
    expect(savedOwnDraft({ ...fresh, draftsLoaded: false })).toBeUndefined();
  });
});

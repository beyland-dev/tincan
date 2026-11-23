import { describe, expect, it } from "vite-plus/test";
import {
  initialPhase,
  REVEAL_GRACE_MS,
  revealInstant,
  revealNext,
  type RevealEvent,
  type RevealPhase,
} from "../src/renderer/reveal.ts";

function run(start: RevealPhase, events: RevealEvent[], instant = false): RevealPhase[] {
  const seen: RevealPhase[] = [];
  let phase = start;
  for (const event of events) {
    phase = revealNext(phase, event, instant);
    seen.push(phase);
  }
  return seen;
}

describe("reveal phases", () => {
  it("starts settled, with nothing to animate", () => {
    expect(initialPhase(true)).toBe("shown");
    expect(initialPhase(false)).toBe("hidden");
  });

  it("opens from collapsed, then settles", () => {
    expect(run("hidden", ["open", "frame", "done"])).toEqual(["entering", "opening", "shown"]);
  });

  it("closes, staying mounted until the transition ends", () => {
    expect(run("shown", ["close", "done"])).toEqual(["leaving", "hidden"]);
  });

  it("turns around part way", () => {
    expect(run("shown", ["close", "open", "done"])).toEqual(["leaving", "opening", "shown"]);
    expect(run("hidden", ["open", "frame", "close", "done"])).toEqual([
      "entering",
      "opening",
      "leaving",
      "hidden",
    ]);
  });

  it("ignores repeats and stray events", () => {
    expect(revealNext("shown", "open")).toBe("shown");
    expect(revealNext("hidden", "close")).toBe("hidden");
    expect(revealNext("shown", "done")).toBe("shown");
    expect(revealNext("leaving", "frame")).toBe("leaving");
  });

  it("changes at once when instant", () => {
    expect(run("hidden", ["open"], true)).toEqual(["shown"]);
    expect(run("opening", ["close"], true)).toEqual(["hidden"]);
  });
});

describe("revealInstant", () => {
  it("skips the slide with reduced motion or just after mounting", () => {
    expect(revealInstant(true, 0, 10_000)).toBe(true);
    expect(revealInstant(false, 1_000, 1_000 + REVEAL_GRACE_MS - 1)).toBe(true);
    expect(revealInstant(false, 1_000, 1_000 + REVEAL_GRACE_MS)).toBe(false);
  });
});

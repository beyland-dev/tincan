import { describe, expect, it } from "vite-plus/test";
import {
  draftAge,
  scheduledAnnouncement,
  scheduledLine,
  secondsLeft,
  shortDuration,
  spokenDuration,
} from "../src/renderer/countdown.ts";

describe("countdown", () => {
  it("rounds up, and never goes below zero", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 1)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });

  it("formats short and long delays", () => {
    expect(shortDuration(8)).toBe("8s");
    expect(shortDuration(60)).toBe("1m");
    expect(shortDuration(65)).toBe("1m 05s");
    expect(spokenDuration(1)).toBe("1 second");
    expect(spokenDuration(10)).toBe("10 seconds");
    expect(spokenDuration(65)).toBe("1 minute 5 seconds");
    expect(spokenDuration(120)).toBe("2 minutes");
  });

  it("says who's sending", () => {
    expect(scheduledLine(8)).toBe("Sending in 8s");
    expect(scheduledLine(8, "Claude Code")).toBe("Claude Code is sending in 8s");
    expect(scheduledLine(0)).toBe("Sending…");
    expect(scheduledLine(null)).toBe("Waiting to send");
  });

  it("announces how to undo", () => {
    expect(scheduledAnnouncement("Ada", 10)).toBe(
      "Sending to Ada in 10 seconds. Press Control Shift Z to undo.",
    );
    expect(scheduledAnnouncement("Ada", 10, "Claude Code")).toMatch(
      /^Claude Code is sending a message to Ada in 10 seconds\./,
    );
  });
});

describe("draftAge", () => {
  const HOUR = 3_600_000;
  it("says nothing for a fresh draft", () => {
    expect(draftAge(0, 59 * 60_000)).toBeNull();
  });

  it("shows hours, then days", () => {
    expect(draftAge(0, HOUR)).toBe("1 h");
    expect(draftAge(0, 23 * HOUR)).toBe("23 h");
    expect(draftAge(0, 72 * HOUR)).toBe("3 d");
  });
});

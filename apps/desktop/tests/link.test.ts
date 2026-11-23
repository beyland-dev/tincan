import { describe, expect, it } from "vite-plus/test";
import {
  caughtUp,
  formatDuration,
  formatRange,
  gapBreaks,
  linkSpans,
  times,
  type LinkEvent,
  type Span,
} from "../src/renderer/link.ts";

const MIN = 60_000;
const T0 = new Date(2025, 4, 6, 9, 0).getTime();

function phone(at: number, state: LinkEvent["state"]): LinkEvent {
  return { at, kind: "phone", state } as LinkEvent;
}

describe("linkSpans", () => {
  it("turns phone events into merged connected and disconnected stretches", () => {
    const events = [
      phone(T0, "connecting"),
      phone(T0 + 1 * MIN, "connected"),
      { at: T0 + 2 * MIN, kind: "adapter", state: "on" } as LinkEvent,
      phone(T0 + 30 * MIN, "disconnected"),
      phone(T0 + 31 * MIN, "connecting"),
      phone(T0 + 50 * MIN, "connected"),
    ];
    expect(linkSpans(events, T0 + 60 * MIN)).toEqual([
      { from: T0, to: T0 + MIN, on: false },
      { from: T0 + MIN, to: T0 + 30 * MIN, on: true },
      { from: T0 + 30 * MIN, to: T0 + 50 * MIN, on: false },
      { from: T0 + 50 * MIN, to: T0 + 60 * MIN, on: true, open: true },
    ]);
  });

  it("folds away blips but keeps the stretch running up to now", () => {
    const events = [
      phone(T0 - 10_000, "connecting"),
      phone(T0, "connected"),
      phone(T0 + 10 * MIN, "disconnected"),
      phone(T0 + 10 * MIN + 20_000, "connected"),
      phone(T0 + 20 * MIN, "disconnected"),
    ];
    expect(linkSpans(events, T0 + 20 * MIN + 5_000)).toEqual([
      { from: T0, to: T0 + 20 * MIN, on: true },
      { from: T0 + 20 * MIN, to: T0 + 20 * MIN + 5_000, on: false, open: true },
    ]);
  });

  it("reports nothing before the first event", () => {
    expect(linkSpans([], T0)).toEqual([]);
  });
});

describe("gapBreaks", () => {
  const gap = (from: number, to: number): Span => ({ from: T0 + from, to: T0 + to, on: false });
  const on = (from: number, to: number): Span => ({ from: T0 + from, to: T0 + to, on: true });

  it("places each gap before the first newer message and groups gaps between the same two", () => {
    const messages = [T0 + 10, T0 + 50, T0 + 100];
    const spans = [on(0, 20), gap(20, 30), on(30, 35), gap(35, 40), on(40, 60), gap(60, 70)];
    const { before, after } = gapBreaks(messages, spans);
    expect([...before.keys()]).toEqual([1, 2]);
    expect(before.get(1)).toEqual([gap(20, 30), gap(35, 40)]);
    expect(before.get(2)).toEqual([gap(60, 70)]);
    expect(after).toEqual([]);
  });

  it("skips gaps older than the conversation and collects ones after it", () => {
    const { before, after } = gapBreaks([T0 + 50], [gap(0, 10), on(10, 60), gap(60, 70)]);
    expect(before.size).toBe(0);
    expect(after).toEqual([gap(60, 70)]);
  });

  it("counts messages that came in during a gap", () => {
    expect(caughtUp([T0 + 5, T0 + 25, T0 + 31], gap(20, 30))).toBe(1);
  });
});

describe("labels", () => {
  it("formats durations", () => {
    expect(formatDuration(10_000)).toBe("1 min");
    expect(formatDuration(52 * MIN)).toBe("52 min");
    expect(formatDuration(72 * MIN)).toBe("1h 12m");
    expect(formatDuration(120 * MIN)).toBe("2h");
    expect(formatDuration(51 * 60 * MIN)).toBe("2d 3h");
  });

  it("counts repeats", () => {
    expect(times(2)).toBe("twice");
    expect(times(4)).toBe("4 times");
  });

  it("names the day only when it isn't today", () => {
    const today = formatRange(T0, T0 + 40 * MIN, T0 + 60 * MIN);
    expect(today).not.toMatch(/Yesterday/);
    expect(formatRange(T0, T0 + 40 * MIN, T0 + 24 * 60 * MIN)).toMatch(/^Yesterday /);
    expect(formatRange(T0 - 12 * 60 * MIN, T0, T0)).toMatch(/^Yesterday .+ – .+/);
  });
});

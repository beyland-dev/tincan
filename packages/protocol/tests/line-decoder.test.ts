import { describe, expect, test } from "vite-plus/test";
import { LineDecoder } from "../src/index.ts";

describe("LineDecoder", () => {
  test("splits several lines in one chunk and keeps the remainder", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("a\nb\n\nc")).toEqual(["a", "b"]);
    expect(decoder.push("d\ne\n")).toEqual(["cd", "e"]);
    expect(decoder.push("")).toEqual([]);
  });

  test("rejects a line that grows too long one byte at a time", () => {
    const decoder = new LineDecoder(8);
    for (let i = 0; i < 8; i++) expect(decoder.push("x")).toEqual([]);
    expect(() => decoder.push("x")).toThrow(/exceeds/);
  });

  test("rejects an oversized complete line and an oversized remainder", () => {
    expect(() => new LineDecoder(4).push("12345\n")).toThrow(/exceeds/);
    expect(() => new LineDecoder(4).push("1\n12345")).toThrow(/exceeds/);
  });

  test("stays fast for a long line delivered in tiny chunks", () => {
    const decoder = new LineDecoder();
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) decoder.push("x");
    expect(decoder.push("\n")).toEqual(["x".repeat(200_000)]);
    // The old decoder re-split the whole buffer per chunk: seconds, not milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

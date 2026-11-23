import { describe, expect, it } from "vite-plus/test";
import { sensitiveCopy } from "../src/renderer/sensitive.ts";

describe("sensitiveCopy", () => {
  it("while hidden, names what's there without giving it away", () => {
    expect(sensitiveCopy("Bluetooth address", false)).toEqual({
      tip: "Click to reveal",
      label: "Bluetooth address, hidden. Click to reveal.",
    });
  });

  it("once revealed, offers to hide it and lets the value speak for itself", () => {
    expect(sensitiveCopy("Bluetooth address", true)).toEqual({
      tip: "Click to hide",
      label: undefined,
    });
  });
});

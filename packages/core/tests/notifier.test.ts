import { describe, expect, it } from "vite-plus/test";
import { placeholderText } from "../src/notifier.ts";

describe("placeholderText", () => {
  it("describes attachment and app-item placeholders", () => {
    expect(placeholderText("\uFFFC")).toBe("1 attachment");
    expect(placeholderText("\uFFFC\uFFFC \uFFFC")).toBe("3 attachments");
    expect(placeholderText("\uFFFD")).toBe("Shared a location or Messages app item");
  });

  it("leaves real text alone", () => {
    expect(placeholderText("hello \uFFFC")).toBeNull();
    expect(placeholderText("")).toBeNull();
  });
});

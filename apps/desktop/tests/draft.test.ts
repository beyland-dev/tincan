import { describe, expect, it } from "vite-plus/test";
import { takeDraft } from "../src/renderer/draft.ts";

describe("takeDraft", () => {
  it("takes the first draft into an empty composer", () => {
    expect(takeDraft("", null, "Hello")).toBe("Hello");
  });

  it("keeps text typed before the details arrived", () => {
    expect(takeDraft("On my", null, "Hello")).toBeNull();
  });

  it("takes a new saved draft while the composer is unchanged or empty", () => {
    expect(takeDraft("Hello", "Hello", "Hello again")).toBe("Hello again");
    expect(takeDraft("", "Hello", "Hello again")).toBe("Hello again");
  });

  it("never replaces text the user is typing", () => {
    expect(takeDraft("Hello th", "Hello", "Something else")).toBeNull();
  });

  it("follows the user's own save", () => {
    expect(takeDraft("Hello th", "Hello", "Hello th")).toBe("Hello th");
  });
});

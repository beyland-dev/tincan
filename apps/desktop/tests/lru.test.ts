import { describe, expect, it } from "vite-plus/test";
import { SizedLru } from "../src/shared/lru.ts";

describe("SizedLru", () => {
  it("drops the least recently used entry past the count cap", () => {
    const lru = new SizedLru<number>({ maxEntries: 2, maxSize: 1000 });
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect([...lru.keys()]).toEqual(["a", "c"]);
  });

  it("keeps the total size under its cap, counting resized entries", () => {
    const lru = new SizedLru<string>({ maxEntries: 10, maxSize: 100 });
    lru.set("a", "a", 40);
    lru.set("b", "b", 40);
    lru.set("c", "c");
    lru.resize("c", 40);
    expect([...lru.keys()]).toEqual(["b", "c"]);
    expect(lru.totalSize).toBe(80);
    lru.set("huge", "x", 101);
    expect(lru.has("huge")).toBe(false);
    lru.resize("b", 500);
    expect(lru.has("b")).toBe(false);
    expect(lru.totalSize).toBe(40);
    expect(lru.delete("c")).toBe(true);
    expect(lru.totalSize).toBe(0);
  });
});

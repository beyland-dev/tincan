import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { APP_INDEX, mimeType, resolveAppPath } from "../src/main/protocol.ts";

const root = "/opt/Tincan/resources/app.asar/dist/renderer";

describe("resolveAppPath", () => {
  it("serves the renderer's files", () => {
    expect(resolveAppPath(APP_INDEX, root)).toBe(path.join(root, "index.html"));
    expect(resolveAppPath("app://tincan/", root)).toBe(path.join(root, "index.html"));
    expect(resolveAppPath("app://tincan/assets/index-abc.js?v=1#x", root)).toBe(
      path.join(root, "assets/index-abc.js"),
    );
    expect(resolveAppPath("app://tincan/assets/a%20b.png", root)).toBe(
      path.join(root, "assets/a b.png"),
    );
  });

  it("never leaves the renderer folder", () => {
    for (const url of [
      "app://tincan/../../../etc/passwd",
      "app://tincan/%2e%2e/%2e%2e/etc/passwd.js",
      "app://tincan/assets/%2E%2E%2Fsecret.js",
      "app://tincan/assets/..%2f..%2fmain.mjs",
      "app://tincan/assets/..%5c..%5cmain.js",
      "app://tincan/assets/%252e%252e/x.txt.exe",
      "app://tincan/index.html%00.js",
      "app://tincan/%E0%A4%A.js",
    ]) {
      const file = resolveAppPath(url, root);
      if (file !== null) expect(file.startsWith(`${root}/`), url).toBe(true);
    }
    expect(resolveAppPath("app://tincan/assets/..%2fmain.mjs", root)).toBeNull();
    expect(resolveAppPath("app://tincan/index.html%00.js", root)).toBeNull();
  });

  it("only answers for app://tincan and file types the renderer ships", () => {
    expect(resolveAppPath("app://other/index.html", root)).toBeNull();
    expect(resolveAppPath("app://tincan:8080/index.html", root)).toBeNull();
    expect(resolveAppPath("file:///etc/passwd", root)).toBeNull();
    expect(resolveAppPath("https://tincan/index.html", root)).toBeNull();
    expect(resolveAppPath("app://tincan/main.mjs.exe", root)).toBeNull();
    expect(resolveAppPath("app://tincan/notes", root)).toBeNull();
  });
});

describe("mimeType", () => {
  it("names the renderer's file types", () => {
    expect(mimeType("index.html")).toMatch(/^text\/html/);
    expect(mimeType("a.JS")).toMatch(/^text\/javascript/);
    expect(mimeType("a.css")).toMatch(/^text\/css/);
    expect(mimeType("a.png")).toBe("image/png");
    expect(mimeType("a.woff2")).toBe("font/woff2");
    expect(mimeType("a.exe")).toBeNull();
  });
});

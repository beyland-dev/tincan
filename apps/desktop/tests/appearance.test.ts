import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  isTheme,
  overlayFor,
  readPreferences,
  TITLEBAR_HEIGHT,
  writePreferences,
} from "../src/main/appearance.ts";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tincan-prefs-"));
  dirs.push(dir);
  return path.join(dir, "nested", "preferences.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appearance", () => {
  test("isTheme accepts only the three themes", () => {
    expect(["system", "light", "dark"].every(isTheme)).toBe(true);
    expect(isTheme("auto")).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  test("the window controls overlay is transparent and follows the theme", () => {
    const light = overlayFor(false);
    const dark = overlayFor(true);
    expect(light.color).toBe("#00000000");
    expect(light.height).toBe(TITLEBAR_HEIGHT);
    expect(light.symbolColor).not.toBe(dark.symbolColor);
  });

  test("preferences round-trip and fall back to the defaults, with network features off", () => {
    const file = tempFile();
    const defaults = { theme: "system", linkPreviews: false, spellcheck: false };
    expect(readPreferences(file)).toEqual(defaults);
    writePreferences(file, { theme: "dark", linkPreviews: true, spellcheck: true });
    expect(readPreferences(file)).toEqual({ theme: "dark", linkPreviews: true, spellcheck: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, "{not json");
    expect(readPreferences(file)).toEqual(defaults);
    writeFileSync(file, JSON.stringify({ theme: "sepia", linkPreviews: "yes", spellcheck: 1 }));
    expect(readPreferences(file)).toEqual(defaults);
    expect(readFileSync(file, "utf8")).toContain("sepia");
  });

  test("a missing key means off, and an explicit choice from an older file is kept", () => {
    const file = tempFile();
    writePreferences(file, { theme: "system", linkPreviews: false, spellcheck: false });
    writeFileSync(file, JSON.stringify({ theme: "light" }));
    expect(readPreferences(file)).toEqual({
      theme: "light",
      linkPreviews: false,
      spellcheck: false,
    });
    writeFileSync(file, JSON.stringify({ theme: "light", linkPreviews: true }));
    expect(readPreferences(file)).toEqual({
      theme: "light",
      linkPreviews: true,
      spellcheck: false,
    });
  });
});

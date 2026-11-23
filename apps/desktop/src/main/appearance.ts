import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { THEMES, type Theme } from "../shared/bridge.ts";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * The window controls drawn over the custom titlebar. Transparent so the app's header shows
 * through; the symbols follow the theme.
 */
export function overlayFor(dark: boolean): { color: string; symbolColor: string; height: number } {
  return { color: "#00000000", symbolColor: dark ? "#c7c7cc" : "#3a3a3c", height: TITLEBAR_HEIGHT };
}

export const TITLEBAR_HEIGHT = 48;

/** The desktop app's own preferences, kept beside Electron's data rather than in the daemon. */
export interface Preferences {
  theme: Theme;
  /**
   * Fetch previews of links in messages. Off unless the user turns it on: fetching a link tells
   * whoever runs the site this computer's IP address and when the message was read.
   */
  linkPreviews: boolean;
  /**
   * Chromium's spell checker. Off unless the user turns it on: on Linux it downloads its Hunspell
   * dictionary from Google the first time.
   */
  spellcheck: boolean;
}

/** A key that's missing (an older file, or one never written) means the default: off. */
const DEFAULTS: Preferences = { theme: "system", linkPreviews: false, spellcheck: false };

export function readPreferences(file: string): Preferences {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object") {
      const { theme, linkPreviews, spellcheck } = raw as Record<string, unknown>;
      return {
        theme: isTheme(theme) ? theme : DEFAULTS.theme,
        linkPreviews: typeof linkPreviews === "boolean" ? linkPreviews : DEFAULTS.linkPreviews,
        spellcheck: typeof spellcheck === "boolean" ? spellcheck : DEFAULTS.spellcheck,
      };
    }
  } catch {
    // Missing or unreadable: use the defaults.
  }
  return { ...DEFAULTS };
}

export function writePreferences(file: string, preferences: Preferences): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

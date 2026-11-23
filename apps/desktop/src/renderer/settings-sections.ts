import {
  effectiveAgents,
  type AgentAccess,
  type Device,
  type Settings,
} from "@beyland/tincan-protocol";

/**
 * Settings' sections: their order and names, moving between them with the keyboard, and the live
 * status the sidebar shows beside two of them (a dot for the iPhone, a pill for the agent level).
 */

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "messages", label: "Messages & Privacy" },
  { id: "iphone", label: "iPhone" },
  { id: "agents", label: "AI agents" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SECTION: SettingsSection = "general";

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

/**
 * The section a key moves to from `current` in the section list: the arrows step through it
 * (either axis, so the vertical sidebar and the narrow window's tab bar both work) and wrap,
 * Home and End jump to the ends. Null for any other key.
 */
export function sectionForKey(current: SettingsSection, key: string): SettingsSection | null {
  const ids = SETTINGS_SECTIONS.map((s) => s.id);
  const at = ids.indexOf(current);
  const last = ids.length - 1;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return ids[at === last ? 0 : at + 1] ?? null;
    case "ArrowUp":
    case "ArrowLeft":
      return ids[at <= 0 ? last : at - 1] ?? null;
    case "Home":
      return ids[0] ?? null;
    case "End":
      return ids[last] ?? null;
    default:
      return null;
  }
}

export type PhoneTone = "ok" | "warn" | "off";

/**
 * The iPhone item's dot: green once it's connected and sharing messages, amber while it connects
 * or when it's connected but blocking messages, grey with no iPhone, or one that's away or that
 * the user disconnected.
 */
export function phoneTone(
  phone: { state: Device["state"]; device: Pick<Device, "paused" | "profiles"> | null } | undefined,
): PhoneTone {
  const device = phone?.device;
  if (!phone || !device || phone.state === "unpaired" || device.paused) return "off";
  const map = device.profiles.map;
  if (map === "refused" || map === "denied") return "warn";
  if (phone.state === "connected") return map === "ready" ? "ok" : "warn";
  return phone.state === "connecting" ? "warn" : "off";
}

/** What the dot means, for screen readers. */
export const PHONE_TONE_LABEL: Record<PhoneTone, string> = {
  ok: "connected",
  warn: "needs attention",
  off: "not connected",
};

const LEVEL_PILL: Record<AgentAccess, string> = {
  off: "Off",
  readOnly: "Read only",
  assistant: "Assistant",
  full: "Full",
};

/** The AI agents item's pill: the access level in a word or two; null until settings load. */
export function agentLevelPill(
  settings: Pick<Settings, "agents"> | null | undefined,
): string | null {
  if (!settings) return null;
  return LEVEL_PILL[effectiveAgents(settings.agents).access];
}

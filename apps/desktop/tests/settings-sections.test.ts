import { DEFAULT_SETTINGS, type AgentAccess, type Device } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  agentLevelPill,
  DEFAULT_SECTION,
  isSettingsSection,
  phoneTone,
  sectionForKey,
  SETTINGS_SECTIONS,
} from "../src/renderer/settings-sections.ts";

describe("sections", () => {
  it("come in the sidebar's order, General first", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      "General",
      "Messages & Privacy",
      "iPhone",
      "AI agents",
    ]);
    expect(DEFAULT_SECTION).toBe("general");
  });

  it("recognises only real section ids", () => {
    expect(isSettingsSection("iphone")).toBe(true);
    expect(isSettingsSection("privacy")).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });
});

describe("sectionForKey", () => {
  it("steps with the arrows on either axis, wrapping at the ends", () => {
    expect(sectionForKey("general", "ArrowDown")).toBe("messages");
    expect(sectionForKey("general", "ArrowRight")).toBe("messages");
    expect(sectionForKey("messages", "ArrowUp")).toBe("general");
    expect(sectionForKey("messages", "ArrowLeft")).toBe("general");
    expect(sectionForKey("agents", "ArrowDown")).toBe("general");
    expect(sectionForKey("general", "ArrowUp")).toBe("agents");
  });

  it("jumps to the ends with Home and End", () => {
    expect(sectionForKey("iphone", "Home")).toBe("general");
    expect(sectionForKey("messages", "End")).toBe("agents");
  });

  it("ignores other keys", () => {
    expect(sectionForKey("iphone", "Enter")).toBeNull();
    expect(sectionForKey("iphone", "a")).toBeNull();
  });
});

describe("phoneTone", () => {
  const device = (change: Partial<Device["profiles"]> = {}, paused?: boolean) => ({
    paused,
    profiles: { map: "ready", pbap: "ready", ancs: "ready", ...change } as Device["profiles"],
  });

  it("is grey with no iPhone", () => {
    expect(phoneTone(undefined)).toBe("off");
    expect(phoneTone({ state: "unpaired", device: null })).toBe("off");
  });

  it("is green once connected and sharing messages", () => {
    expect(phoneTone({ state: "connected", device: device() })).toBe("ok");
  });

  it("is amber while connecting, or when messages are blocked", () => {
    expect(phoneTone({ state: "connecting", device: device({ map: "connecting" }) })).toBe("warn");
    expect(phoneTone({ state: "connected", device: device({ map: "connecting" }) })).toBe("warn");
    expect(phoneTone({ state: "connected", device: device({ map: "refused" }) })).toBe("warn");
    expect(phoneTone({ state: "disconnected", device: device({ map: "denied" }) })).toBe("warn");
  });

  it("is grey when it's away or the user disconnected it", () => {
    expect(phoneTone({ state: "disconnected", device: device({ map: "idle" }) })).toBe("off");
    expect(phoneTone({ state: "connected", device: device({}, true) })).toBe("off");
    expect(phoneTone({ state: "disconnected", device: device({ map: "refused" }, true) })).toBe(
      "off",
    );
  });
});

describe("agentLevelPill", () => {
  const at = (access: AgentAccess) => ({ agents: { ...DEFAULT_SETTINGS.agents, access } });

  it("names the access level in a word or two", () => {
    expect(agentLevelPill(at("off"))).toBe("Off");
    expect(agentLevelPill(at("readOnly"))).toBe("Read only");
    expect(agentLevelPill(at("assistant"))).toBe("Assistant");
    expect(agentLevelPill(at("full"))).toBe("Full");
  });

  it("is empty until settings load", () => {
    expect(agentLevelPill(null)).toBeNull();
    expect(agentLevelPill(undefined)).toBeNull();
  });
});

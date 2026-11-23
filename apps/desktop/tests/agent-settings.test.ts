import {
  accessPatch,
  DEFAULT_SETTINGS,
  effectiveAgents,
  type AgentAccess,
  type Settings,
} from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  ACCESS_OPTIONS,
  agentDelayHint,
  agentSummary,
  delayOptions,
  ownDelayHint,
  confirmCopy,
  confirmFor,
  parseSendLimitValue,
  readHint,
  readOptions,
  sectionsFor,
  sendHint,
  sendLimitHint,
  sendLimitOptions,
  sendLimitValue,
  sendOptions,
} from "../src/renderer/agent-settings.ts";

type Agents = Settings["agents"];

function agents(change: Partial<Agents> = {}): Agents {
  return { ...DEFAULT_SETTINGS.agents, ...change };
}

/** The settings after picking a level, as the desktop does. */
function pick(access: AgentAccess, from: Agents = agents()): Agents {
  return { ...from, ...accessPatch(access, from) } as Agents;
}

const values = <T>(options: Array<[T, string, string]>) => options.map(([value]) => value);

describe("sections and options", () => {
  it("lists the levels in order", () => {
    expect(ACCESS_OPTIONS.map(([value]) => value)).toEqual([
      "off",
      "readOnly",
      "assistant",
      "full",
    ]);
  });

  it("shows nothing while off", () => {
    expect(sectionsFor("off")).toEqual({
      read: false,
      send: false,
      sendLimit: false,
      inbox: false,
      danger: false,
    });
    expect(readOptions("off")).toEqual([]);
    expect(sendOptions(effectiveAgents(agents()))).toEqual([]);
  });

  it("shows only reading under Read only, without Off", () => {
    expect(sectionsFor("readOnly")).toEqual({
      read: true,
      send: false,
      sendLimit: false,
      inbox: false,
      danger: false,
    });
    expect(values(readOptions("readOnly"))).toEqual(["contacts", "known", "all"]);
    expect(sendOptions(effectiveAgents(pick("readOnly")))).toEqual([]);
  });

  it("shows reading with Off, sending without Never, the send limit and inbox actions under Assistant", () => {
    expect(sectionsFor("assistant")).toEqual({
      read: true,
      send: true,
      sendLimit: true,
      inbox: true,
      danger: false,
    });
    expect(values(readOptions("assistant"))).toEqual(["off", "contacts", "known", "all"]);
    expect(values(sendOptions(effectiveAgents(pick("assistant"))))).toEqual([
      "approve",
      "replied",
      "always",
    ]);
  });

  it("puts privacy in Danger under Full access, with no send limit", () => {
    expect(sectionsFor("full")).toEqual({
      read: true,
      send: true,
      sendLimit: false,
      inbox: true,
      danger: true,
    });
    expect(values(readOptions("full"))).toEqual(["off", "contacts", "known", "all"]);
    expect(values(sendOptions(effectiveAgents(pick("full"))))).toEqual([
      "approve",
      "replied",
      "always",
    ]);
  });

  it("describes Always by what still holds at each level", () => {
    const always = (a: Agents) => sendOptions(effectiveAgents(a)).find(([v]) => v === "always")![2];
    expect(always(agents({ access: "assistant", sendLimit: 10 }))).toMatch(/up to the send limit/);
    expect(always(agents({ access: "assistant", sendLimit: null }))).not.toMatch(/limit/);
    expect(always(agents({ access: "assistant" }))).toMatch(/hidden become drafts for you/);
    expect(always(agents({ access: "full" }))).toBe("Messages send without asking.");
  });
});

describe("row descriptions", () => {
  const hidden = "Tincan hides phone numbers, emails and verification codes from agents.";

  it("says what the picked reading means, and what Tincan hides", () => {
    expect(readHint(effectiveAgents(pick("readOnly")))).toBe(
      `Agents can read conversations with your contacts and people you've replied to. ${hidden}`,
    );
    expect(readHint(effectiveAgents(agents({ access: "assistant", read: "contacts" })))).toBe(
      `Agents can read conversations with your contacts. ${hidden}`,
    );
  });

  it("keeps saying it under Assistant, which can't turn the protections off", () => {
    const assistant = agents({ access: "assistant", handles: "visible", hideCodes: false });
    expect(readHint(effectiveAgents(assistant))).toMatch(new RegExp(`${hidden}$`));
  });

  it("says what Full access shows agents", () => {
    const full = pick("full");
    expect(readHint(effectiveAgents(full))).toMatch(new RegExp(`${hidden}$`));
    expect(readHint(effectiveAgents({ ...full, handles: "visible" }))).toMatch(
      / Agents also see phone numbers and emails; Tincan still hides verification codes\.$/,
    );
    expect(readHint(effectiveAgents({ ...full, hideCodes: false }))).toMatch(
      / Agents also see verification codes; Tincan still hides phone numbers and emails\.$/,
    );
    expect(readHint(effectiveAgents({ ...full, handles: "visible", hideCodes: false }))).toMatch(
      / Agents also see phone numbers, emails and verification codes\.$/,
    );
  });

  it("explains that reading off still lets agents send", () => {
    expect(readHint(effectiveAgents(agents({ access: "assistant", read: "off" })))).toBe(
      "Agents can't read your messages or contacts. They can still send, as set below.",
    );
  });

  it("says what the picked sending choice means at each level", () => {
    expect(sendHint(effectiveAgents(pick("assistant")))).toBe(
      "Each message waits in its conversation as a draft for you to send, edit or discard.",
    );
    expect(sendHint(effectiveAgents(agents({ access: "assistant", send: "always" })))).toMatch(
      /up to the send limit/,
    );
    expect(sendHint(effectiveAgents(pick("full")))).toBe("Messages send without asking.");
    expect(sendHint(effectiveAgents(pick("readOnly")))).toBe("");
  });
});

describe("agentSummary", () => {
  it("says in one line what each level allows", () => {
    expect(agentSummary(agents())).toBe(
      "Agents can't see or send your messages. They can only check that Tincan is running and what access you've given them.",
    );
    expect(agentSummary(agents({ access: "readOnly", send: "always" }))).toBe(
      "Agents can read your messages and contacts, but can't send or change anything.",
    );
    expect(agentSummary(pick("assistant"))).toMatch(/privacy protections always on/);
    expect(agentSummary(pick("full"))).toMatch(/can be turned off/);
  });
});

describe("send delays", () => {
  it("offers Off and the usual steps", () => {
    expect(delayOptions(10)).toEqual([
      ["0", "Off"],
      ["3", "3s"],
      ["5", "5s"],
      ["10", "10s"],
      ["20", "20s"],
      ["30", "30s"],
      ["60", "60s"],
    ]);
  });

  it("keeps a value set from the CLI in order", () => {
    const values = delayOptions(45).map(([v]) => v);
    expect(values).toEqual(["0", "3", "5", "10", "20", "30", "45", "60"]);
    expect(delayOptions(undefined)).toHaveLength(7);
  });

  it("says when there's no time to undo", () => {
    expect(ownDelayHint(0)).toMatch(/as soon as you press Send/);
    expect(ownDelayHint(5)).toMatch(/for 5 seconds/);
    expect(agentDelayHint(0)).toMatch(/no time to undo/);
    expect(agentDelayHint(10)).toMatch(/Gives you time to undo/);
  });
});

describe("confirmFor", () => {
  const assistant = pick("assistant");

  it("asks before Full access, from any level", () => {
    for (const from of ["off", "readOnly", "assistant"] as const) {
      const start = agents({ access: from });
      expect(confirmFor(start, accessPatch("full", start)), from).toBe("full");
    }
  });

  it("doesn't ask again for changes under Full access", () => {
    const full = pick("full");
    expect(confirmFor(full, { send: "approve" })).toBeNull();
    expect(confirmFor({ ...full, send: "approve" }, { send: "always" })).toBeNull();
    expect(confirmFor(full, { handles: "visible" })).toBeNull();
  });

  it("asks before sending without asking under Assistant", () => {
    expect(confirmFor(assistant, { send: "always" })).toBe("sendAlways");
  });

  it("asks when coming back to Assistant with Always still stored", () => {
    const readOnly = agents({ access: "readOnly", send: "always" });
    expect(confirmFor(readOnly, { access: "assistant" })).toBe("sendAlways");
  });

  it("lets everything else through", () => {
    expect(confirmFor(assistant, accessPatch("readOnly", assistant))).toBeNull();
    expect(confirmFor(assistant, { read: "all" })).toBeNull();
    expect(confirmFor(assistant, { send: "replied" })).toBeNull();
    const always = agents({ access: "assistant", send: "always" });
    expect(confirmFor(always, { sendLimit: 20 })).toBeNull();
    expect(confirmFor(always, { sendLimit: null })).toBeNull();
    expect(confirmFor(always, { send: "approve" })).toBeNull();
    expect(confirmFor(assistant, accessPatch("off", assistant))).toBeNull();
    expect(confirmFor(agents(), accessPatch("readOnly", agents()))).toBeNull();
    expect(confirmFor(agents(), accessPatch("assistant", agents()))).toBeNull();
  });
});

describe("confirmCopy", () => {
  it("promises no guards for Full access", () => {
    const full = confirmCopy("full", agents(), accessPatch("full", agents()));
    expect(full.title).toBe("Give AI agents full access?");
    expect(full.action).toBe("Allow full access");
    expect(full.body).toEqual([
      "Agents will be able to read every conversation, including texts from strangers, and send messages to anyone without asking you.",
      "Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it.",
    ]);
    expect(full.body.join(" ")).not.toMatch(/hidden|capped|limit/);
  });

  it("names the send limit Always will have under Assistant", () => {
    const send = confirmCopy("sendAlways", agents({ access: "assistant", sendLimit: 12 }), {
      send: "always",
    });
    expect(send.title).toBe("Let agents send without asking?");
    expect(send.body[1]).toBe(
      "Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it.",
    );
    expect(send.body.at(-1)).toMatch(/capped at 12 every 10 minutes/);
  });

  it("doesn't promise a cap when there's no send limit", () => {
    const send = confirmCopy("sendAlways", agents({ access: "assistant", sendLimit: null }), {
      send: "always",
    });
    expect(send.body.join(" ")).not.toMatch(/capped/);
    expect(send.body.at(-1)).toMatch(/no limit on how many messages/);
    const patched = confirmCopy("sendAlways", agents({ access: "assistant" }), {
      send: "always",
      sendLimit: null,
    });
    expect(patched.body.at(-1)).toMatch(/no limit/);
  });
});

describe("sendLimitOptions", () => {
  it("offers No limit and the usual steps", () => {
    expect(sendLimitOptions(10)).toEqual([
      ["none", "No limit"],
      ["5", "5"],
      ["10", "10"],
      ["20", "20"],
      ["30", "30"],
      ["60", "60"],
    ]);
    expect(sendLimitOptions(null).map(([value]) => value)).toEqual([
      "none",
      "5",
      "10",
      "20",
      "30",
      "60",
    ]);
  });

  it("keeps a limit set some other way as its own option", () => {
    expect(sendLimitOptions(25).map(([value]) => value)).toEqual([
      "none",
      "5",
      "10",
      "20",
      "25",
      "30",
      "60",
    ]);
    expect(sendLimitOptions(1)[1]).toEqual(["1", "1"]);
  });
});

describe("send limit values", () => {
  it("round-trips through the dropdown, with null as No limit", () => {
    for (const limit of [null, 1, 10, 25, 60]) {
      expect(parseSendLimitValue(sendLimitValue(limit))).toBe(limit);
    }
    expect(sendLimitValue(null)).toBe("none");
  });
});

describe("sendLimitHint", () => {
  it("says per 10 minutes, or that there's no limit", () => {
    expect(sendLimitHint(10)).toMatch(/per 10 minutes/);
    expect(sendLimitHint(null)).toMatch(/any number/);
  });
});

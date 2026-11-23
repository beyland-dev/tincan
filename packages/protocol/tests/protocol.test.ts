import { describe, expect, test } from "vite-plus/test";
import {
  accessPatch,
  contracts,
  DEFAULT_SETTINGS,
  describeContracts,
  effectiveAgents,
  getContract,
  groupNameKey,
  Handle,
  LineDecoder,
  AgentDraft,
  AgentDraftView,
  Message,
  SendDelaySeconds,
  Settings,
  TincanError,
  type AnyContract,
  protocolSchema,
  Request,
  ServerMessage,
  slugify,
  ThreadKey,
  toWireError,
} from "../src/index.ts";

describe("contracts", () => {
  test("names are unique and dotted lowercase", () => {
    const names = contracts.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(\.[a-zA-Z]+)*$/);
  });

  test("describe hides internal contracts unless asked", () => {
    const visible = describeContracts().map((d) => d.name);
    expect(visible).not.toContain("settings.set");
    expect(describeContracts({ includeInternal: true }).map((d) => d.name)).toContain(
      "settings.set",
    );
  });

  test("descriptors carry JSON Schemas for input and output", () => {
    const status = describeContracts().find((d) => d.name === "status")!;
    expect(status.inputSchema).toMatchObject({ type: "object" });
    expect(status.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["daemon", "native", "phone"]),
    });
    expect(status).toMatchObject({ kind: "query", sensitive: false, approval: "none" });
  });

  test("every agent command with personal data is gated by an agent setting", () => {
    for (const contract of contracts) {
      const c = contract as AnyContract;
      if (c.internal || !c.sensitive) continue;
      const gated = c.agentScope !== undefined || c.approval === "agent";
      expect({ name: c.name, gated }).toEqual({ name: c.name, gated: true });
    }
    const scopes = Object.fromEntries(
      describeContracts()
        .filter((d) => d.agentScope)
        .map((d) => [d.name, d.agentScope]),
    );
    expect(scopes).toMatchObject({
      "thread.list": "read",
      "message.search": "read",
      "message.draft.save": "drafts",
      "thread.markRead": "manage",
      "thread.mute": "manage",
      "thread.pin": "manage",
      "draft.list": "ownDrafts",
      "draft.get": "ownDrafts",
      "draft.discard": "ownDrafts",
    });
    expect(scopes).not.toHaveProperty("sync.now");
    expect(scopes).not.toHaveProperty("contact.sync");
  });

  test("effectiveAgents caps each setting by the access level", () => {
    const stored = {
      ...DEFAULT_SETTINGS.agents,
      read: "off" as const,
      send: "never" as const,
      sendLimit: 25,
      manage: true,
      handles: "visible" as const,
      hideCodes: false,
    };
    const privacyOn = { handles: "hidden", hideCodes: true, guardHidden: true };
    expect(effectiveAgents({ ...stored, access: "off" })).toEqual({
      access: "off",
      read: "off",
      send: "never",
      sendLimit: 25,
      sendDelaySeconds: 10,
      manage: false,
      ...privacyOn,
    });
    // Read only: reading can't be off, and nothing but reading is on whatever is stored.
    expect(effectiveAgents({ ...stored, access: "readOnly" })).toMatchObject({
      read: "known",
      send: "never",
      manage: false,
      ...privacyOn,
    });
    expect(
      effectiveAgents({ ...stored, access: "readOnly", read: "all", send: "always" }),
    ).toMatchObject({ read: "all", send: "never" });
    // Assistant: reading may be off (a send-only assistant); sending can't be. Drafts and inbox
    // actions find conversations by reading, so they're off with it.
    expect(effectiveAgents({ ...stored, access: "assistant" })).toEqual({
      access: "assistant",
      read: "off",
      send: "approve",
      sendLimit: 25,
      sendDelaySeconds: 10,
      manage: false,
      ...privacyOn,
    });
    expect(effectiveAgents({ ...stored, access: "assistant", read: "contacts" })).toMatchObject({
      manage: true,
    });
    expect(
      effectiveAgents({ ...stored, access: "assistant", send: "always", sendLimit: null }),
    ).toMatchObject({ send: "always", sendLimit: null });
    // Full: as stored, no send limit, no residual guards.
    expect(effectiveAgents({ ...stored, access: "full", read: "all", send: "always" })).toEqual({
      access: "full",
      read: "all",
      send: "always",
      sendLimit: null,
      sendDelaySeconds: 10,
      manage: true,
      handles: "visible",
      hideCodes: false,
      guardHidden: false,
    });
    expect(effectiveAgents({ ...stored, access: "full" }).send).toBe("approve");
  });

  test("effectiveAgents never changes the stored settings", () => {
    const stored = {
      ...DEFAULT_SETTINGS.agents,
      access: "readOnly" as const,
      handles: "visible" as const,
    };
    const copy = structuredClone(stored);
    effectiveAgents(stored);
    expect(stored).toEqual(copy);
  });

  test("accessPatch sets the level and a starting point for what it shows", () => {
    const base = { ...DEFAULT_SETTINGS.agents, handles: "visible" as const, hideCodes: false };
    expect(accessPatch("off", base)).toEqual({ access: "off" });
    expect(accessPatch("readOnly", { ...base, read: "off" })).toEqual({
      access: "readOnly",
      read: "known",
    });
    expect(accessPatch("readOnly", { ...base, read: "all" })).toEqual({
      access: "readOnly",
      read: "all",
    });
    expect(accessPatch("assistant", { ...base, access: "full", send: "always" })).toMatchObject({
      access: "assistant",
      send: "approve",
    });
    expect(
      accessPatch("assistant", { ...base, access: "assistant", send: "replied" }),
    ).toMatchObject({ send: "replied" });
    expect(accessPatch("full", base)).toEqual({
      access: "full",
      read: "all",
      send: "always",
      manage: true,
    });
    // No level's patch touches the privacy options.
    for (const level of ["off", "readOnly", "assistant", "full"] as const) {
      const patch = accessPatch(level, base);
      expect(patch).not.toHaveProperty("handles");
      expect(patch).not.toHaveProperty("hideCodes");
    }
  });

  test("getContract finds by name", () => {
    expect(getContract("version")?.title).toBe("Version");
    expect(getContract("nope")).toBeUndefined();
  });

  test("protocolSchema is serialisable", () => {
    const schema = protocolSchema();
    expect(JSON.parse(JSON.stringify(schema)).commands.length).toBe(contracts.length);
    expect(schema.errorCodes).toContain("BUSY");
    expect(schema.errorCodes).not.toContain("APPROVAL_DENIED");
    expect(schema.events).toHaveProperty("draft.changed");
    expect(schema.events).not.toHaveProperty("approval.requested");
  });
});

describe("entities", () => {
  test("handles and thread keys", () => {
    expect(Handle.safeParse("tel:+15555550123").success).toBe(true);
    expect(Handle.safeParse("email:a@example.com").success).toBe(true);
    expect(Handle.safeParse("+15555550123").success).toBe(false);
    expect(Handle.safeParse("sender:mybank").success).toBe(true);
    expect(Handle.safeParse("sender:my bank").success).toBe(false);
    expect(ThreadKey.safeParse("sender:mybank").success).toBe(true);
    expect(ThreadKey.safeParse("group:members:tel15555550123,tel15555550124").success).toBe(true);
    expect(ThreadKey.safeParse("random").success).toBe(false);
  });

  test("send delays default to off for you and 10 s for agents, and accessPatch never changes them", () => {
    expect(DEFAULT_SETTINGS.sendDelaySeconds).toBe(0);
    expect(DEFAULT_SETTINGS.agents.sendDelaySeconds).toBe(10);
    expect(
      Settings.parse({ ...DEFAULT_SETTINGS, sendDelaySeconds: undefined }).sendDelaySeconds,
    ).toBe(0);
    expect(SendDelaySeconds.safeParse(301).success).toBe(false);
    expect(SendDelaySeconds.safeParse(-1).success).toBe(false);
    for (const access of ["off", "readOnly", "assistant", "full"] as const) {
      expect(accessPatch(access, DEFAULT_SETTINGS.agents)).not.toHaveProperty("sendDelaySeconds");
      const agents = { ...DEFAULT_SETTINGS.agents, access, sendDelaySeconds: 30 };
      expect(effectiveAgents(agents).sendDelaySeconds).toBe(30);
    }
  });

  test("messages can be scheduled and carry agent attribution", () => {
    const message = Message.parse({
      id: "m1",
      threadKey: "tel:+15555550123",
      direction: "outgoing",
      sender: null,
      body: "hi",
      sentAt: 1,
      receivedAt: 1,
      source: "local",
      status: "scheduled",
      read: true,
      sendAt: 10_001,
      agent: { name: "Claude Code", edited: true, via: "user" },
    });
    expect(message.agent).toEqual({ name: "Claude Code", edited: true, via: "user" });
    expect(Message.safeParse({ ...message, approval: "approved" }).data).not.toHaveProperty(
      "approval",
    );
  });

  test("agent drafts", () => {
    const draft = {
      id: "drf_1",
      threadKey: null,
      to: "tel:+15555550123",
      agentName: "Claude Code",
      intent: "draft",
      body: "Lunch at noon?",
      text: "Lunch at 1?",
      edited: true,
      revision: 2,
      state: "queued",
      note: "outOfScope",
      createdAt: 1,
      updatedAt: 2,
      resolvedAt: null,
    };
    expect(AgentDraft.parse(draft)).toEqual(draft);
    // As agents see it: no text, note or message id.
    const { text: _t, note: _n, ...view } = draft;
    expect(AgentDraftView.safeParse(view).success).toBe(true);
    expect(AgentDraft.safeParse({ ...draft, state: "pending" }).success).toBe(false);
  });
});

describe("envelope", () => {
  test("requests need a client", () => {
    expect(Request.safeParse({ id: 1, method: "status" }).success).toBe(false);
    expect(
      Request.safeParse({ id: 1, method: "status", client: { kind: "cli", name: "tincan" } })
        .success,
    ).toBe(true);
  });

  test("server messages parse", () => {
    expect(ServerMessage.safeParse({ id: 1, result: null }).success).toBe(true);
    expect(
      ServerMessage.safeParse({ id: null, error: { code: "INVALID_INPUT", message: "bad" } })
        .success,
    ).toBe(true);
    expect(ServerMessage.safeParse({ event: "thread.changed", seq: 1, data: {} }).success).toBe(
      true,
    );
  });

  test("LineDecoder splits chunks and keeps partial lines", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(":2}\n\n")).toEqual(['{"b":2}']);
  });

  test("LineDecoder decodes UTF-8 split across chunks", () => {
    const decoder = new LineDecoder();
    const bytes = new TextEncoder().encode('"🐦"\n');
    expect(decoder.push(bytes.slice(0, 3))).toEqual([]);
    expect(decoder.push(bytes.slice(3))).toEqual(['"🐦"']);
  });

  test("LineDecoder rejects oversized lines", () => {
    const decoder = new LineDecoder(8);
    expect(() => decoder.push("0123456789")).toThrow(/exceeds/);
  });
});

describe("errors", () => {
  test("round-trip through the wire", () => {
    const wire = new TincanError("BUSY", "MAP is held", { by: "other" }).toWire();
    const back = TincanError.fromWire(wire);
    expect(back).toBeInstanceOf(TincanError);
    expect(back).toMatchObject({ code: "BUSY", message: "MAP is held", details: { by: "other" } });
  });

  test("unknown errors become INTERNAL", () => {
    expect(toWireError(new Error("boom"))).toEqual({ code: "INTERNAL", message: "boom" });
  });
});

describe("group keys", () => {
  test("named groups key on their slug", () => {
    expect(slugify("  Book   Club ")).toBe("book-club");
    expect(groupNameKey("Book Club")).toBe("group:name:book-club");
    expect(ThreadKey.safeParse(groupNameKey("Book Club")).success).toBe(true);
    expect(groupNameKey("  ")).toBeNull();
  });
});

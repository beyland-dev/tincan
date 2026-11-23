import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  accessPatch,
  defineContract,
  TincanError,
  type ClientInfo,
  type TincanEvent,
} from "@beyland/tincan-protocol";
import { CommandRegistry, Core, Store, nodeSqliteDb } from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "test" };
const mcp: ClientInfo = { kind: "mcp", name: "agent" };
const desktop: ClientInfo = { kind: "desktop", name: "tincan-desktop" };

let core: Core;

beforeEach(async () => {
  let t = 1_000;
  core = await Core.open({ version: "1.2.3", now: () => (t += 10) });
});

afterEach(async () => {
  await core.close();
});

async function errorOf(promise: Promise<unknown>): Promise<TincanError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TincanError) return error;
    throw error;
  }
  throw new Error("Expected a TincanError");
}

describe("system commands", () => {
  test("status reports daemon, native and phone", async () => {
    const status = await core.call("status", {}, cli);
    expect(status.daemon).toMatchObject({ version: "1.2.3", protocolVersion: 2, pid: process.pid });
    expect(status.daemon.uptimeMs).toBeGreaterThan(0);
    expect(status.native.loaded).toBe(false);
    expect(status.phone).toEqual({ state: "unpaired", device: null });
  });

  test("phone status follows the device and the attached services", async () => {
    const events: TincanEvent[] = [];
    core.events.subscribe((e) => events.push(e));
    const phone = { address: "aa:bb:cc:dd:ee:01", name: "iPhone", paired: true, connected: false };
    core.setPhone(phone);
    core.setPhone({ ...phone });
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ["device.changed", { address: "AA:BB:CC:DD:EE:01" }],
    ]);
    expect(core.phone).toEqual({
      state: "disconnected",
      device: {
        address: "AA:BB:CC:DD:EE:01",
        name: "iPhone",
        paired: true,
        connected: false,
        state: "disconnected",
        profiles: { map: "unavailable", pbap: "unavailable", ancs: "unavailable" },
      },
    });

    core.setPhone({ ...phone, connected: true });
    const link = { kind: "connecting", attempt: 1 } as const;
    const sync = { status: { link, syncing: false, lastSyncAt: null, lastError: null } };
    core.attach({
      sync: sync as never,
      contacts: { lastSyncAt: null, lastError: { code: "PERMISSION_DENIED", at: 1 } } as never,
      ancs: { state: { kind: "waiting", hint: "Allow" } },
    });
    expect(core.phone.state).toBe("connecting");
    expect(core.phone.device?.profiles).toEqual({
      map: "connecting",
      pbap: "denied",
      ancs: "connecting",
    });

    sync.status = { ...sync.status, link: { kind: "connected", session: "s" } as never };
    expect(core.phone.state).toBe("connected");
    expect(core.phone.device?.profiles.map).toBe("ready");

    const waiting = { kind: "waiting", attempt: 2, delayMs: 2000 } as never;
    const notFound = { code: "NOT_FOUND", at: 2 };
    sync.status = { ...sync.status, link: waiting, lastError: notFound, failures: 2 } as never;
    expect(core.phone.device?.profiles.map).toBe("connecting");
    sync.status = { ...sync.status, failures: 3 } as never;
    expect(core.phone.device?.profiles.map).toBe("refused");

    core.setPhone(null);
    expect(core.phone).toEqual({ state: "unpaired", device: null });
    expect(events.at(-1)?.data).toEqual({ address: "AA:BB:CC:DD:EE:01" });
  });

  test("the connection log records changes once, not repeats", async () => {
    const phone = { address: "aa:bb:cc:dd:ee:01", name: "iPhone", paired: true, connected: true };
    core.setPhone(phone);
    const link = { kind: "connected", session: "s" } as const;
    const sync = {
      status: { link, syncing: false, lastSyncAt: null, lastError: null, failures: 0 },
    };
    core.attach({ sync: sync as never });
    core.events.emit("sync.changed", { state: "connected" });
    core.events.emit("sync.changed", { state: "syncing" });

    const waiting = { kind: "waiting", attempt: 3, delayMs: 2000 } as never;
    const notFound = { code: "NOT_FOUND", at: 2 };
    sync.status = { ...sync.status, link: waiting, lastError: notFound, failures: 3 } as never;
    core.events.emit("sync.changed", { state: "waiting" });
    core.setPhone({ ...phone, connected: false });
    core.setPhone(null);

    const log = await core.call("device.history", {}, cli);
    expect(log.map((e) => [e.kind, e.state, e.code])).toEqual([
      ["phone", "connecting", null],
      ["messages", "unavailable", null],
      ["phone", "connected", null],
      ["messages", "ready", null],
      ["phone", "connecting", null],
      ["messages", "refused", "NOT_FOUND"],
      ["phone", "disconnected", null],
      ["phone", "none", null],
    ]);
    expect(log.every((e) => e.at > 0)).toBe(true);
    expect(log[0]?.address).toBe("AA:BB:CC:DD:EE:01");
    expect(await core.call("device.history", { limit: 2 }, cli)).toEqual(log.slice(-2));
  });

  test("version", async () => {
    expect(await core.call("version", {}, mcp)).toEqual({ version: "1.2.3", protocolVersion: 2 });
  });

  test("commands hides internal commands from agents even when asked", async () => {
    const forCli = await core.call("commands", { includeInternal: true }, cli);
    const forAgent = await core.call("commands", { includeInternal: true }, mcp);
    expect(forCli.map((c) => c.name)).toContain("settings.set");
    expect(forAgent.map((c) => c.name)).not.toContain("settings.set");
  });

  test("settings.set merges, emits settings.changed", async () => {
    const events: TincanEvent[] = [];
    core.events.subscribe((e) => events.push(e));
    const settings = await core.call("settings.set", { agents: { read: "all" } }, desktop);
    expect(settings.agents).toEqual({
      access: "off",
      read: "all",
      send: "approve",
      sendLimit: 10,
      sendDelaySeconds: 10,
      manage: false,
      handles: "hidden",
      hideCodes: true,
    });
    expect(settings.sendDelaySeconds).toBe(0);
    expect(events).toEqual([{ event: "settings.changed", seq: 1, data: settings }]);
  });

  test("a partial settings.set leaves every other field alone", async () => {
    await core.call(
      "settings.set",
      { agents: { handles: "visible", hideCodes: false, sendLimit: 25, manage: true } },
      desktop,
    );
    const settings = await core.call("settings.set", { agents: { read: "known" } }, desktop);
    expect(settings.agents).toMatchObject({
      read: "known",
      handles: "visible",
      hideCodes: false,
      sendLimit: 25,
      manage: true,
    });
    const notified = await core.call("settings.set", { notifications: { preview: "hidden" } }, cli);
    expect(notified.agents).toEqual(settings.agents);
  });

  test("settings.set takes only today's values", async () => {
    for (const agents of [
      { read: "on" },
      { send: "allow" },
      { sendLimit: 0 },
      { sendLimit: 61 },
      { access: "everything" },
      { retired: true },
    ]) {
      const error = await errorOf(core.run("settings.set", { agents }, desktop));
      expect(error.code).toBe("INVALID_INPUT");
    }
    expect(core.settings.agents.read).toBe("known");
    // A client from before access levels gets told what replaced the switch, not a silent no-op.
    const old = await errorOf(core.run("settings.set", { agents: { enabled: true } }, desktop));
    expect(old.code).toBe("INVALID_INPUT");
    expect(old.message).toContain("agents.access");
    expect(core.settings.agents.access).toBe("off");
    // agents.drafts is gone too: drafts follow sending.
    const drafts = await errorOf(core.run("settings.set", { agents: { drafts: true } }, desktop));
    expect(drafts.code).toBe("INVALID_INPUT");
    expect(drafts.message).toContain("agents.drafts was removed");
    // Send delays: 0-300 s, for you and for agents.
    const delays = await core.call(
      "settings.set",
      { sendDelaySeconds: 5, agents: { sendDelaySeconds: 0 } },
      desktop,
    );
    expect(delays).toMatchObject({ sendDelaySeconds: 5, agents: { sendDelaySeconds: 0 } });
    expect((await errorOf(core.run("settings.set", { sendDelaySeconds: 301 }, desktop))).code).toBe(
      "INVALID_INPUT",
    );
    // No send limit is a value of its own.
    const unlimited = await core.call("settings.set", { agents: { sendLimit: null } }, desktop);
    expect(unlimited.agents.sendLimit).toBeNull();
  });

  test("picking an access level never changes the privacy options", async () => {
    await core.call("settings.set", { agents: { handles: "visible", hideCodes: false } }, desktop);
    for (const level of ["full", "assistant", "readOnly", "off"] as const) {
      const patch = accessPatch(level, core.settings.agents);
      const settings = await core.call("settings.set", { agents: patch }, desktop);
      expect(settings.agents).toMatchObject({
        access: level,
        handles: "visible",
        hideCodes: false,
      });
    }
  });

  test("agents cannot change settings", async () => {
    const error = await errorOf(core.call("settings.set", { agents: { read: "all" } }, mcp));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(core.settings.agents.read).toBe("known");
  });

  test("unknown commands are NOT_FOUND", async () => {
    expect((await errorOf(core.run("nope", {}, cli))).code).toBe("NOT_FOUND");
  });

  test("invalid input is INVALID_INPUT", async () => {
    const error = await errorOf(core.run("commands", { includeInternal: "yes" }, cli));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("includeInternal");
  });
});

describe("registry", () => {
  const echo = defineContract({
    name: "test.echo",
    title: "Echo",
    description: "Echo",
    kind: "query",
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string() }),
  });

  test("rejects duplicate implementations", () => {
    const registry = new CommandRegistry().implement(echo, (input) => input);
    expect(() => registry.implement(echo, (input) => input)).toThrow(/Duplicate/);
  });

  test("output that breaks the contract is INTERNAL", async () => {
    const registry = new CommandRegistry().implement(
      echo,
      () => ({ text: 42 }) as unknown as { text: string },
    );
    const error = await errorOf(registry.run("test.echo", { text: "hi" }, { core, client: cli }));
    expect(error.code).toBe("INTERNAL");
  });
});

describe("agent policy", () => {
  const read = defineContract({
    name: "test.read",
    title: "Read",
    description: "Sensitive read",
    kind: "query",
    sensitive: true,
    agentScope: "read",
    input: z.object({}),
    output: z.literal("ok"),
  });
  const draft = defineContract({
    name: "test.draft",
    title: "Draft",
    description: "Saves a draft",
    kind: "mutation",
    agentScope: "drafts",
    input: z.object({}),
    output: z.literal("ok"),
  });
  const manage = defineContract({
    name: "test.manage",
    title: "Manage",
    description: "Mutes",
    kind: "mutation",
    agentScope: "manage",
    input: z.object({}),
    output: z.literal("ok"),
  });
  const send = defineContract({
    name: "test.send",
    title: "Send",
    description: "Needs approval",
    kind: "mutation",
    approval: "agent",
    input: z.object({}),
    output: z.literal("ok"),
  });

  function registry() {
    return new CommandRegistry()
      .implement(read, () => "ok" as const)
      .implement(draft, () => "ok" as const)
      .implement(manage, () => "ok" as const)
      .implement(send, () => "ok" as const);
  }

  test("access off blocks MCP callers but not status or settings.get", async () => {
    const r = registry();
    core.updateSettings({
      agents: { access: "off", read: "all", send: "replied", manage: true },
    });
    expect(await r.run("test.read", {}, { core, client: cli })).toBe("ok");
    for (const name of ["test.read", "test.draft", "test.manage", "test.send"]) {
      const error = await errorOf(r.run(name, {}, { core, client: mcp }));
      expect(error.code).toBe("PERMISSION_DENIED");
      expect(error.message).toContain("agents.access");
    }
    expect((await core.call("settings.get", {}, mcp)).agents.access).toBe("off");
    expect(await core.call("version", {}, mcp)).toMatchObject({ version: "1.2.3" });
  });

  test("scoped reads need agents.read for MCP only", async () => {
    core.updateSettings({ agents: { access: "assistant", read: "off" } });
    const r = registry();
    expect(await r.run("test.read", {}, { core, client: cli })).toBe("ok");
    const error = await errorOf(r.run("test.read", {}, { core, client: mcp }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toContain("agents.read");
    for (const read of ["contacts", "known", "all"] as const) {
      core.updateSettings({ agents: { read } });
      expect(await r.run("test.read", {}, { core, client: mcp })).toBe("ok");
    }
  });

  test("drafts follow sending; conversation management has its own switch", async () => {
    core.updateSettings({ agents: { access: "assistant", read: "all", manage: false } });
    const r = registry();
    expect(await r.run("test.draft", {}, { core, client: mcp })).toBe("ok");
    expect(await r.run("test.manage", {}, { core, client: cli })).toBe("ok");
    const error = await errorOf(r.run("test.manage", {}, { core, client: mcp }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toContain("agents.manage");
    // A stored drafts switch from an older version is gone: drafts still work.
    core.updateSettings({ agents: { drafts: false } as never });
    expect(core.settings.agents).not.toHaveProperty("drafts");
    expect(await r.run("test.draft", {}, { core, client: mcp })).toBe("ok");
    core.updateSettings({ agents: { manage: true } });
    expect(await r.run("test.draft", {}, { core, client: mcp })).toBe("ok");
    expect(await r.run("test.manage", {}, { core, client: mcp })).toBe("ok");
    // Both work on conversations, so they need reading too.
    core.updateSettings({ agents: { read: "off" } });
    expect((await errorOf(r.run("test.draft", {}, { core, client: mcp }))).message).toContain(
      "agents.read",
    );
  });

  test("read only reads, and nothing else whatever is stored", async () => {
    core.updateSettings({
      agents: { access: "readOnly", read: "off", send: "always", manage: true },
    });
    const r = registry();
    // Reading can't be off at this level: a stored `off` reads as `known`.
    expect(await r.run("test.read", {}, { core, client: mcp })).toBe("ok");
    for (const name of ["test.draft", "test.manage", "test.send"]) {
      const error = await errorOf(r.run(name, {}, { core, client: mcp }));
      expect(error.code).toBe("PERMISSION_DENIED");
      expect(error.message).toContain("agents.access");
    }
    // The stored values are kept for when the user picks a level that shows them.
    expect(core.settings.agents).toMatchObject({ send: "always", manage: true });
  });

  test("privacy protections stay on below full access, whatever is stored", async () => {
    core.updateSettings({ agents: { handles: "visible", hideCodes: false } });
    for (const access of ["off", "readOnly", "assistant"] as const) {
      core.updateSettings({ agents: { access } });
      expect({ access, mask: core.maskHandles(mcp), codes: core.hideCodes(mcp) }).toEqual({
        access,
        mask: true,
        codes: true,
      });
    }
    core.updateSettings({ agents: { access: "full" } });
    expect(core.maskHandles(mcp)).toBe(false);
    expect(core.hideCodes(mcp)).toBe(false);
    // Never for the user.
    expect(core.maskHandles(desktop)).toBe(false);
  });

  test("agent-gated commands follow agents.send", async () => {
    const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")));
    core = await Core.open({ version: "1.2.3", store });
    core.updateSettings({ agents: { access: "readOnly" } });
    const r = registry();
    expect(await r.run("test.send", {}, { core, client: desktop })).toBe("ok");
    expect((await errorOf(r.run("test.send", {}, { core, client: mcp }))).code).toBe(
      "PERMISSION_DENIED",
    );
    // An agent-gated command other than message.send just runs once the policy lets agents send;
    // `approve` (or a stored `never` under assistant) is message.send's to turn into a draft.
    core.updateSettings({ agents: { access: "assistant", send: "approve" } });
    expect(await r.run("test.send", {}, { core, client: mcp })).toBe("ok");
    core.updateSettings({ agents: { send: "never" } });
    expect(await r.run("test.send", {}, { core, client: mcp })).toBe("ok");
    core.updateSettings({ agents: { send: "replied" } });
    expect(await r.run("test.send", {}, { core, client: mcp })).toBe("ok");
  });
});

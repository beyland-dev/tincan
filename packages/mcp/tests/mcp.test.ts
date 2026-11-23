import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  contracts,
  DEFAULT_SETTINGS,
  TincanError,
  type TincanEvent,
  type Message,
  type Settings,
  type Thread,
} from "@beyland/tincan-protocol";
import { afterEach, expect, test } from "vite-plus/test";
import {
  createMcpServer,
  GUIDE,
  INSTRUCTIONS,
  toolNameFor,
  UNTRUSTED_NOTE,
  type TincanConnection,
} from "../src/index.ts";

const KEY = "tel:+15551234567";

const message: Message = {
  id: "m1",
  threadKey: KEY,
  direction: "outgoing",
  sender: null,
  body: "On my way",
  sentAt: 1_700_000_000_000,
  receivedAt: 1_700_000_000_000,
  source: "local",
  status: "sent",
  read: true,
  reactions: [],
};

const thread: Thread = {
  key: KEY,
  kind: "direct",
  title: "Alex",
  members: [KEY],
  lastMessage: message,
  unread: 0,
  muted: false,
  pinned: false,
};

type Handler = (params: Record<string, unknown>) => unknown;

/** A daemon stand-in that records calls and can push events. */
class FakeTincan implements TincanConnection {
  settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    agents: { ...DEFAULT_SETTINGS.agents, access: "assistant", read: "off", send: "approve" },
  };
  calls: { method: string; params: unknown }[] = [];
  handlers: Record<string, Handler> = {
    "settings.get": () => this.settings,
    "thread.list": () => [thread],
    "thread.get": () => ({ thread, group: null, draft: null }),
    "message.list": () => [message],
    "message.send": () => ({ outcome: "sent", message }),
    "thread.markRead": () => {
      throw new TincanError("NOT_FOUND", "No such conversation");
    },
  };
  #listeners = new Set<(event: TincanEvent) => void>();
  #seq = 0;

  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) throw new TincanError("INTERNAL", `unexpected ${method}`);
    return handler((params ?? {}) as Record<string, unknown>);
  }

  async subscribe(handler: (event: TincanEvent) => void): Promise<void> {
    this.#listeners.add(handler);
  }

  setRead(read: Settings["agents"]["read"]): void {
    this.setAgents({ read });
  }

  setAccess(access: Settings["agents"]["access"]): void {
    this.setAgents({ access });
  }

  setAgents(patch: Partial<Settings["agents"]>): void {
    this.settings = { ...this.settings, agents: { ...this.settings.agents, ...patch } };
    const event = {
      event: "settings.changed",
      seq: ++this.#seq,
      data: this.settings,
    } as TincanEvent;
    for (const listener of this.#listeners) listener(event);
  }
}

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(tincan: FakeTincan): Promise<Client> {
  const server = await createMcpServer({ client: tincan, version: "1.2.3" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** The result's JSON (or error) text: the last content block, after any untrusted-data note. */
function text(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.at(-1)?.text ?? "";
}

test("exposes every non-internal command as a tool with annotations", async () => {
  const mcp = await connect(new FakeTincan());
  const { tools } = await mcp.listTools();
  const names = tools.map((tool) => tool.name).sort();
  expect(names).toEqual(
    contracts
      .filter((contract) => !contract.internal)
      .map((contract) => toolNameFor(contract.name))
      .sort(),
  );
  expect(names).toContain("message_send");
  expect(names).toContain("message_draft_save");
  expect(names).not.toContain("settings_set");
  expect(names).not.toContain("approval_resolve");
  expect(names).not.toContain("approval_list");
  for (const internal of ["draft_send", "draft_update", "message_cancel", "message_sendNow"]) {
    expect(names).not.toContain(internal);
  }
  for (const name of ["draft_get", "draft_list", "draft_discard"]) expect(names).toContain(name);
  expect(names).not.toContain("thread_delete");
  expect(names).not.toContain("message_delete");
  expect(names).not.toContain("group_delete");

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  expect(byName.get("status")?.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  const send = byName.get("message_send");
  expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect(send?.inputSchema).toMatchObject({ type: "object", required: ["to", "text"] });
  expect(send?.description).toContain("returns at once");
  expect(send?.description).toContain("draft_get");
  expect(send?.description).not.toMatch(/10 minutes|APPROVAL_DENIED/);
  expect(send?.outputSchema).toMatchObject({ type: "object" });
  // Array outputs are wrapped by the SDK on the 2025 protocol, which this client negotiates.
  expect(byName.get("thread_list")?.outputSchema).toMatchObject({
    type: "object",
    properties: { result: { type: "array" } },
  });
});

test("calls the daemon and returns structured results", async () => {
  const tincan = new FakeTincan();
  const mcp = await connect(tincan);
  const result = await mcp.callTool({
    name: "message_send",
    arguments: { to: "Alex", text: "On my way" },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    outcome: "sent",
    message: { id: "m1", status: "sent" },
  });
  expect(JSON.parse(text(result))).toMatchObject({ message: { id: "m1" } });
  expect(tincan.calls.at(-1)).toEqual({
    method: "message.send",
    params: { to: "Alex", text: "On my way" },
  });
});

test("wraps array results (thread.list) as { result } for 2025-protocol clients", async () => {
  const mcp = await connect(new FakeTincan());
  const result = await mcp.callTool({ name: "thread_list", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ result: [thread] });
  expect(JSON.parse(text(result))).toEqual([thread]);
});

test("marks results carrying phone content as untrusted data", async () => {
  const mcp = await connect(new FakeTincan());
  const listed = await mcp.callTool({ name: "thread_list", arguments: {} });
  const blocks = listed.content as { type: string; text: string }[];
  expect(blocks[0]).toEqual({ type: "text", text: UNTRUSTED_NOTE });
  expect(listed._meta).toMatchObject({ "tincan/untrusted": true });
  const { tools } = await mcp.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "thread_list",
    "message_list",
    "contact_get",
    "group_list",
    "draft_list",
    "draft_get",
  ]) {
    expect(byName.get(name)?.description).toContain(UNTRUSTED_NOTE);
  }
  // A send's result is the agent's own message: no note.
  const sent = await mcp.callTool({
    name: "message_send",
    arguments: { to: "Alex", text: "On my way" },
  });
  expect(sent.content).toHaveLength(1);
});

test("never tells agents how to approve their own requests", async () => {
  for (const words of [INSTRUCTIONS, GUIDE]) {
    expect(words).not.toMatch(/approval[ _.]resolve|tincan approval|settings[ _.]set/);
    expect(words).toMatch(/untrusted/i);
    expect(words).toMatch(/group names/);
  }
  const mcp = await connect(new FakeTincan());
  const { tools } = await mcp.listTools();
  const send = tools.find((tool) => tool.name === "message_send");
  expect(send?.description).not.toMatch(/CLI|approval resolve/);
  const { resourceTemplates } = await mcp.listResourceTemplates().catch(() => ({
    resourceTemplates: [],
  }));
  for (const template of resourceTemplates) expect(template.description).not.toContain("tel%3A");
});

test("reports daemon errors as CODE: message", async () => {
  const mcp = await connect(new FakeTincan());
  const result = await mcp.callTool({ name: "thread_markRead", arguments: { key: KEY } });
  expect(result.isError).toBe(true);
  expect(text(result)).toBe("NOT_FOUND: No such conversation");
});

test("rejects invalid input before reaching the daemon", async () => {
  const tincan = new FakeTincan();
  const mcp = await connect(tincan);
  const result = await mcp.callTool({ name: "message_send", arguments: { to: "Alex" } });
  expect(result.isError).toBe(true);
  expect(tincan.calls.some((call) => call.method === "message.send")).toBe(false);
});

test("a queued send returns at once, with the draft that tracks it", async () => {
  const tincan = new FakeTincan();
  const draft = {
    id: "drf_1",
    threadKey: null,
    to: "handle:abc",
    agentName: "test",
    intent: "send",
    body: "On my way",
    edited: false,
    revision: 0,
    state: "queued",
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
  };
  tincan.handlers["message.send"] = () => ({ outcome: "queued", draft });
  const mcp = await connect(tincan);
  const result = await mcp.callTool({
    name: "message_send",
    arguments: { to: "Alex", text: "On my way" },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ outcome: "queued", draft });
});

test("serves the agent guide", async () => {
  const mcp = await connect(new FakeTincan());
  const { resources } = await mcp.listResources();
  expect(resources.map((resource) => resource.uri)).toContain("tincan://guide");
  const result = await mcp.readResource({ uri: "tincan://guide" });
  const first = result.contents[0];
  const guide = first && "text" in first ? first.text : "";
  expect(guide).toContain("# Tincan");
  expect(guide).toContain("10 minutes");
  expect(guide).toContain("untrusted");
});

test("serves conversations only while agents may read", async () => {
  const tincan = new FakeTincan();
  const mcp = await connect(tincan);
  const uris = async () => (await mcp.listResources()).resources.map((resource) => resource.uri);
  const templates = async () =>
    (await mcp.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate);

  expect(await uris()).not.toContain("tincan://threads");
  expect(await templates()).not.toContain("tincan://thread/{key}");
  await expect(mcp.readResource({ uri: "tincan://threads" })).rejects.toThrow();

  tincan.setRead("all");
  expect(await uris()).toContain("tincan://threads");
  expect(await templates()).toContain("tincan://thread/{key}");
  const threads = await mcp.readResource({ uri: "tincan://threads" });
  const first = threads.contents[0];
  const listed = JSON.parse(first && "text" in first ? first.text : "");
  expect(listed).toEqual({ _untrusted: UNTRUSTED_NOTE, data: [thread] });

  const one = await mcp.readResource({ uri: `tincan://thread/${encodeURIComponent(KEY)}` });
  const body = one.contents[0];
  expect(JSON.parse(body && "text" in body ? body.text : "")).toMatchObject({
    _untrusted: UNTRUSTED_NOTE,
    data: { thread: { key: KEY }, messages: [{ id: "m1" }] },
  });
  const [template] = (await mcp.listResourceTemplates()).resourceTemplates;
  expect(template?.description).toContain("handle%3A");
  expect(template?.description).not.toContain("tel%3A");
  expect(tincan.calls).toContainEqual({
    method: "message.list",
    params: { threadKey: KEY, limit: 50 },
  });

  tincan.setRead("off");
  expect(await uris()).not.toContain("tincan://threads");
});

test("starts with conversations available when reading is already on", async () => {
  const tincan = new FakeTincan();
  tincan.settings.agents.read = "all";
  const mcp = await connect(tincan);
  expect((await mcp.listResources()).resources.map((resource) => resource.uri)).toContain(
    "tincan://threads",
  );
});

test("serves conversations for every read scope but off", async () => {
  const tincan = new FakeTincan();
  const mcp = await connect(tincan);
  const uris = async () => (await mcp.listResources()).resources.map((resource) => resource.uri);
  for (const read of ["contacts", "known", "all"] as const) {
    tincan.setRead(read);
    expect(await uris()).toContain("tincan://threads");
    tincan.setRead("off");
    expect(await uris()).not.toContain("tincan://threads");
  }
});

test("message resources follow the access level, not the stored read scope alone", async () => {
  const tincan = new FakeTincan();
  const mcp = await connect(tincan);
  const uris = async () => (await mcp.listResources()).resources.map((resource) => resource.uri);
  // Read only can't read nothing: a stored `off` reads as `known`.
  tincan.setAccess("readOnly");
  expect(await uris()).toContain("tincan://threads");
  tincan.setRead("all");
  tincan.setAccess("off");
  expect(await uris()).not.toContain("tincan://threads");
});

test("the guide and instructions describe today's agent settings", () => {
  for (const key of [
    "agents.access",
    "agents.read",
    "agents.send",
    "agents.sendLimit",
    "agents.sendDelaySeconds",
    "agents.manage",
    "agents.handles",
    "agents.hideCodes",
  ]) {
    expect(GUIDE).toContain(key);
  }
  for (const value of ["`contacts`", "`known`", "`all`", "`replied`", "`always`"]) {
    expect(GUIDE).toContain(value);
  }
  for (const level of ["`off`", "`readOnly`", "`assistant`", "`full`"]) {
    expect(GUIDE).toContain(level);
  }
  expect(GUIDE).not.toMatch(/`allow`|\(`off`\/`on`\)|agents\.enabled|agents\.drafts/);
  for (const words of [INSTRUCTIONS, GUIDE]) {
    expect(words).not.toMatch(/up to 10 minutes|can't be taken back|APPROVAL_DENIED/);
    expect(words).toMatch(/can't be unsent/);
  }
  expect(INSTRUCTIONS).toContain("NOT_FOUND");
});

import {
  DEFAULT_SETTINGS,
  describeContracts,
  type AgentDraft,
  type Contact,
  type Group,
  type Message,
  type Settings,
  type Thread,
} from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import { commandHelp, parseCommandInput } from "../src/args.ts";
import {
  displayHandle,
  formatNumber,
  formatTime,
  formatters,
  PLAIN,
  type FormatContext,
} from "../src/format.ts";

const T = new Date(2025, 5, 15, 9, 5).getTime();

function descriptor(name: string) {
  const found = describeContracts({ includeInternal: true }).find((d) => d.name === name);
  if (!found) throw new Error(name);
  return found;
}

function format(name: string, value: unknown, context: Partial<FormatContext> = {}): string {
  const formatter = formatters[name] as (value: unknown, context: FormatContext) => string;
  return formatter(value, { ...PLAIN, ...context });
}

/** Contact names as `contact.list` gives them to the CLI. */
const people = new Map([
  ["tel:+15550100001", "Ada Lovelace"],
  ["tel:+15550100002", "Grace Hopper"],
]);

const message: Message = {
  id: "m1",
  threadKey: "tel:+15550100001",
  direction: "incoming",
  sender: "tel:+15550100001",
  body: "Lunch\ntomorrow?",
  sentAt: T,
  receivedAt: T + 1000,
  source: "map",
  status: "received",
  read: false,
  reactions: [],
};

describe("boolean flags", () => {
  it("accepts --no-<flag> and shows it in help", async () => {
    const mute = descriptor("thread.mute");
    expect(await parseCommandInput(mute, ["tel:+15550100001"], "/")).toEqual({
      key: "tel:+15550100001",
    });
    expect(await parseCommandInput(mute, ["tel:+15550100001", "--no-muted"], "/")).toEqual({
      key: "tel:+15550100001",
      muted: false,
    });
    expect(commandHelp(mute)).toContain("--[no-]muted");
    expect(commandHelp(descriptor("thread.list"))).not.toContain("muted");
  });
});

describe("object flags", () => {
  it("sets one field of an object option per flag, on top of its JSON", async () => {
    const set = descriptor("settings.set");
    expect(
      await parseCommandInput(
        set,
        [
          "--agents",
          '{"access":"assistant","read":"all"}',
          "--agents-read",
          "known",
          "--agents-send-limit",
          "20",
          "--no-agents-manage",
          "--notifications-preview",
          "sender",
        ],
        "/",
      ),
    ).toEqual({
      agents: { access: "assistant", read: "known", sendLimit: 20, manage: false },
      notifications: { preview: "sender" },
    });
    expect(await parseCommandInput(set, ["--agents-send-limit", "none"], "/")).toEqual({
      agents: { sendLimit: null },
    });
    const help = commandHelp(set);
    expect(help).toContain("--agents-send <value> [never|approve|replied|always]");
    expect(help).toContain("--agents-hide-codes\n");
    expect(help).not.toContain("--agents-read-file");
  });
});

describe("formatters", () => {
  it("formats settings as the access level enforces them", () => {
    const settings: Settings = {
      agents: {
        ...DEFAULT_SETTINGS.agents,
        access: "assistant",
        handles: "visible",
        hideCodes: false,
      },
      notifications: { preview: "full" },
      defaultRegion: "US",
      sendDelaySeconds: 0,
    };
    const text = format("settings.get", settings);
    expect(text).toContain("AI agents       Assistant (--access assistant)");
    expect(text).toContain("(known)");
    expect(text).toMatch(
      /Send\s+every message is a draft for you to review \(approve\), up to 10 per 10 minutes/,
    );
    expect(text).toMatch(/Delay\s+10s \(agents' messages, and agent drafts you send\)/);
    expect(text).toMatch(/Send delay\s+off \(your messages\)/);
    expect(text).not.toContain("Drafts");
    expect(text).toMatch(/Inbox\s+not allowed/);
    // Assistant keeps the privacy protections on, whatever is stored.
    expect(text).toMatch(/Numbers\s+hidden behind opaque IDs \(always, below full access\)/);
    expect(text).toMatch(/Codes\s+hidden/);
    const unlimited = { ...settings, agents: { ...settings.agents, sendLimit: null } };
    expect(format("settings.get", unlimited)).toMatch(/\(approve\), no limit/);
    // Read only: reading, and nothing else.
    const readOnly = format("settings.get", {
      ...settings,
      agents: { ...settings.agents, access: "readOnly", read: "off" },
    });
    expect(readOnly).toMatch(/Read\s+your contacts, and people you've texted yourself \(known\)/);
    expect(readOnly).toMatch(/Send\s+not allowed\n/);
    // Assistant without reading: no "nothing (off)".
    const sendOnly = format("settings.get", {
      ...settings,
      agents: { ...settings.agents, read: "off" },
    });
    expect(sendOnly).toMatch(/Read\s+nothing\n/);
    const full = format("settings.get", {
      ...settings,
      agents: { ...settings.agents, access: "full" },
    });
    expect(full).toMatch(/Numbers\s+visible\n/);
    expect(full).toMatch(/, no limit/);
    expect(format("settings.get", DEFAULT_SETTINGS)).toMatch(
      /^AI agents\s+Off \(--access off\): only status and settings\n/,
    );
  });

  it("formats threads and messages by name, with keys only when verbose", () => {
    const thread: Thread = {
      key: "tel:+15550100001",
      kind: "direct",
      title: "Ada Lovelace",
      members: ["tel:+15550100001"],
      lastMessage: message,
      unread: 2,
      muted: false,
      hiddenFromAgents: true,
      pinned: true,
    };
    const stranger: Thread = {
      ...thread,
      key: "tel:+15550100099",
      title: "+15550100099",
      members: ["tel:+15550100099"],
      lastMessage: null,
      unread: 0,
      hiddenFromAgents: false,
      pinned: false,
    };
    expect(format("thread.list", [thread, stranger])).toBe(
      [
        "Ada Lovelace  [pinned, hidden from agents, 2 unread]",
        `  ${formatTime(T)}  Lunch tomorrow?`,
        "+1 (555) 010-0099",
      ].join("\n"),
    );
    expect(format("thread.list", [thread, stranger], { verbose: true })).toBe(
      [
        "Ada Lovelace  [pinned, hidden from agents, 2 unread]",
        `  tel:+15550100001  ${formatTime(T)}  Lunch tomorrow?`,
        "+1 (555) 010-0099",
        "  tel:+15550100099",
      ].join("\n"),
    );
    expect(format("thread.list", [])).toBe("No conversations");
    expect(formatTime(T)).toBe("2025-06-15 09:05");

    // A contact's phone and email conversations, told apart without the number.
    const byEmail: Thread = { ...thread, key: "email:ada@example.com", pinned: false, unread: 0 };
    expect(format("thread.list", [thread, byEmail]).split("\n")).toEqual([
      "Ada Lovelace (phone)  [pinned, hidden from agents, 2 unread]",
      `  ${formatTime(T)}  Lunch tomorrow?`,
      "Ada Lovelace (email)  [hidden from agents]",
      `  ${formatTime(T)}  Lunch tomorrow?`,
    ]);

    const failed: Message = { ...message, direction: "outgoing", sender: null, status: "failed" };
    const fromStranger: Message = { ...message, sender: "tel:+15550100099" };
    const fromEmail: Message = { ...message, sender: "email:alan@example.com" };
    expect(format("message.list", [message, failed, fromStranger, fromEmail], { people })).toBe(
      [
        `${formatTime(T)}  Ada Lovelace: Lunch tomorrow?`,
        `${formatTime(T)}  You: Lunch tomorrow?  [failed]`,
        `${formatTime(T)}  +1 (555) 010-0099: Lunch tomorrow?`,
        `${formatTime(T)}  alan@example.com: Lunch tomorrow?`,
      ].join("\n"),
    );
    expect(format("message.list", [message], { people, verbose: true })).toBe(
      `${formatTime(T)}  Ada Lovelace (tel:+15550100001): Lunch tomorrow?`,
    );
    expect(
      format("message.send", { outcome: "sent", message: { ...failed, status: "sent" } }),
    ).toBe("Sent (m1)");
  });

  it("says why a send failed when Tincan knows", () => {
    const failed: Message = { ...message, direction: "outgoing", sender: null, status: "failed" };
    const paused: Message = { ...failed, id: "m2", failure: { code: "PAUSED" } };
    const restarted: Message = { ...failed, id: "m3", failure: { code: "RESTARTED" } };
    const offline: Message = { ...failed, id: "m4", failure: { code: "NOT_CONNECTED" } };
    expect(format("message.list", [paused, restarted, offline]).split("\n")).toEqual([
      `${formatTime(T)}  You: Lunch tomorrow?  [failed: paused while your computer was asleep]`,
      `${formatTime(T)}  You: Lunch tomorrow?  [failed: Tincan was restarted before it was sent]`,
      `${formatTime(T)}  You: Lunch tomorrow?  [failed: the phone wasn't connected]`,
    ]);
    expect(format("message.retry", paused)).toBe(
      "Send failed: paused while your computer was asleep (m2)",
    );
  });

  it("lists your drafts to new recipients by name", () => {
    const drafts = [
      { to: "tel:+15550100001", text: "See you\nthere", updatedAt: T },
      { to: "tel:+15550100099", text: "Hi", updatedAt: T },
    ];
    expect(format("message.draft.list", drafts, { people }).split("\n")).toEqual([
      `Ada Lovelace (new conversation)  ${formatTime(T)}`,
      "  See you there",
      `+1 (555) 010-0099 (new conversation)  ${formatTime(T)}`,
      "  Hi",
    ]);
    expect(format("message.draft.list", [])).toBe("No drafts to new recipients");
  });

  it("formats search results with each message's conversation", () => {
    const inGroup: Message = {
      ...message,
      id: "m2",
      threadKey: "group:name:book-club",
      sender: "tel:+15550100002",
    };
    const conversations = new Map([["group:name:book-club", "Book club"]]);
    expect(format("message.search", [message, inGroup], { people, conversations })).toBe(
      [
        `${formatTime(T)}  Ada Lovelace: Lunch tomorrow?`,
        "  Ada Lovelace  m1",
        `${formatTime(T)}  Grace Hopper: Lunch tomorrow?`,
        "  Book club  m2",
      ].join("\n"),
    );
    // Without names: formatted numbers and the group's name from its key, never a raw key.
    const plain = format("message.search", [message, inGroup]);
    expect(plain).toContain("  +1 (555) 010-0001  m1");
    expect(plain).toContain("+1 (555) 010-0002: Lunch tomorrow?");
    expect(plain).toContain("  Book Club  m2");
    expect(plain).not.toMatch(/tel:|group:/);
    const verbose = format("message.search", [inGroup], { people, conversations, verbose: true });
    expect(verbose).toContain("Grace Hopper (tel:+15550100002): Lunch tomorrow?");
    expect(verbose).toContain("  Book club (group:name:book-club)  m2");
  });

  it("formats a conversation, with its members and drafts", () => {
    const group: Thread = {
      key: "group:name:book-club",
      kind: "group",
      title: "Book club",
      members: ["tel:+15550100001", "tel:+15550100002", "tel:+15550100099"],
      lastMessage: { ...message, threadKey: "group:name:book-club", sender: "tel:+15550100002" },
      unread: 1,
      muted: true,
      pinned: false,
    };
    const shown = { thread: group, group: null, draft: "See you\nthere", drafts: [] };
    expect(format("thread.get", shown, { people })).toBe(
      [
        "Book club  [muted, 1 unread]",
        "  Members  Ada Lovelace, Grace Hopper, +1 (555) 010-0099",
        `  Last     ${formatTime(T)}  Grace Hopper: Lunch tomorrow?`,
        "  Draft    See you there",
      ].join("\n"),
    );
    const verbose = format("thread.get", shown, { people, verbose: true });
    expect(verbose).toContain("  Key      group:name:book-club");
    expect(verbose).toContain("Ada Lovelace (tel:+15550100001)");
  });

  it("formats contacts with their numbers, and groups by name", () => {
    const ada: Contact = {
      id: "c1",
      name: "Ada Lovelace",
      handles: ["tel:+15550100001", "email:ada@example.com", "tel:+442079460958"],
      hasPhoto: false,
      labels: { "tel:+15550100001": "mobile" },
      details: { company: "Analytical Engines" },
    };
    expect(format("contact.list", [ada])).toBe(
      "Ada Lovelace  +1 (555) 010-0001, ada@example.com, +44 20 7946 0958  (c1)",
    );
    expect(format("contact.list", [ada], { verbose: true })).toBe(
      "Ada Lovelace  tel:+15550100001, email:ada@example.com, tel:+442079460958  (c1)",
    );
    expect(format("contact.get", ada)).toBe(
      [
        "Ada Lovelace  (c1)",
        "  mobile   +1 (555) 010-0001",
        "  email    ada@example.com",
        "  phone    +44 20 7946 0958",
        "  company  Analytical Engines",
      ].join("\n"),
    );

    const group: Group = {
      threadKey: "group:name:book-club",
      name: "Book club",
      named: true,
      participants: [],
      roster: ["tel:+15550100001", "tel:+15550100099"],
      routeInvalidated: true,
    };
    expect(format("group.list", [group], { people })).toBe(
      [
        "Book club  [new sender: review members]",
        "  members: Ada Lovelace, +1 (555) 010-0099",
      ].join("\n"),
    );
    expect(format("group.list", [group], { people, verbose: true })).toContain(
      "  group:name:book-club\n",
    );
  });

  it("keeps the phone's Bluetooth address out of status unless verbose", () => {
    const status = {
      daemon: { version: "1.0.0", protocolVersion: 2, pid: 1, startedAt: 0, uptimeMs: 5000 },
      native: { loaded: true, version: "1.0.0", error: null },
      phone: {
        state: "connected",
        device: { name: "Pat's iPhone", address: "AA:BB:CC:DD:EE:FF" },
      },
    };
    expect(format("status", status)).toMatch(/Phone    connected — Pat's iPhone$/);
    expect(format("status", status)).not.toContain("AA:BB");
    expect(format("status", status, { verbose: true })).toContain(
      "connected — Pat's iPhone (AA:BB:CC:DD:EE:FF)",
    );
  });

  it("never turns an agent's opaque handle IDs back into numbers", () => {
    expect(displayHandle("handle:abc123")).toBe("handle:abc123");
    expect(displayHandle("tel:+15550100001")).toBe("+1 (555) 010-0001");
    expect(displayHandle("tel:12345")).toBe("12345");
    expect(formatNumber("+33612345678")).toBe("+33 6 12 34 56 78");
    // As an agent sees them: masked keys, with names from its own (masked) contact list.
    const agentPeople = new Map([["handle:ada", "Ada Lovelace"]]);
    const masked: Message = { ...message, threadKey: "handle:ada", sender: "handle:ada" };
    const unknown: Message = { ...message, threadKey: "handle:zzz", sender: "handle:zzz" };
    const text = format("message.search", [masked, unknown], { people: agentPeople });
    expect(text).toContain("Ada Lovelace: Lunch tomorrow?");
    expect(text).toContain("handle:zzz: Lunch tomorrow?");
    expect(text).not.toMatch(/tel:|\+1/);
    const thread: Thread = {
      key: "handle:zzz",
      kind: "direct",
      title: "handle:zzz",
      members: ["handle:zzz"],
      lastMessage: null,
      unread: 0,
      muted: false,
      pinned: false,
    };
    expect(format("thread.list", [thread])).toBe("handle:zzz");
    expect(format("thread.list", [thread], { verbose: true })).toBe("handle:zzz\n  handle:zzz");
  });

  it("formats sync status and results", () => {
    expect(
      format("sync.status", {
        messages: { state: "connected", syncing: false, lastSyncAt: T },
        contacts: { state: "off", lastSyncAt: null },
        notifications: { state: "waiting", detail: "Allow notifications on the phone" },
      }),
    ).toBe(
      [
        `Messages       connected, last synced ${formatTime(T)}`,
        "Contacts       off",
        "Notifications  waiting — Allow notifications on the phone",
      ].join("\n"),
    );
    expect(format("sync.now", { synced: true, added: 1, contacts: null })).toBe(
      "Synced: 1 new message",
    );
  });

  it("formats the connection history", () => {
    expect(format("device.history", [])).toBe("Nothing recorded yet");
    expect(
      format("device.history", [
        { at: T, kind: "phone", state: "connected", address: "AA:BB:CC:DD:EE:FF", code: null },
        {
          at: T,
          kind: "messages",
          state: "refused",
          address: "AA:BB:CC:DD:EE:FF",
          code: "NOT_FOUND",
        },
        { at: T, kind: "adapter", state: "not-hands-free", address: null, code: null },
      ]),
    ).toBe(
      [
        "2025-06-15 09:05  phone     connected",
        "2025-06-15 09:05  messages  refused  [NOT_FOUND]",
        "2025-06-15 09:05  adapter   not-hands-free",
      ].join("\n"),
    );
    expect(
      format(
        "device.history",
        [{ at: T, kind: "phone", state: "connected", address: "AA:BB:CC:DD:EE:FF", code: null }],
        { verbose: true },
      ),
    ).toBe("2025-06-15 09:05  phone     connected  AA:BB:CC:DD:EE:FF");
  });

  it("formats agent drafts and sends", () => {
    const draft: AgentDraft = {
      id: "drf_1",
      threadKey: null,
      to: "tel:+15550100001",
      agentName: "Claude\u202eCode",
      intent: "send",
      body: "hi",
      text: "hi\nthere",
      edited: true,
      revision: 1,
      state: "queued",
      note: "outOfScope",
      createdAt: T,
      updatedAt: T,
      resolvedAt: null,
    };
    expect(format("draft.list", [draft])).toBe(
      `drf_1  Claude Code → +1 (555) 010-0001 (new conversation)  [queued, edited, outside what AI agents can read]  ${formatTime(T)}\n  hi there`,
    );
    const toAda = { ...draft, threadKey: "tel:+15550100001", note: undefined };
    expect(format("draft.list", [toAda], { people })).toBe(
      `drf_1  Claude Code → Ada Lovelace  [queued, edited]  ${formatTime(T)}\n  hi there`,
    );
    expect(format("draft.get", toAda, { people, verbose: true })).toContain(
      "→ Ada Lovelace (tel:+15550100001)  [",
    );
    // An agent's own view: an opaque recipient, or the raw number it typed itself.
    const agentView = { ...draft, to: "handle:x1", requestedAs: "555-0100" };
    expect(format("draft.list", [agentView])).toContain("Claude Code → 555-0100 (new");
    expect(format("draft.list", [{ ...agentView, requestedAs: undefined }])).toContain(
      "Claude Code → handle:x1 (new",
    );
    expect(format("draft.list", [])).toBe("No agent drafts");
    expect(format("message.send", { outcome: "queued", draft })).toBe(
      "Queued as an agent draft for you to review in Tincan (drf_1)",
    );
    const scheduled = {
      outcome: "scheduled",
      message: { ...message, id: "m9", status: "scheduled" },
      sendAt: Date.now() + 10_000,
    };
    expect(format("message.send", scheduled)).toMatch(
      /^Sending in 1\ds \(m9\)\. Cancel with: tincan message cancel m9$/,
    );
    expect(format("message.cancel", { id: "m9", threadKey: "tel:+1", text: "oops" })).toBe(
      "Cancelled. It said: oops",
    );
  });

  it("takes a draft id as an argument", async () => {
    expect(await parseCommandInput(descriptor("draft.send"), ["drf_1"], "/")).toEqual({
      id: "drf_1",
    });
  });
});

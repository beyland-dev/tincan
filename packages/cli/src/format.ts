import type { ServiceStatus } from "@beyland/tincan-daemon";
import {
  effectiveAgents,
  type AgentAccess,
  type AgentDraft,
  type AgentVisibleSettings,
  type Contact,
  type HiddenPerson,
  type DoctorCheck,
  type Group,
  type Message,
  type OutputOf,
  type Settings,
  type Thread,
} from "@beyland/tincan-protocol";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * What a formatter knows beyond the result itself. People and conversations are named, never
 * shown as raw keys, unless `verbose` asks for the keys too (to copy into other commands).
 */
export interface FormatContext {
  /** `--verbose`: also print thread keys, handles and Bluetooth addresses. */
  verbose: boolean;
  /**
   * Contact names by handle, as the daemon gave them to this client: for an AI agent the handles
   * are opaque `handle:` IDs, which are only ever matched, never turned back into numbers.
   */
  people: ReadonlyMap<string, string>;
  /** Conversation titles by thread key. */
  conversations: ReadonlyMap<string, string>;
  /** The command's input, for results that don't say what was asked (`thread mute --no-muted`). */
  input: Readonly<Record<string, unknown>>;
}

/** No names looked up, keys hidden. */
export const PLAIN: FormatContext = {
  verbose: false,
  people: new Map(),
  conversations: new Map(),
  input: {},
};

/** What a result needs looked up before it can be shown by name. */
export interface Lookup {
  /** Contact names, for senders, members and recipients. */
  people?: boolean;
  /** Conversation titles, for results that only carry a thread key. */
  conversations?: boolean;
}

type Formatter = (value: never, context: FormatContext) => string;

/** Human-readable output for `tincan <command>`; commands without one print JSON. */
export const formatters: Record<string, Formatter> = {
  status: (s: OutputOf<"status">, { verbose }) =>
    [
      `Daemon   ${s.daemon.version} (protocol ${s.daemon.protocolVersion}, pid ${s.daemon.pid}, up ${formatDuration(s.daemon.uptimeMs)})`,
      `Native   ${s.native.loaded ? `loaded ${s.native.version ?? ""}`.trim() : `not loaded${s.native.error ? ` — ${s.native.error}` : ""}`}`,
      `Phone    ${s.phone.state}${s.phone.device ? ` — ${oneLine(s.phone.device.name)}${verbose ? ` (${s.phone.device.address})` : ""}` : ""}`,
    ].join("\n"),
  doctor: (r: OutputOf<"doctor">) => {
    const lines = r.checks.map(doctorLine);
    const failed = r.checks.filter((c) => c.status === "fail").length;
    const warned = r.checks.filter((c) => c.status === "warn").length;
    const summary =
      failed || warned
        ? [failed && plural(failed, "problem"), warned && plural(warned, "warning")]
            .filter(Boolean)
            .join(", ")
        : "All good";
    const note = r.daemon ? "" : " (the daemon isn't running, so phone checks were skipped)";
    return `${lines.join("\n")}\n\n${summary}${note}`;
  },
  service: (s: ServiceStatus) =>
    [
      `Unit      ${s.path}${s.installed ? "" : " (not installed)"}`,
      ...(s.installed
        ? [
            `Command   ${s.execStart ?? "?"}`,
            `Enabled   ${yesNo(s.enabled)}`,
            `Running   ${yesNo(s.active)}`,
          ]
        : []),
    ].join("\n"),
  version: (v: OutputOf<"version">) => `${v.version} (protocol ${v.protocolVersion})`,
  commands: (list: OutputOf<"commands">) =>
    list
      .map((d) => {
        const flags = [
          d.internal && "internal",
          d.sensitive && "sensitive",
          d.agentScope && `agents:${d.agentScope}`,
          d.approval === "agent" && "send-policy",
        ]
          .filter(Boolean)
          .join(",");
        return `${d.name.padEnd(24)} ${d.kind.padEnd(9)} ${d.description}${flags ? `  [${flags}]` : ""}`;
      })
      .join("\n"),
  "sync.status": (s: OutputOf<"sync.status">) =>
    [
      `Messages       ${s.messages.state}${s.messages.syncing ? " (syncing)" : ""}${since(s.messages.lastSyncAt)}`,
      `Contacts       ${s.contacts.state}${since(s.contacts.lastSyncAt)}`,
      `Notifications  ${s.notifications.state}${s.notifications.detail ? ` — ${s.notifications.detail}` : ""}`,
    ].join("\n"),
  "sync.now": (r: OutputOf<"sync.now">) =>
    [
      r.synced
        ? `Synced: ${plural(r.added, "new message")}`
        : "The phone isn't connected; Tincan syncs when it connects.",
      r.contacts &&
        (r.contacts.skipped
          ? "Contacts unchanged"
          : `Contacts: ${r.contacts.contacts} (${r.contacts.changed} changed, ${r.contacts.removed} removed)`),
    ]
      .filter(Boolean)
      .join("\n"),
  "thread.list": (threads: Thread[], context) => {
    const shared = sharedNames(threads);
    return list(threads, "No conversations", (t) => {
      const last = t.lastMessage;
      const detail = [context.verbose && t.key, last && `${when(last)}  ${preview(last)}`]
        .filter(Boolean)
        .join("  ");
      const header = threadHeader(t, shared.has(threadName(t)) && !context.verbose);
      return [header, detail && `  ${detail}`].filter(Boolean).join("\n");
    });
  },
  "thread.get": (r: OutputOf<"thread.get">, context) => {
    const t = r.thread;
    const lines = [threadHeader(t)];
    if (context.verbose) lines.push(`  Key      ${t.key}`);
    if (t.kind === "group") {
      const members = r.group?.roster ?? t.members;
      const names = members.length
        ? members.map((h) => person(h, context))
        : (r.group?.participants ?? []).map(oneLine);
      if (names.length) lines.push(`  Members  ${names.join(", ")}`);
      if (r.group?.routeInvalidated) lines.push("  A new sender wrote in: review the members");
    } else if (context.verbose && t.members.some((h) => h !== t.key)) {
      lines.push(`  Members  ${t.members.join(", ")}`);
    }
    if (t.lastMessage) lines.push(`  Last     ${messageLine(t.lastMessage, context)}`);
    if (r.draft) lines.push(`  Draft    ${oneLine(r.draft)}`);
    for (const d of r.drafts ?? []) {
      lines.push(
        ...draftLines(d, context)
          .split("\n")
          .map((line) => `  ${line}`),
      );
    }
    return lines.join("\n");
  },
  "thread.markRead": (r: OutputOf<"thread.markRead">) =>
    `Marked ${plural(r.marked, "message")} read${r.marked ? ` (${r.onPhone} on the phone)` : ""}`,
  "thread.mute": (r: OutputOf<"thread.mute">, context) =>
    context.input.muted === false
      ? flagLine(r, context, "Unmuted", "isn't muted")
      : flagLine(r, context, "Muted", "is already muted"),
  "thread.pin": (r: OutputOf<"thread.pin">, context) =>
    context.input.pinned === false
      ? flagLine(r, context, "Unpinned", "isn't pinned")
      : flagLine(r, context, "Pinned", "is already pinned"),
  "thread.delete": (r: OutputOf<"thread.delete">, context) =>
    r.deleted
      ? `Deleted ${conversation(r.key, context)} from Tincan (not from the phone)`
      : `There was nothing to delete in ${conversation(r.key, context)}`,
  "message.list": (messages: Message[], context) =>
    list(messages, "No messages", (m) => messageLine(m, context)),
  "message.search": (messages: Message[], context) =>
    list(
      messages,
      "No matches",
      (m) => `${messageLine(m, context)}\n  ${conversation(m.threadKey, context)}  ${m.id}`,
    ),
  "message.send": (r: OutputOf<"message.send">) => sendLine(r),
  "message.retry": (m: Message) => statusLine(m),
  "message.sendNow": (m: Message) => statusLine(m),
  "message.cancel": (r: OutputOf<"message.cancel">) =>
    r.draft
      ? r.draft.state === "queued"
        ? `Cancelled; back in the queue as a draft (${r.draft.id})`
        : `Cancelled ${oneLine(r.draft.agentName)}'s message`
      : `Cancelled. It said: ${oneLine(r.text)}`,
  "message.draft.save": (r: OutputOf<"message.draft.save">, context) => {
    if (r.draft) return `Saved as an agent draft for you to review in Tincan (${r.draft.id})`;
    const where = r.threadKey ? ` in ${conversation(r.threadKey, context)}` : "";
    return r.deleted ? `Deleted your draft${where}` : `Saved your draft${where}`;
  },
  "message.draft.list": (drafts: OutputOf<"message.draft.list">, context) =>
    list(
      drafts,
      "No drafts to new recipients",
      (d) =>
        `${person(d.to, context)} (new conversation)  ${formatTime(d.updatedAt)}\n  ${oneLine(d.text)}`,
    ),
  "draft.list": (drafts: AgentDraft[], context) =>
    list(drafts, "No agent drafts", (d) => draftLines(d, context)),
  "draft.get": (d: AgentDraft, context) => draftLines(d, context),
  "draft.update": (d: AgentDraft, context) => draftLines(d, context),
  "draft.discard": (d: AgentDraft) => `Discarded ${oneLine(d.agentName)}'s draft (${d.id})`,
  "draft.restore": (d: AgentDraft) => `Restored ${oneLine(d.agentName)}'s draft (${d.id})`,
  "draft.send": (r: OutputOf<"draft.send">) => sendLine(r),
  "contact.list": (contacts: Contact[], context) =>
    list(contacts, "No contacts", (c) => contactLine(c, context)),
  "contact.search": (contacts: Contact[], context) =>
    list(contacts, "No matches", (c) => contactLine(c, context)),
  "contact.get": (c: Contact, context) => contactCard(c, context),
  "group.list": (groups: Group[], context) =>
    list(groups, "No groups", (g) => groupLines(g, context)),
  "group.save": (g: Group, context) => groupLines(g, context),
  "group.delete": (r: OutputOf<"group.delete">) =>
    r.deleted ? "Forgot the group's name and members" : "Nothing was saved for that group",
  "group.assignMessage": (m: Message, context) =>
    `Moved it to ${conversation(m.threadKey, context)} (${m.id})`,
  "device.history": (events: OutputOf<"device.history">, { verbose }) =>
    list(events, "Nothing recorded yet", (e) =>
      [formatTime(e.at), e.kind.padEnd(8), e.state, verbose && e.address, e.code && `[${e.code}]`]
        .filter(Boolean)
        .join("  "),
    ),
  "agents.hidden": (r: OutputOf<"agents.hidden">, context) =>
    r.people.length === 0 && r.groups.length === 0
      ? "Nobody is hidden from AI agents"
      : [
          ...(r.people.length
            ? ["People", ...r.people.map((p) => `  ${hiddenPersonLine(p, context)}`)]
            : []),
          ...(r.groups.length
            ? [
                "Groups",
                ...r.groups.map((g) => `  ${withKey(oneLine(g.title), g.threadKey, context)}`),
              ]
            : []),
        ].join("\n"),
  "agents.hide": (r: OutputOf<"agents.hide">, context) => {
    const name = r.person
      ? oneLine(r.person.label)
      : r.group
        ? withKey(oneLine(r.group.title), r.group.threadKey, context)
        : "It";
    const what = r.person ? `${name} (${handleCounts(r.person.handles)})` : name;
    const line = r.changed
      ? `Hid ${what} from AI agents${r.person ? ", with every group they're in" : ""}`
      : `${name} is already hidden from AI agents`;
    return r.requeued > 0
      ? `${line}\n${plural(r.requeued, "agent message")} waiting to go to them came back as drafts for you`
      : line;
  },
  "agents.show": (r: OutputOf<"agents.show">) =>
    r.changed ? "AI agents can see them again" : "That isn't hidden from AI agents",
  "settings.get": (s: OutputOf<"settings.get">) => formatSettings(s),
  "settings.set": (s: Settings) => formatSettings(s),
};

type Lookups = (value: never, input: Readonly<Record<string, unknown>>) => Lookup;

const hasSender = (messages: Message[]) => messages.some((m) => m.sender !== null);

/** What each result needs looked up (one batched call each) before its formatter runs. */
export const lookups: Record<string, Lookups> = {
  "thread.get": (r: OutputOf<"thread.get">) => ({
    people:
      r.thread.kind === "group" ||
      Boolean(r.drafts?.length) ||
      r.thread.lastMessage?.sender != null,
  }),
  "thread.mute": () => ({ conversations: true }),
  "thread.pin": () => ({ conversations: true }),
  // Gone from the list now: name it from the contact.
  "thread.delete": () => ({ people: true }),
  "message.list": (messages: Message[]) => ({ people: hasSender(messages) }),
  "message.search": (messages: Message[]) => ({
    people: messages.length > 0,
    conversations: messages.length > 0,
  }),
  "message.draft.save": (r: OutputOf<"message.draft.save">) => ({
    conversations: !r.draft && r.threadKey !== null,
  }),
  "message.draft.list": (drafts: OutputOf<"message.draft.list">) => ({
    people: drafts.length > 0,
  }),
  "draft.list": (drafts: AgentDraft[]) => ({ people: drafts.length > 0 }),
  "draft.get": () => ({ people: true }),
  "draft.update": () => ({ people: true }),
  "group.list": (groups: Group[]) => ({ people: groups.some((g) => g.roster?.length) }),
  "group.save": (g: Group) => ({ people: Boolean(g.roster?.length) }),
  "group.assignMessage": () => ({ conversations: true }),
};

/** Why an agent draft needed you, as the CLI says it. */
export const DRAFT_NOTES: Record<NonNullable<AgentDraft["note"]>, string> = {
  hidden: "a conversation you hid from AI agents",
  shortCode: "a short code, hidden from AI agents",
  outOfScope: "outside what AI agents can read",
};

function statusLine(m: Message): string {
  if (m.status === "scheduled")
    return `Sending at ${formatTime(m.sendAt ?? m.sentAt ?? 0)} (${m.id})`;
  const why = failureReason(m);
  return `${m.status === "sent" ? "Sent" : `Send ${m.status}`}${why ? `: ${why}` : ""} (${m.id})`;
}

function sendLine(r: {
  outcome: string;
  message?: Message;
  draft?: AgentDraft;
  sendAt?: number;
}): string {
  if (r.outcome === "queued") {
    return `Queued as an agent draft for you to review in Tincan (${r.draft?.id ?? "?"})`;
  }
  if (r.outcome === "scheduled" && r.message) {
    const seconds = r.sendAt ? Math.max(0, Math.round((r.sendAt - Date.now()) / 1000)) : 0;
    return `Sending in ${seconds}s (${r.message.id}). Cancel with: tincan message cancel ${r.message.id}`;
  }
  return r.message ? statusLine(r.message) : r.outcome;
}

/** An agent draft: who wrote it, to whom, its state, and its text, each line kept to one line. */
function draftLines(d: AgentDraft, context: FormatContext): string {
  const flags = [d.state, d.edited && "edited", d.note && DRAFT_NOTES[d.note]].filter(Boolean);
  const to = draftRecipient(d, context);
  return [
    `${d.id}  ${oneLine(d.agentName)} → ${to}${d.threadKey ? "" : " (new conversation)"}  [${flags.join(", ")}]  ${formatTime(d.createdAt)}`,
    `  ${oneLine(d.text ?? d.body)}`,
  ].join("\n");
}

/** Text from elsewhere on one line, so it can't fake the output around it. */
export function oneLine(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

const ACCESS_NAMES: Record<AgentAccess, string> = {
  off: "Off",
  readOnly: "Read only",
  assistant: "Assistant",
  full: "Full access",
};

/** What `--access` calls each level. */
const ACCESS_FLAGS: Record<AgentAccess, string> = {
  off: "off",
  readOnly: "read-only",
  assistant: "assistant",
  full: "full",
};

const READ_NAMES: Record<Exclude<Settings["agents"]["read"], "off">, string> = {
  contacts: "conversations with your contacts",
  known: "your contacts, and people you've texted yourself",
  all: "every conversation you haven't hidden",
};

const SEND_NAMES: Record<Exclude<Settings["agents"]["send"], "never">, string> = {
  approve: "every message is a draft for you to review",
  replied: "directly to people you've texted yourself; a draft for anyone else",
  always: "directly",
};

function delay(seconds: number): string {
  return seconds === 0 ? "off" : `${seconds}s`;
}

/**
 * The settings in words: the access level, then what agents may actually do at it (a stored
 * value the level doesn't use isn't shown), with each value as `settings set` takes it.
 */
/** The settings, or (in an AI agent's shell, as agents get them) only the agent policy. */
export function formatSettings(s: Settings | AgentVisibleSettings): string {
  const a = effectiveAgents(s.agents);
  const allowed = (on: boolean) => (on ? "allowed" : "not allowed");
  const access = `AI agents       ${ACCESS_NAMES[a.access]} (--access ${ACCESS_FLAGS[a.access]})`;
  const rest =
    "notifications" in s
      ? [
          `Send delay      ${delay(s.sendDelaySeconds)} (your messages)`,
          `Notifications   ${s.notifications.preview}`,
          `Region          ${s.defaultRegion}`,
        ]
      : [];
  if (a.access === "off") return [`${access}: only status and settings`, ...rest].join("\n");
  const limit = a.sendLimit === null ? ", no limit" : `, up to ${a.sendLimit} per 10 minutes`;
  // Below full access the privacy protections are always on.
  const fixed = a.access === "full" ? "" : " (always, below full access)";
  return [
    access,
    `  Read          ${a.read === "off" ? "nothing" : `${READ_NAMES[a.read]} (${a.read})`}`,
    `  Send          ${a.send === "never" ? "not allowed" : `${SEND_NAMES[a.send]} (${a.send})${limit}`}`,
    `  Delay         ${delay(a.sendDelaySeconds)} (agents' messages, and agent drafts you send)`,
    `  Inbox         ${allowed(a.manage)} (mark read, mute, pin)`,
    `  Numbers       ${a.handles === "hidden" ? "hidden behind opaque IDs" : "visible"}${fixed}`,
    `  Codes         ${a.hideCodes ? "hidden" : "visible"} (verification codes and short codes)${fixed}`,
    ...rest,
  ].join("\n");
}

const MARKS: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

function doctorLine(c: DoctorCheck): string {
  const line = `${MARKS[c.status]} ${c.title.padEnd(24)} ${c.detail}`;
  return c.hint && c.status !== "ok" ? `${line}\n    ${c.hint}` : line;
}

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function list<T>(items: T[], empty: string, line: (item: T) => string): string {
  return items.length ? items.map(line).join("\n") : empty;
}

function messageLine(m: Message, context: FormatContext): string {
  const who = m.direction === "outgoing" ? "You" : m.sender ? person(m.sender, context) : "Someone";
  const why = failureReason(m);
  const status =
    m.direction === "outgoing" && m.status !== "sent"
      ? `  [${m.status}${why ? `: ${why}` : ""}]`
      : "";
  return `${when(m)}  ${who}: ${preview(m)}${status}`;
}

/** Why a message didn't send, as the CLI says it, when Tincan knows. */
export function failureReason(m: Pick<Message, "status" | "failure">): string | null {
  if (m.status !== "failed" || !m.failure) return null;
  switch (m.failure.code) {
    case "PAUSED":
      return "paused while your computer was asleep";
    case "RESTARTED":
      return "Tincan was restarted before it was sent";
    case "NOT_CONNECTED":
      return "the phone wasn't connected";
    default:
      return m.failure.code;
  }
}

/** Names more than one direct conversation goes by (a contact's number and their email). */
function sharedNames(threads: Thread[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const t of threads) {
    if (t.kind !== "direct") continue;
    const name = threadName(t);
    if (seen.has(name)) shared.add(name);
    seen.add(name);
  }
  return shared;
}

/** Someone hidden from agents: their name or address, what's hidden, and the id to show them by. */
function hiddenPersonLine(p: HiddenPerson, context: FormatContext): string {
  const label =
    p.contactId === null && !p.contactRemoved && p.handles[0]
      ? displayHandle(p.handles[0])
      : oneLine(p.label);
  const what = p.contactRemoved
    ? `contact removed; ${handleCounts(p.handles)}`
    : handleCounts(p.handles);
  const handles = context.verbose ? `  ${p.handles.join(", ")}` : "";
  return `${label}  (${what})${handles}  ${p.id}`;
}

/** "2 numbers, 1 email". */
function handleCounts(handles: readonly string[]): string {
  const numbers = handles.filter((h) => h.startsWith("tel:")).length;
  const emails = handles.filter((h) => h.startsWith("email:")).length;
  const other = handles.length - numbers - emails;
  return [
    numbers && plural(numbers, "number"),
    emails && plural(emails, "email"),
    other && plural(other, "sender"),
  ]
    .filter(Boolean)
    .join(", ");
}

/** Which of a contact's conversations this is, without its number: by phone, or by email. */
function channel(key: string): string {
  if (key.startsWith("tel:")) return "phone";
  if (key.startsWith("email:")) return "email";
  // An agent's opaque ID says nothing more, and is what tells the conversations apart.
  return key;
}

/** A conversation's title and badges; `channel` tells apart a contact's conversations. */
function threadHeader(t: Thread, withChannel = false): string {
  const badges = [
    t.pinned && "pinned",
    t.muted && "muted",
    t.hiddenFromAgents && "hidden from agents",
    t.unread > 0 && `${t.unread} unread`,
  ].filter(Boolean);
  const name = withChannel ? `${threadName(t)} (${channel(t.key)})` : threadName(t);
  return `${name}${badges.length ? `  [${badges.join(", ")}]` : ""}`;
}

/**
 * What a conversation is called. A direct one with no contact is titled with its bare address,
 * which reads better formatted (`+1 (555) 010-0099`).
 */
function threadName(t: Thread): string {
  const bare = t.key.replace(/^(tel|email|sender):/, "");
  return t.title === bare || t.title === t.key ? displayHandle(t.key) : oneLine(t.title);
}

/**
 * Someone, by contact name when there is one, else their formatted number or address (an AI
 * agent's opaque `handle:` ID stays as it is). `--verbose` adds the handle itself.
 */
export function person(handle: string, context: FormatContext): string {
  const name = context.people.get(handle);
  return withKey(name ? oneLine(name) : displayHandle(handle), handle, context);
}

/** A conversation by its title, the contact's name, or its formatted address. */
export function conversation(key: string, context: FormatContext): string {
  const title = context.conversations.get(key);
  if (title !== undefined) {
    const bare = key.replace(/^(tel|email|sender):/, "");
    const named = title === bare || title === key ? displayHandle(key) : oneLine(title);
    return withKey(named, key, context);
  }
  if (!key.startsWith("group:")) return person(key, context);
  return withKey(groupKeyTitle(key), key, context);
}

/** A group conversation's name from its key, as the daemon titles one it knows nothing else about. */
function groupKeyTitle(key: string): string {
  return key
    .replace(/^group:(name|members):/, "")
    .split("+")
    .map((slug) =>
      slug
        .split("-")
        .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
        .join(" "),
    )
    .join(", ");
}

function withKey(label: string, key: string, context: FormatContext): string {
  return context.verbose && label !== key ? `${label} (${key})` : label;
}

/**
 * Who an agent draft goes to. An agent's own view has an opaque `to`; when the agent typed a raw
 * number for it, that's what it typed (`requestedAs`), which is all it knows.
 */
function draftRecipient(d: AgentDraft, context: FormatContext): string {
  if (!context.people.has(d.to) && d.to.startsWith("handle:") && d.requestedAs) {
    return withKey(oneLine(d.requestedAs), d.to, context);
  }
  return person(d.to, context);
}

function flagLine(
  r: { key: string; changed: boolean },
  context: FormatContext,
  done: string,
  already: string,
): string {
  const name = conversation(r.key, context);
  return r.changed ? `${done} ${name}` : `${name} ${already}`;
}

/** A readable form of a handle: `+1 (555) 010-0001`, an email address, or a sender id. */
export function displayHandle(handle: string): string {
  if (handle.startsWith("tel:")) return formatNumber(handle.slice("tel:".length));
  if (handle.startsWith("email:") || handle.startsWith("sender:")) {
    return oneLine(handle.slice(handle.indexOf(":") + 1));
  }
  // An opaque `handle:` ID (never resolved back to a number), or anything else, as it is.
  return oneLine(handle);
}

/** A phone number for people: `+1 (555) 010-0099`, `+44 20 7946 0958`; short codes as they are. */
export function formatNumber(number: string): string {
  const parsed = number.startsWith("+") ? parsePhoneNumberFromString(number) : undefined;
  if (!parsed) return number;
  return parsed.countryCallingCode === "1"
    ? `+1 ${parsed.formatNational()}`
    : parsed.formatInternational();
}

/** A contact's numbers and addresses, formatted (`--verbose`: as handles). */
function contactHandles(c: Contact, context: FormatContext): string[] {
  return c.handles.map((h) => (context.verbose ? h : displayHandle(h)));
}

function contactLine(c: Contact, context: FormatContext): string {
  const handles = contactHandles(c, context);
  return `${oneLine(c.name)}${handles.length ? `  ${handles.join(", ")}` : ""}  (${c.id})`;
}

const HANDLE_KINDS: Record<string, string> = { tel: "phone", email: "email", handle: "handle" };

/** One contact: each number and address with its label, and what else the card says. */
function contactCard(c: Contact, context: FormatContext): string {
  const shown = contactHandles(c, context);
  const rows: [string, string][] = c.handles.map((h, i) => [
    c.labels?.[h] ?? HANDLE_KINDS[h.slice(0, h.indexOf(":"))] ?? "other",
    shown[i]!,
  ]);
  const d = c.details ?? {};
  for (const [label, value] of [
    ["nickname", d.nickname],
    ["company", [d.company, d.department].filter(Boolean).join(", ")],
    ["title", d.jobTitle],
    ["birthday", d.birthday],
    ["note", d.note],
  ] as const) {
    if (value) rows.push([label, value]);
  }
  for (const a of d.addresses ?? []) rows.push([a.label ?? "address", a.value]);
  for (const u of d.urls ?? []) rows.push([u.label ?? "url", u.value]);
  const width = Math.max(0, ...rows.map(([label]) => oneLine(label).length));
  return [
    `${oneLine(c.name)}  (${c.id})`,
    ...rows.map(([label, value]) => `  ${oneLine(label).padEnd(width)}  ${oneLine(value)}`),
  ].join("\n");
}

function groupLines(g: Group, context: FormatContext): string {
  const name = g.name
    ? oneLine(g.name)
    : g.participants.length
      ? g.participants.map(oneLine).join(", ")
      : "Unnamed group";
  const lines = [`${name}${g.routeInvalidated ? "  [new sender: review members]" : ""}`];
  if (context.verbose) lines.push(`  ${g.threadKey}`);
  if (g.roster) lines.push(`  members: ${g.roster.map((h) => person(h, context)).join(", ")}`);
  return lines.join("\n");
}

function preview(m: Message): string {
  const text = m.body.replace(/\s+/g, " ").trim();
  const body = text || (m.attachmentHint ? "[attachment]" : "");
  return body.length > 80 ? `${body.slice(0, 79)}…` : body;
}

function when(m: Message): string {
  return formatTime(m.sentAt ?? m.receivedAt);
}

/** Local time as `YYYY-MM-DD HH:MM`. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function since(at: number | null): string {
  return at === null ? "" : `, last synced ${formatTime(at)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

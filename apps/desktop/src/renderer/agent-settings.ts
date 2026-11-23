import {
  effectiveAgents,
  type AgentAccess,
  type AgentSettingsPatch,
  type EffectiveAgents,
  type Settings,
} from "@beyland/tincan-protocol";

type Agents = Settings["agents"];
type ReadPolicy = Agents["read"];
type SendPolicy = Agents["send"];

/** The access levels in the order the picker shows them. */
export const ACCESS_OPTIONS: Array<[AgentAccess, string]> = [
  ["off", "Off"],
  ["readOnly", "Read only"],
  ["assistant", "Assistant"],
  ["full", "Full access"],
];

/** A choice in one of the dropdowns: its value, its name and a line saying what it means. */
export type Option<T> = [T, string, string];

/** What each reading choice lets agents do, as the Reading row's description. */
const READ_LINE: Record<ReadPolicy, string> = {
  off: "Agents can't read your messages or contacts.",
  contacts: "Agents can read conversations with your contacts.",
  known: "Agents can read conversations with your contacts and people you've replied to.",
  all: "Agents can read every conversation you haven't hidden, including texts from strangers.",
};

const READ_OPTIONS: Array<Option<ReadPolicy>> = [
  ["off", "Off", `${READ_LINE.off} They can still send, as set below.`],
  ["contacts", "Contacts only", READ_LINE.contacts],
  ["known", "Contacts & people you've replied to", READ_LINE.known],
  ["all", "Everyone", READ_LINE.all],
];

/**
 * Which parts of the AI agents settings a level shows. Settings a level doesn't show keep their
 * stored value but have no effect.
 */
export interface AgentSections {
  read: boolean;
  send: boolean;
  /** The send limit (only Assistant has one; Full access has none). */
  sendLimit: boolean;
  /** Manage conversations. */
  inbox: boolean;
  /** The privacy protections, which only Full access can turn off. */
  danger: boolean;
}

export function sectionsFor(access: AgentAccess): AgentSections {
  return {
    read: access !== "off",
    send: access === "assistant" || access === "full",
    sendLimit: access === "assistant",
    inbox: access === "assistant" || access === "full",
    danger: access === "full",
  };
}

/** The reading choices a level offers: Read only can't read nothing, so it has no Off. */
export function readOptions(access: AgentAccess): Array<Option<ReadPolicy>> {
  if (access === "off") return [];
  return access === "readOnly" ? READ_OPTIONS.filter(([value]) => value !== "off") : READ_OPTIONS;
}

/**
 * The sending choices a level offers, with what each means at that level. Levels that can send
 * have no Never: to stop agents sending, pick Read only.
 */
export function sendOptions(effective: EffectiveAgents): Array<Option<SendPolicy>> {
  if (effective.access !== "assistant" && effective.access !== "full") return [];
  const limit = effective.sendLimit;
  const always =
    effective.access === "full"
      ? "Messages send without asking."
      : limit === null
        ? "Messages send without asking. Ones to conversations you've hidden become drafts for you."
        : "Messages send without asking, up to the send limit. Ones to conversations you've hidden become drafts for you.";
  return [
    [
      "approve",
      "Ask me",
      "Each message waits in its conversation as a draft for you to send, edit or discard.",
    ],
    [
      "replied",
      "Only people I've texted",
      "Messages to people you've texted yourself send without asking. Anything else becomes a draft for you.",
    ],
    ["always", "Always", always],
  ];
}

/**
 * What agents see of what Tincan normally hides, said plainly: everything hidden (the default),
 * or what the user chose to show them (only Full access can).
 */
function hiddenLine(effective: EffectiveAgents): string {
  const handles = effective.handles === "visible";
  const codes = !effective.hideCodes;
  if (handles && codes) return " Agents also see phone numbers, emails and verification codes.";
  if (handles) {
    return " Agents also see phone numbers and emails; Tincan still hides verification codes.";
  }
  if (codes) {
    return " Agents also see verification codes; Tincan still hides phone numbers and emails.";
  }
  return " Tincan hides phone numbers, emails and verification codes from agents.";
}

/**
 * The Reading row's description: what the picked choice means, and what Tincan keeps from agents
 * while it really does (Full access can turn that off).
 */
export function readHint(effective: EffectiveAgents): string {
  const picked = readOptions(effective.access).find(([value]) => value === effective.read);
  if (!picked) return "";
  return effective.read === "off" ? picked[2] : picked[2] + hiddenLine(effective);
}

/** The Sending row's description: what the picked choice means at this level. */
export function sendHint(effective: EffectiveAgents): string {
  return sendOptions(effective).find(([value]) => value === effective.send)?.[2] ?? "";
}

/** A line under the access picker saying, in short, what each level allows. */
const ACCESS_LINE: Record<AgentAccess, string> = {
  off: "Agents can't see or send your messages. They can only check that Tincan is running and what access you've given them.",
  readOnly: "Agents can read your messages and contacts, but can't send or change anything.",
  assistant:
    "Agents can read, draft and send messages, with Tincan's privacy protections always on.",
  full: "Agents can do everything you allow below, and Tincan's privacy protections can be turned off.",
};

/**
 * What the current access level allows, in one line for under the access picker; the Reading and
 * Sending rows below give the details. Read from the enforced settings.
 */
export function agentSummary(agents: Agents): string {
  return ACCESS_LINE[effectiveAgents(agents).access];
}

/** The send delay steps the dropdowns offer, in seconds. */
export const SEND_DELAYS = [0, 3, 5, 10, 20, 30, 60] as const;

/**
 * The send delay dropdown's choices, as strings for the dropdown: Off and the usual steps, plus
 * the current value when it was set some other way (the CLI takes any number up to 300).
 */
export function delayOptions(current: number | undefined): Array<[string, string]> {
  const values: number[] = [...SEND_DELAYS];
  if (current !== undefined && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return values.map((n) => [String(n), n === 0 ? "Off" : `${n}s`]);
}

/** The Send delay row's description. */
export function ownDelayHint(seconds: number): string {
  return seconds === 0
    ? "Your messages go to your iPhone as soon as you press Send. Once your iPhone has one, it can't be unsent."
    : `Holds each message on this computer for ${seconds} seconds before it goes to your iPhone, so you can undo it. Once your iPhone has it, it can't be unsent.`;
}

/** The Agent message delay row's description. */
export function agentDelayHint(seconds: number): string {
  return seconds === 0
    ? "Agents' messages, and ones you send from an agent draft, go to your iPhone straight away, with no time to undo them."
    : "Gives you time to undo an agent's message, or one you send from an agent draft, before it goes to your iPhone.";
}

export type AgentConfirm = "full" | "sendAlways";

/**
 * Whether a change needs the user to confirm it first: moving to Full access, or letting agents
 * send without asking under Assistant. Null when it can go straight through.
 */
export function confirmFor(agents: Agents, patch: AgentSettingsPatch): AgentConfirm | null {
  const before = effectiveAgents(agents);
  const after = effectiveAgents({ ...agents, ...patch } as Agents);
  if (after.access === "full" && before.access !== "full") return "full";
  const alwaysBefore = before.access === "assistant" && before.send === "always";
  if (after.access === "assistant" && after.send === "always" && !alwaysBefore) return "sendAlways";
  return null;
}

export interface ConfirmCopy {
  title: string;
  body: string[];
  action: string;
}

const RISK =
  "Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it.";

/** The confirmation dialog's words for a change, with the send limit it will have. */
export function confirmCopy(
  kind: AgentConfirm,
  agents: Agents,
  patch: AgentSettingsPatch,
): ConfirmCopy {
  if (kind === "full") {
    return {
      title: "Give AI agents full access?",
      body: [
        "Agents will be able to read every conversation, including texts from strangers, and send messages to anyone without asking you.",
        RISK,
      ],
      action: "Allow full access",
    };
  }
  const limit = patch.sendLimit === undefined ? agents.sendLimit : patch.sendLimit;
  return {
    title: "Let agents send without asking?",
    body: [
      "Agents will be able to send messages to anyone, including people you've never texted, without asking you.",
      RISK,
      limit === null
        ? "Messages to conversations you've hidden still become drafts for you, but there's no limit on how many messages they can send."
        : `Messages to conversations you've hidden still become drafts for you, and sends are capped at ${limit} every 10 minutes.`,
    ],
    action: "Send without asking",
  };
}

/** The send limits the dropdown offers, per 10 minutes. */
export const SEND_LIMITS = [5, 10, 20, 30, 60] as const;

/** The dropdown's value for no limit (stored as null). */
const NO_LIMIT = "none";

/**
 * The send limit dropdown's choices, as strings for the dropdown: No limit and the usual steps,
 * plus the current value when it was set some other way (the CLI takes any number up to 60).
 */
export function sendLimitOptions(current: number | null): Array<[string, string]> {
  const values: number[] = [...SEND_LIMITS];
  if (current !== null && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return [[NO_LIMIT, "No limit"], ...values.map((n): [string, string] => [String(n), String(n)])];
}

/** The send limit as the dropdown's value. */
export function sendLimitValue(limit: number | null): string {
  return limit === null ? NO_LIMIT : String(limit);
}

/** The send limit a dropdown value stands for: null for no limit. */
export function parseSendLimitValue(value: string): number | null {
  return value === NO_LIMIT ? null : Number(value);
}

/** The Send limit row's description. */
export function sendLimitHint(limit: number | null): string {
  return limit === null
    ? "Agents can send any number of messages, including drafts they queue for you."
    : "The most messages agents can send per 10 minutes, including drafts they queue for you.";
}

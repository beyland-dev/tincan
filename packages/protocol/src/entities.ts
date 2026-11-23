import { z } from "zod";
import { ERROR_CODES } from "./errors.ts";

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative();

/**
 * A normalized address: `tel:+15551234567` (E.164; short codes keep their bare digits),
 * `email:someone@example.com`, `sender:<id>` for an alphanumeric SMS sender (read-only), or
 * `handle:<token>` when real addresses are hidden from AI agents.
 */
export const Handle = z
  .string()
  .regex(
    /^(tel:\+?[0-9]+|email:[^\s@]+@[^\s@]+|sender:\S+|handle:[A-Za-z0-9_-]+)$/,
    "Expected tel:+<digits>, email:<address>, sender:<id> or handle:<token>",
  );
export type Handle = z.infer<typeof Handle>;

/**
 * Stable thread identity: a handle for direct threads, `handle:<token>` when handles are masked
 * for AI agents, or `group:name:<slug>` / `group:members:<sorted-slugs>` for group threads.
 */
export const ThreadKey = z
  .string()
  .regex(/^(tel:|email:|sender:|handle:|group:name:|group:members:).+$/, "Expected a thread key");
export type ThreadKey = z.infer<typeof ThreadKey>;

export const BluetoothAddress = z
  .string()
  .regex(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i, "Expected a Bluetooth address (AA:BB:CC:DD:EE:FF)");

export const ConnectionState = z.enum(["unpaired", "disconnected", "connecting", "connected"]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/**
 * - `denied`: the iPhone refused access (a sharing toggle is off).
 * - `refused`: the iPhone keeps saying it doesn't offer the profile to this computer, usually a
 *   stale pairing on the iPhone's side.
 */
export const ProfileState = z.enum([
  "unavailable",
  "denied",
  "refused",
  "idle",
  "connecting",
  "ready",
]);
export type ProfileState = z.infer<typeof ProfileState>;

export const Device = z.object({
  address: BluetoothAddress,
  name: z.string(),
  paired: z.boolean(),
  connected: z.boolean(),
  /** The user disconnected it from Tincan; it stays disconnected until they connect it again. */
  paused: z.boolean().optional(),
  state: ConnectionState,
  profiles: z.object({
    map: ProfileState,
    pbap: ProfileState,
    ancs: ProfileState,
  }),
});
export type Device = z.infer<typeof Device>;

export const LabeledValue = z.object({ label: z.string().nullable(), value: z.string() });
export type LabeledValue = z.infer<typeof LabeledValue>;

/** What else the phone's card says. iOS shares only some of these over PBAP. */
export const ContactDetails = z.object({
  nickname: z.string().optional(),
  company: z.string().optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  birthday: z.string().optional(),
  note: z.string().optional(),
  addresses: z.array(LabeledValue).optional(),
  urls: z.array(LabeledValue).optional(),
});
export type ContactDetails = z.infer<typeof ContactDetails>;

export const Contact = z.object({
  id: z.string(),
  name: z.string(),
  handles: z.array(Handle),
  hasPhoto: z.boolean(),
  /** The phone's label for each handle that has one ("mobile", "work", …). */
  labels: z.record(z.string(), z.string()).optional(),
  details: ContactDetails.optional(),
  /**
   * The user hid this person from AI agents (`agents.hide`): the contact, all their numbers and
   * emails, and every group they're in. Desktop app and CLI only; agents never see such contacts.
   */
  hiddenFromAgents: z.boolean().optional(),
});
export type Contact = z.infer<typeof Contact>;

export const ReactionKind = z.enum([
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "other",
]);
export type ReactionKind = z.infer<typeof ReactionKind>;

export const Reaction = z.object({
  kind: ReactionKind,
  from: Handle.nullable(),
  text: z.string(),
});
export type Reaction = z.infer<typeof Reaction>;

/**
 * `scheduled`: held on this computer for the send delay (`sendAt`), not yet handed to the phone; it
 * can still be cancelled. `pending`: going to the phone (or waiting for it to connect).
 */
export const MessageStatus = z.enum([
  "received",
  "scheduled",
  "pending",
  "sent",
  "failed",
  "unknown",
]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** Attachments Tincan can't show, best effort from the ANCS text or a MAP body placeholder. */
export const AttachmentHint = z.object({
  count: z.number().int().positive().optional(),
  kinds: z.array(z.enum(["image", "video", "audio", "file"])).optional(),
});
export type AttachmentHint = z.infer<typeof AttachmentHint>;

export const MessageAgent = z.object({
  name: z.string().optional(),
  edited: z.boolean(),
  via: z.enum(["user", "policy"]),
});
export type MessageAgent = z.infer<typeof MessageAgent>;

/**
 * Why an outgoing message didn't send: the error code of its last attempt (`NOT_CONNECTED`: the
 * phone didn't connect in time), or `PAUSED`/`RESTARTED` for one of the user's own messages whose
 * send delay ended long before Tincan could send it, while the computer slept (`PAUSED`) or
 * Tincan wasn't running (`RESTARTED`). Tincan didn't send those; retrying sends them.
 */
export const SendFailureCode = z.enum([...ERROR_CODES, "PAUSED", "RESTARTED"]);
export type SendFailureCode = z.infer<typeof SendFailureCode>;

export const MessageFailure = z.object({ code: SendFailureCode });
export type MessageFailure = z.infer<typeof MessageFailure>;

export const Message = z.object({
  id: z.string(),
  threadKey: ThreadKey,
  direction: z.enum(["incoming", "outgoing"]),
  sender: Handle.nullable(),
  body: z.string(),
  sentAt: Timestamp.nullable(),
  /** Local-timezone ISO-8601 timestamp for `sentAt` (e.g. `2026-11-20T14:05:00-05:00`). */
  sentAtIso: z.string().nullable().optional(),
  receivedAt: Timestamp,
  /** Local-timezone ISO-8601 timestamp for `receivedAt`. */
  receivedAtIso: z.string().optional(),
  source: z.enum(["map", "ancs", "local"]),
  status: MessageStatus,
  read: z.boolean(),
  mapHandle: z.string().optional(),
  reactions: z.array(Reaction).default([]),
  /**
   * Set on a tapback. One with `reactionTo` is folded into that message's `reactions` and never
   * listed on its own; one without is a tapback Tincan couldn't place: show it as a small note.
   */
  reaction: ReactionKind.optional(),
  reactionTo: z.string().optional(),
  attachmentHint: AttachmentHint.optional(),
  /** For a `scheduled` message: when it goes to the phone, unless it's cancelled first. */
  sendAt: Timestamp.optional(),
  /**
   * Set on a message an AI agent wrote: sent from an agent draft (`via: "user"`, the user pressed
   * Send) or sent directly as the send policy allowed (`via: "policy"`). `edited`: the user changed
   * the agent's text first. `name` (the agent's self-reported name) is for the desktop app and CLI;
   * agents get `{ edited, via }` only.
   */
  agent: MessageAgent.optional(),
  /**
   * On a `failed` message: why, when Tincan knows. For the desktop app and CLI; an agent gets it
   * only on its own messages.
   */
  failure: MessageFailure.optional(),
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
  key: ThreadKey,
  kind: z.enum(["direct", "group"]),
  title: z.string(),
  members: z.array(Handle),
  lastMessage: Message.nullable(),
  unread: z.number().int().nonnegative(),
  muted: z.boolean(),
  /**
   * Hidden from AI agents (`agents.hide`): agents never see it until the user shows it to them
   * again, whatever new messages arrive. A one-to-one conversation is hidden when its person is;
   * a group when the user hid the group, or anyone in it. Desktop app and CLI only, like
   * `hiddenBy` and `hiddenPerson` (agents don't see such conversations).
   */
  hiddenFromAgents: z.boolean().optional(),
  /**
   * Why it's hidden from agents: `group`, the user hid this group conversation (`agents.show`
   * with its key shows it again); `person`, a hidden person is in it (show them instead).
   */
  hiddenBy: z.enum(["person", "group"]).optional(),
  /**
   * The hidden person it's with, or (for a group) the first hidden member: for "Hidden because
   * Mom is hidden". Set whenever a member is hidden, even when the group is hidden itself too.
   */
  hiddenPerson: z.object({ id: z.string(), label: z.string() }).optional(),
  pinned: z.boolean(),
  /** True when this conversation is with the user's own phone number or email address. */
  isSelf: z.boolean().optional(),
  /**
   * The user's own saved draft (agent drafts are separate: `draft.list`). Only for the desktop app
   * and CLI; agents never get it.
   */
  draft: z.object({ text: z.string(), updatedAt: Timestamp }).optional(),
});
export type Thread = z.infer<typeof Thread>;

/**
 * Someone the user hid from AI agents: a contact (with every number and email it has, or had), or
 * a raw number or email address. Agents can't read conversations with any of `handles`, any group
 * with one of them in it, or (while it's linked) the contact. Desktop app and CLI only.
 */
export const HiddenPerson = z.object({
  /** A UUIDv7, for `agents.show`. */
  id: z.string(),
  /** The contact's name, or the number or address for a raw one; kept when the contact is deleted. */
  label: z.string(),
  /** The contact it follows (rebound when the iPhone changes the card); null for a raw handle or a deleted contact. */
  contactId: z.string().nullable(),
  /** It was hidden as a contact that the iPhone no longer has: its numbers and emails stay hidden. */
  contactRemoved: z.boolean(),
  /** Every hidden number and email address, sorted. Ones the iPhone removed from the card stay. */
  handles: z.array(Handle),
  createdAt: Timestamp,
});
export type HiddenPerson = z.infer<typeof HiddenPerson>;

/** A group conversation the user hid from AI agents itself (not just through a hidden member). */
export const HiddenGroup = z.object({
  threadKey: ThreadKey,
  title: z.string(),
});
export type HiddenGroup = z.infer<typeof HiddenGroup>;

/**
 * A group thread as Tincan has pieced it together from Messages notifications. `participants` are
 * display names from an unnamed group's notification; `roster` is a member list the user saved.
 * A sender outside the roster sets `routeInvalidated` until the user reviews it.
 */
export const Group = z.object({
  threadKey: ThreadKey,
  name: z.string().nullable(),
  named: z.boolean(),
  participants: z.array(z.string()),
  roster: z.array(Handle).nullable(),
  routeInvalidated: z.boolean(),
});
export type Group = z.infer<typeof Group>;

/**
 * How much agents may do, picked in Settings › AI agents. Each level caps the other settings:
 * see `effectiveAgents`. `off`: only status and settings. `readOnly`: read, nothing else.
 * `assistant`: read, draft, manage and send, with the privacy protections always on and a send
 * limit unless the user turns it off. `full`: everything the user allows, including turning the
 * privacy protections off; sends have no limit and, with `send: always`, never become drafts for
 * the user to review.
 */
export const AgentAccess = z.enum(["off", "readOnly", "assistant", "full"]);
export type AgentAccess = z.infer<typeof AgentAccess>;
/**
 * Which conversations agents may read. `contacts`: every member is a saved contact (or you, in
 * your own self-conversation). `known`: those, plus conversations you've sent a message in
 * yourself (agent sends, even ones you sent from an agent draft, don't count). `all`: every
 * conversation you haven't hidden from agents.
 */
export const AgentReadPolicy = z.enum(["off", "contacts", "known", "all"]);
export type AgentReadPolicy = z.infer<typeof AgentReadPolicy>;
/**
 * What an agent's `message.send` does. `approve`: it becomes an agent draft in the conversation's
 * composer, for you to send, edit or discard. `replied`: messages to people you've texted yourself
 * go (after the agent send delay); anyone else becomes a draft. `always`: messages go. People and
 * groups you hid from agents always become drafts, at every access level. Under `assistant`,
 * short codes and raw numbers (while those are hidden from agents) still become drafts too, and
 * the send limit applies; under `full` they don't and there's no limit.
 */
export const AgentSendPolicy = z.enum(["never", "approve", "replied", "always"]);
export type AgentSendPolicy = z.infer<typeof AgentSendPolicy>;
export const AgentHandlePolicy = z.enum(["hidden", "visible"]);

/** The highest send limit the user can set, per 10 minutes (`assistant`; null means no limit). */
export const AGENT_SEND_LIMIT_MAX = 60;

/**
 * How long a message waits on this computer before it goes to the phone, in seconds (0: no
 * delay). Until then it can be cancelled; once the phone has it, it can't be unsent.
 */
export const SendDelaySeconds = z.number().int().min(0).max(300);

/**
 * A change to the agent settings: only the fields given change. No defaults here, so a patch
 * never resets a field it doesn't mention.
 */
export const AgentSettingsPatch = z.object({
  access: AgentAccess.optional(),
  read: AgentReadPolicy.optional(),
  send: AgentSendPolicy.optional(),
  sendLimit: z.number().int().min(1).max(AGENT_SEND_LIMIT_MAX).nullable().optional(),
  sendDelaySeconds: SendDelaySeconds.optional(),
  manage: z.boolean().optional(),
  handles: AgentHandlePolicy.optional(),
  hideCodes: z.boolean().optional(),
});
export type AgentSettingsPatch = z.infer<typeof AgentSettingsPatch>;

export const Settings = z.object({
  agents: z.object({
    /** How much agents may do; caps everything below (see `effectiveAgents`). */
    access: AgentAccess,
    read: AgentReadPolicy,
    send: AgentSendPolicy,
    /** Messages an agent may send per 10 minutes with `assistant` access, or null for no limit. */
    sendLimit: z.number().int().min(1).max(AGENT_SEND_LIMIT_MAX).nullable().default(10),
    /**
     * The send delay for agents' messages: every direct agent send, and every message the user
     * sends from an agent draft. Applies at every access level; `accessPatch` never changes it.
     */
    sendDelaySeconds: SendDelaySeconds.default(10),
    /** Whether agents may mark conversations read, mute or pin them. */
    manage: z.boolean().default(false),
    /** Whether phone numbers and emails are masked behind opaque IDs (only `full` can show them). */
    handles: AgentHandlePolicy.default("hidden"),
    /** Whether verification codes and short-code senders are hidden (only `full` can show them). */
    hideCodes: z.boolean().default(true),
  }),
  notifications: z.object({
    /** What a notification shows: the message, only who sent it, or neither. */
    preview: z.enum(["full", "sender", "hidden"]),
  }),
  defaultRegion: z.string().length(2),
  /** The send delay for the user's own messages (default 0: off). */
  sendDelaySeconds: SendDelaySeconds.default(0),
});
export type Settings = z.infer<typeof Settings>;

/**
 * The settings as an AI agent sees them (`settings.get`, `settings.changed`): only the agent
 * policy. Notifications, the default country and the user's own send delay are the user's.
 */
export const AgentVisibleSettings = Settings.pick({ agents: true });
export type AgentVisibleSettings = z.infer<typeof AgentVisibleSettings>;

export const DEFAULT_SETTINGS: Settings = {
  agents: {
    access: "off",
    read: "known",
    send: "approve",
    sendLimit: 10,
    sendDelaySeconds: 10,
    manage: false,
    handles: "hidden",
    hideCodes: true,
  },
  notifications: { preview: "full" },
  defaultRegion: "US",
  sendDelaySeconds: 0,
};

/** The agent settings as enforced: `access` applied to everything else. */
export interface EffectiveAgents {
  access: AgentAccess;
  read: AgentReadPolicy;
  send: AgentSendPolicy;
  /** Sends per 10 minutes, or null for no limit (always with `full`; the user's choice with `assistant`). */
  sendLimit: number | null;
  /** The agent send delay; the same at every access level. */
  sendDelaySeconds: number;
  manage: boolean;
  handles: "hidden" | "visible";
  hideCodes: boolean;
  /**
   * Whether sends that would reveal something hidden from agents (a short code or raw number
   * while those are hidden) still become drafts, even with `send: always`. False only with `full`
   * access. People and groups the user hid from agents always become drafts, whatever this says.
   */
  guardHidden: boolean;
}

/**
 * What agents may actually do: the stored settings capped by `access`. Settings a level doesn't
 * show keep their stored value but have no effect, so dropping from `full` to `assistant` turns
 * the privacy protections back on without forgetting the user's choices.
 */
export function effectiveAgents(agents: Settings["agents"]): EffectiveAgents {
  const { access } = agents;
  const privacyOn = { handles: "hidden" as const, hideCodes: true };
  const sendDelaySeconds = agents.sendDelaySeconds ?? 10;
  switch (access) {
    case "off":
      return {
        access,
        read: "off",
        send: "never",
        sendLimit: agents.sendLimit,
        sendDelaySeconds,
        manage: false,
        ...privacyOn,
        guardHidden: true,
      };
    case "readOnly":
      return {
        access,
        read: agents.read === "off" ? "known" : agents.read,
        send: "never",
        sendLimit: agents.sendLimit,
        sendDelaySeconds,
        manage: false,
        ...privacyOn,
        guardHidden: true,
      };
    case "assistant":
      return {
        access,
        read: agents.read,
        send: agents.send === "never" ? "approve" : agents.send,
        sendLimit: agents.sendLimit,
        sendDelaySeconds,
        // Inbox actions find conversations by reading, so they need it on.
        manage: agents.read !== "off" && agents.manage,
        ...privacyOn,
        guardHidden: true,
      };
    case "full":
      return {
        access,
        read: agents.read,
        send: agents.send === "never" ? "approve" : agents.send,
        sendLimit: null,
        sendDelaySeconds,
        // Inbox actions find conversations by reading, so they need it on.
        manage: agents.read !== "off" && agents.manage,
        handles: agents.handles,
        hideCodes: agents.hideCodes,
        guardHidden: false,
      };
  }
}

/**
 * The change to make when the user picks an access level: the level, plus a sensible starting
 * point for the settings it shows. `full` starts with everything on; the privacy options keep
 * their values (on, unless the user turned them off under `full` before). The send delays are
 * never changed.
 */
export function accessPatch(access: AgentAccess, current: Settings["agents"]): AgentSettingsPatch {
  switch (access) {
    case "off":
      return { access };
    case "readOnly":
      return { access, read: current.read === "off" ? "known" : current.read };
    case "assistant":
      return {
        access,
        send: current.send === "never" || current.access !== "assistant" ? "approve" : current.send,
      };
    case "full":
      return { access, read: "all", send: "always", manage: true };
  }
}

export const ClientKind = z.enum(["desktop", "cli", "mcp"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const ClientInfo = z.object({
  kind: ClientKind,
  name: z.string().min(1).max(100),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

/**
 * Why an agent's message needed the user even though the send policy might have let it go: the
 * recipient is someone (or in a conversation) the user hid from agents, a short code, or outside
 * what agents may read. Shown to the user in the desktop app and CLI; never sent to agents.
 */
export const AgentDraftNote = z.enum(["hidden", "shortCode", "outOfScope"]);
export type AgentDraftNote = z.infer<typeof AgentDraftNote>;

/**
 * - `queued`: waiting in the conversation's composer for the user to send, edit or discard it.
 * - `scheduled`: sent (by the user, or directly by the agent as the send policy allows) and held
 *   for the agent send delay; Undo puts a user-sent draft back in the queue.
 * - `sent` / `failed`: handed to the phone, or the phone refused it.
 * - `discarded`: the user (or the agent, while it was still queued) threw it away.
 * - `cancelled`: the user cancelled the agent's direct send during its delay.
 */
export const AgentDraftState = z.enum([
  "queued",
  "scheduled",
  "sent",
  "failed",
  "discarded",
  "cancelled",
]);
export type AgentDraftState = z.infer<typeof AgentDraftState>;

/**
 * A message an AI agent wrote: an agent draft (`message.draft.save`), or an agent send that needs
 * the user (or went directly, for outcome tracking). Local to this computer, never synced. Queued
 * drafts show in the conversation's composer, oldest first, beside the user's own draft (which an
 * agent never touches). They never expire.
 *
 * Agents see only their own, as `AgentDraftView`: `threadKey` and `to` masked (or exactly what the
 * agent typed, `requestedAs`, for a raw number while handles are hidden), never `note`, and the
 * current `text` and `messageId` only when the agent may read the conversation.
 */
export const AgentDraft = z.object({
  /** `drf_<uuidv7>`. */
  id: z.string(),
  /** The conversation, or null while there is none yet with `to` (or, for agents, it's out of reach). */
  threadKey: ThreadKey.nullable(),
  /**
   * Who it goes to: the normalized `tel:`/`email:` key (masked for agents, or what the agent typed
   * when that was a raw number or address while handles are hidden).
   */
  to: z.string(),
  /** What the agent typed for the recipient, when that was a raw number or address while handles were hidden. */
  requestedAs: z.string().optional(),
  /** The agent's self-reported name, cleaned up for display. A label, not an identity. */
  agentName: z.string(),
  /** `draft`: saved with `message.draft.save`. `send`: an agent's `message.send`. */
  intent: z.enum(["draft", "send"]),
  /** The agent's original text; never changes. */
  body: z.string(),
  /** The current text, with the user's edits. Left out for agents that may not read the conversation. */
  text: z.string().optional(),
  /** The user changed the text. */
  edited: z.boolean(),
  /** Bumped on every change to the text, for `draft.update` and `draft.send`. */
  revision: z.number().int().nonnegative(),
  state: AgentDraftState,
  /** The message once scheduled or sent (left out for agents that may not read the conversation). */
  messageId: z.string().optional(),
  /** Desktop app and CLI only. */
  note: AgentDraftNote.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** When it was sent, failed, discarded or cancelled. */
  resolvedAt: Timestamp.nullable(),
});
export type AgentDraft = z.infer<typeof AgentDraft>;

/** An agent draft as an agent sees it: the same shape, with the fields above left out. */
export const AgentDraftView = AgentDraft;
export type AgentDraftView = AgentDraft;

export const DoctorCheck = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["ok", "warn", "fail", "skip"]),
  detail: z.string(),
  hint: z.string().optional(),
  autoFix: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  generatedAt: Timestamp,
  /** Whether a running daemon produced the report (otherwise phone checks are skipped). */
  daemon: z.boolean(),
  checks: z.array(DoctorCheck),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

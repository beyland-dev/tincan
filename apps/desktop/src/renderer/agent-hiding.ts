import {
  effectiveAgents,
  type Contact,
  type HiddenGroup,
  type HiddenPerson,
  type Settings,
  type Thread,
} from "@beyland/tincan-protocol";
import { formatHandle } from "./format.ts";

/**
 * Hiding people and groups from AI agents: when the app offers it, what its actions say, why a
 * conversation is hidden, and what the picker in Settings offers. A person is a contact (with all
 * their numbers and emails) or a raw number or address; a group is hidden itself, or because
 * someone in it is. The daemon enforces it; this only decides what the app shows.
 */

/** Whether AI agents can do anything at all, so hiding from them means something. */
export function agentsOn(settings: Pick<Settings, "agents"> | null | undefined): boolean {
  return !!settings && effectiveAgents(settings.agents).access !== "off";
}

/** What `agents.hide` takes: exactly one of these. */
export type HideTarget = { contactId: string } | { handle: string } | { groupKey: string };
/** What `agents.show` takes: exactly one of these. */
export type ShowTarget = { personId: string } | { groupKey: string };

export type HideAction =
  | { kind: "hide"; label: string; icon: "hide"; hint: string; target: HideTarget }
  | { kind: "show"; label: string; icon: "eye"; hint: string; target: ShowTarget }
  /** A group hidden only through a hidden member: showing it means showing them, from group info. */
  | { kind: "explain"; label: string; icon: "hide"; hint: string };

/** "number", "email" or "sender", for a handle with no contact. */
function handleNoun(handle: string): string {
  if (handle.startsWith("tel:")) return "number";
  if (handle.startsWith("email:")) return "email";
  return "sender";
}

/** Whether a hidden person's label is just `handle` (with or without its prefix, or formatted). */
function isRawLabel(label: string, handle: string): boolean {
  const value = handle.slice(handle.indexOf(":") + 1);
  return label === handle || label === value || label === formatHandle(handle);
}

/** A hidden person's label as the app shows it: a raw number (`+12065550101`) formatted. */
export function displayLabel(label: string): string {
  return /^\+?\d+$/.test(label) ? formatHandle(`tel:${label}`) : label;
}

/** A hidden person's name for the Settings list: a raw number formatted the way the app shows it. */
export function hiddenPersonLabel(
  person: Pick<HiddenPerson, "label" | "contactId" | "contactRemoved" | "handles">,
): string {
  const only = person.handles[0];
  if (!person.contactId && !person.contactRemoved && only && isRawLabel(person.label, only)) {
    return formatHandle(only);
  }
  return person.label;
}

/**
 * The action to hide a person from agents, or show them again: a contact by name, a raw number or
 * address as "number" or "email". `hiddenAs` is the hidden person, when they are hidden.
 */
export function personAction(
  handle: string,
  contact: Pick<Contact, "id" | "name"> | undefined,
  hiddenAs: { id: string; label: string } | undefined,
): HideAction {
  // A raw number's label is the number itself; a deleted contact's keeps their name.
  const raw = hiddenAs && isRawLabel(hiddenAs.label, handle);
  const name = contact?.name ?? (hiddenAs && !raw ? hiddenAs.label : undefined);
  const who = name ?? handleNoun(handle);
  if (hiddenAs) {
    return {
      kind: "show",
      label: `Show ${who} to agents`,
      icon: "eye",
      hint: name
        ? `Let AI agents see ${name} again, with all their numbers and emails.`
        : `Let AI agents see this ${who} again.`,
      target: { personId: hiddenAs.id },
    };
  }
  return {
    kind: "hide",
    label: `Hide ${who} from agents`,
    icon: "hide",
    hint: name
      ? `AI agents won't see ${name}, any of their numbers and emails, or groups they're in.`
      : `AI agents won't see this ${who}, or groups it's in.`,
    target: contact ? { contactId: contact.id } : { handle },
  };
}

/**
 * The hide or show action for a conversation, or null while agents are off. A one-to-one
 * conversation hides its person; a group hides itself, unless it's hidden only because someone
 * in it is, which is explained instead (`explain`: open group info to show them).
 */
export function threadHideAction(
  thread: Pick<
    Thread,
    "key" | "kind" | "members" | "hiddenFromAgents" | "hiddenBy" | "hiddenPerson"
  >,
  contact: Pick<Contact, "id" | "name"> | undefined,
  settings: Pick<Settings, "agents"> | null | undefined,
): HideAction | null {
  if (!agentsOn(settings)) return null;
  if (thread.kind === "direct") {
    const handle = thread.members[0] ?? thread.key;
    return personAction(handle, contact, thread.hiddenFromAgents ? thread.hiddenPerson : undefined);
  }
  if (thread.hiddenFromAgents && thread.hiddenBy === "group") {
    return {
      kind: "show",
      label: "Show group to agents",
      icon: "eye",
      hint: thread.hiddenPerson
        ? `Stops hiding the group itself. It stays hidden while ${displayLabel(thread.hiddenPerson.label)} is.`
        : "Let AI agents see this group again.",
      target: { groupKey: thread.key },
    };
  }
  if (thread.hiddenFromAgents) {
    const who = thread.hiddenPerson ? displayLabel(thread.hiddenPerson.label) : "someone in it";
    return {
      kind: "explain",
      label: `Hidden because ${who} is hidden`,
      icon: "hide",
      hint: `Show ${who} to agents in group info to let them see this group.`,
    };
  }
  return {
    kind: "hide",
    label: "Hide group from agents",
    icon: "hide",
    hint: "AI agents won't see this group until you show it to them again.",
    target: { groupKey: thread.key },
  };
}

/**
 * Why a conversation is hidden from agents, for its info panel; null when it isn't. A contact is
 * hidden with every number and email they have, and every group they're in.
 */
export function hiddenReason(
  thread: Pick<Thread, "kind" | "hiddenFromAgents" | "hiddenBy" | "hiddenPerson">,
  hasContact: boolean,
): string | null {
  if (!thread.hiddenFromAgents) return null;
  if (thread.kind === "direct") {
    return hasContact
      ? "Hidden from AI agents, including all their numbers and emails and groups they're in."
      : "Hidden from AI agents, including groups with this number or address.";
  }
  if (thread.hiddenBy === "person" && thread.hiddenPerson) {
    return `Hidden from AI agents because ${displayLabel(thread.hiddenPerson.label)} is hidden.`;
  }
  return "Hidden from AI agents.";
}

/** Which person hides each handle, from `agents.hidden`. */
export function hiddenHandles(people: readonly HiddenPerson[]): Map<string, HiddenPerson> {
  const map = new Map<string, HiddenPerson>();
  for (const person of people) for (const handle of person.handles) map.set(handle, person);
  return map;
}

/** "2 numbers · 1 email", "Contact removed" or "Not in your contacts", under a hidden person. */
export function hiddenPersonDetail(
  person: Pick<HiddenPerson, "contactId" | "contactRemoved" | "handles">,
): string {
  if (person.contactRemoved) return "Contact removed";
  if (!person.contactId) return "Not in your contacts";
  const numbers = person.handles.filter((h) => h.startsWith("tel:")).length;
  const emails = person.handles.filter((h) => h.startsWith("email:")).length;
  const parts = [
    numbers > 0 && `${numbers} number${numbers === 1 ? "" : "s"}`,
    emails > 0 && `${emails} email${emails === 1 ? "" : "s"}`,
  ].filter((p): p is string => !!p);
  return parts.join(" · ") || "Contact";
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** The Settings list: people, then groups, each by name. */
export function hiddenList(hidden: {
  people: readonly HiddenPerson[];
  groups: readonly HiddenGroup[];
}): {
  people: HiddenPerson[];
  groups: HiddenGroup[];
} {
  return {
    people: [...hidden.people].sort((a, b) => byName(hiddenPersonLabel(a), hiddenPersonLabel(b))),
    groups: [...hidden.groups].sort((a, b) => byName(a.title, b.title)),
  };
}

/** Something the "Hide person or group…" picker offers. */
export interface HideCandidate {
  /** Unique among the results. */
  id: string;
  kind: "contact" | "handle" | "group" | "typed";
  label: string;
  /** A line under the name: the group's "Group", a contact's number, "Not in your contacts". */
  detail?: string;
  target: HideTarget;
  /** For the avatar. */
  thread?: Thread;
  contact?: Contact;
}

/** How many candidates the picker shows at once. */
export const PICKER_LIMIT = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]+$/;

/** A number or address typed into the picker, as `agents.hide` takes it; null for anything else. */
export function typedHandle(query: string): string | null {
  const text = query.trim();
  if (EMAIL.test(text)) return text;
  if (PHONE.test(text) && text.replace(/\D/g, "").length >= 3) return text;
  return null;
}

/**
 * What the picker offers for `query`, leaving out whoever is hidden already. With no query:
 * recent conversations, in the list's order. Otherwise, conversations whose name or numbers match
 * every word (three or more digits match a number however it's written), then saved contacts
 * that match (even ones never texted), and last a number or address typed in full.
 */
export function hideCandidates(
  source: { threads: readonly Thread[]; contacts: readonly Contact[] },
  query: string,
  limit = PICKER_LIMIT,
): HideCandidate[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const digits = query.replace(/\D/g, "");
  const matches = (text: string, handles: readonly string[]) =>
    (digits.length >= 3 &&
      handles.some((h) => h.startsWith("tel:") && h.replace(/\D/g, "").includes(digits))) ||
    words.every((w) => [text, ...handles.map(formatHandle)].join(" ").toLowerCase().includes(w));

  const byHandle = new Map<string, Contact>();
  for (const contact of source.contacts) for (const h of contact.handles) byHandle.set(h, contact);

  const out: HideCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: HideCandidate) => {
    if (seen.has(candidate.id) || out.length >= limit) return;
    seen.add(candidate.id);
    out.push(candidate);
  };

  for (const thread of source.threads) {
    if (thread.hiddenFromAgents) continue;
    if (thread.kind === "group") {
      if (matches(thread.title, thread.members)) {
        add({
          id: `group:${thread.key}`,
          kind: "group",
          label: thread.title,
          detail: "Group",
          target: { groupKey: thread.key },
          thread,
        });
      }
      continue;
    }
    const handle = thread.members[0] ?? thread.key;
    const contact = byHandle.get(handle);
    if (contact) {
      if (!contact.hiddenFromAgents && matches(contact.name, contact.handles)) {
        add(contactCandidate(contact, thread));
      }
    } else if (matches(thread.title, [handle])) {
      add({
        id: `handle:${handle}`,
        kind: "handle",
        label: formatHandle(handle),
        detail: "Not in your contacts",
        target: { handle },
        thread,
      });
    }
  }
  if (words.length > 0) {
    const sorted = [...source.contacts].sort((a, b) => byName(a.name, b.name));
    for (const contact of sorted) {
      if (!contact.hiddenFromAgents && matches(contact.name, contact.handles))
        add(contactCandidate(contact));
    }
  }
  const typed = typedHandle(query);
  if (typed && out.length < limit && !out.some((c) => candidateHas(c, typed))) {
    out.push({
      id: `typed:${typed}`,
      kind: "typed",
      label: typed,
      detail: "Hide this number or address",
      target: { handle: typed },
    });
  }
  return out;
}

/** Whether a candidate already has a typed number (any number containing its digits) or address. */
function candidateHas(candidate: HideCandidate, typed: string): boolean {
  const handles = candidate.contact?.handles ?? candidate.thread?.members ?? [];
  if (typed.includes("@")) return handles.includes(`email:${typed.toLowerCase()}`);
  const digits = typed.replace(/\D/g, "");
  return handles.some((h) => h.startsWith("tel:") && h.replace(/\D/g, "").includes(digits));
}

function contactCandidate(contact: Contact, thread?: Thread): HideCandidate {
  const first = contact.handles[0];
  return {
    id: `contact:${contact.id}`,
    kind: "contact",
    label: contact.name,
    detail: first ? formatHandle(first) : undefined,
    target: { contactId: contact.id },
    contact,
    thread,
  };
}

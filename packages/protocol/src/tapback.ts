import type { ReactionKind } from "./entities.ts";

/**
 * A tapback as iOS spells it out in text: `Loved “See you at 6”`, or with the reactor's name when
 * it relays one from a group to a plain-text phone: `Kaia liked “See you at 6”`.
 */
export interface Tapback {
  kind: ReactionKind;
  /** iOS sent `Removed a heart from “…”`: the earlier tapback is gone. */
  removed: boolean;
  /** The quoted text, possibly cut short with `…`. */
  target: string;
  /** For `other`: the emoji or sticker name iOS reacted with. */
  emoji?: string;
  /** The name iOS put in front (`Kaia liked “…”`), when it did. */
  actor?: string;
}

const ADDED: Record<string, ReactionKind> = {
  loved: "love",
  liked: "like",
  disliked: "dislike",
  "laughed at": "laugh",
  emphasized: "emphasize",
  questioned: "question",
};

const REMOVED: Record<string, ReactionKind> = {
  "a heart": "love",
  "a like": "like",
  "a dislike": "dislike",
  "a laugh": "laugh",
  "an exclamation": "emphasize",
  "an exclamation mark": "emphasize",
  "a question mark": "question",
};

const QUOTED = String.raw`[“"](.*)[”"]`;
const VERBS = "Loved|Liked|Disliked|Laughed at|Emphasized|Questioned";
const ADDED_RE = new RegExp(String.raw`^(${VERBS}) ${QUOTED}$`, "s");
const OTHER_RE = new RegExp(String.raw`^Reacted (.+?) to ${QUOTED}$`, "s");
const REMOVED_RE = new RegExp(String.raw`^Removed (an? [a-z ]+?) from ${QUOTED}$`, "s");

// Named forms put a short name first and the verb in lower case.
const NAME = String.raw`([^\s“”"]+(?: [^\s“”"]+){0,3})`;
const NAMED_ADDED_RE = new RegExp(String.raw`^${NAME} (${VERBS.toLowerCase()}) ${QUOTED}$`, "s");
const NAMED_OTHER_RE = new RegExp(String.raw`^${NAME} reacted (.+?) to ${QUOTED}$`, "s");
const NAMED_REMOVED_RE = new RegExp(
  String.raw`^${NAME} removed (an? [a-z ]+?) from ${QUOTED}$`,
  "s",
);
/** Words that start ordinary sentences rather than name a reactor. */
const NOT_NAMES = new Set(["i", "we", "you", "he", "she", "they", "it", "everyone", "nobody"]);

/** Reads an English tapback. Null for anything else, including a message that merely looks close. */
export function parseTapback(body: string): Tapback | null {
  return plain(body) ?? named(body);
}

function plain(body: string): Tapback | null {
  let match = ADDED_RE.exec(body);
  if (match) return tapback(ADDED[match[1]!.toLowerCase()]!, false, match[2]!);
  match = OTHER_RE.exec(body);
  if (match) return tapback("other", false, match[2]!, { emoji: match[1]! });
  match = REMOVED_RE.exec(body);
  if (match) {
    const kind = REMOVED[match[1]!];
    return kind ? tapback(kind, true, match[2]!) : null;
  }
  return null;
}

function named(body: string): Tapback | null {
  let match = NAMED_ADDED_RE.exec(body);
  if (match && isName(match[1]!)) {
    return tapback(ADDED[match[2]!]!, false, match[3]!, { actor: match[1]! });
  }
  match = NAMED_OTHER_RE.exec(body);
  if (match && isName(match[1]!)) {
    return tapback("other", false, match[3]!, { emoji: match[2]!, actor: match[1]! });
  }
  match = NAMED_REMOVED_RE.exec(body);
  if (match && isName(match[1]!)) {
    const kind = REMOVED[match[2]!];
    return kind ? tapback(kind, true, match[3]!, { actor: match[1]! }) : null;
  }
  return null;
}

function isName(name: string): boolean {
  return !NOT_NAMES.has(name.toLowerCase());
}

function tapback(
  kind: ReactionKind,
  removed: boolean,
  target: string,
  extra: { emoji?: string; actor?: string } = {},
): Tapback | null {
  return target ? { kind, removed, target, ...extra } : null;
}

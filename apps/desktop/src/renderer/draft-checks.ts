import { locateVerificationCode, type AgentDraftNote } from "@beyland/tincan-protocol";
import type { IconName } from "./components/Icon.tsx";
import { linkify } from "./format.ts";

/**
 * Checks on an agent's draft before the user sends it: characters that don't show, links to
 * lookalike addresses, codes, blank stretches, and why the daemon held it for the user. Each
 * problem found is a small chip beside the draft's pill; a draft with nothing to flag shows none,
 * so a chip always means something. (A draft to someone new needs no chip: the conversation view
 * for a recipient with no conversation yet already says so.)
 */

/** A stretch of message text: shown as is, or a run of invisible characters made visible. */
export type TextPiece =
  | { kind: "text"; text: string }
  | {
      kind: "hidden";
      /** The characters as `U+XXXX`, in order. */
      codes: string[];
      /** What each one is, for a tooltip. */
      names: string[];
      /** Unicode tag characters spell ASCII invisibly ("ASCII smuggling"): what they say. */
      decoded?: string;
    };

export interface RevealedText {
  pieces: TextPiece[];
  /** How many invisible or control characters there are. */
  hidden: number;
  /** Some of them reorder text (bidi overrides, embeddings, isolates and marks). */
  bidi: boolean;
}

const NAMES: Record<number, string> = {
  0x00ad: "SOFT HYPHEN",
  0x034f: "COMBINING GRAPHEME JOINER",
  0x061c: "ARABIC LETTER MARK",
  0x115f: "HANGUL CHOSEONG FILLER",
  0x1160: "HANGUL JUNGSEONG FILLER",
  0x17b4: "KHMER VOWEL INHERENT AQ",
  0x17b5: "KHMER VOWEL INHERENT AA",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2060: "WORD JOINER",
  0x2061: "FUNCTION APPLICATION",
  0x2062: "INVISIBLE TIMES",
  0x2063: "INVISIBLE SEPARATOR",
  0x2064: "INVISIBLE PLUS",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x2800: "BRAILLE PATTERN BLANK",
  0x3164: "HANGUL FILLER",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  0xffa0: "HALFWIDTH HANGUL FILLER",
};

function isBidi(cp: number): boolean {
  return (
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isVariationSelector = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;

/** Characters that never show (or that steer how others show) wherever they are. */
function alwaysHidden(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp >= 0x7f && cp <= 0x9f) return true;
  if (isBidi(cp) || isTag(cp)) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0d) return true;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  if (cp >= 0xfff9 && cp <= 0xfffb) return true;
  if (cp >= 0x1d173 && cp <= 0x1d17a) return true;
  if (cp >= 0x2060 && cp <= 0x2065) return true;
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    cp === 0x180e ||
    cp === 0x200b ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x2800 ||
    cp === 0x3164 ||
    cp === 0xfeff ||
    cp === 0xffa0
  );
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const JOINING_LETTER = /[\p{L}\p{M}]/u;
const LATIN = /[\p{Script=Latin}\p{Script=Common}]/u;

function charOf(cp: number | undefined): string {
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * Whether the invisible character at `i` is doing an ordinary job: a joiner inside an emoji
 * sequence or between letters of a script that uses joiners (Persian, Hindi…), a single emoji or
 * text presentation selector after a character, or the tag letters of a subdivision flag (🏴 + tags
 * + cancel tag).
 */
function expected(cps: number[], i: number): boolean {
  const cp = cps[i]!;
  const prev = cps[i - 1];
  const next = cps[i + 1];
  if (cp === 0xfe0e || cp === 0xfe0f) {
    return (
      prev !== undefined &&
      !alwaysHidden(prev) &&
      !isVariationSelector(prev) &&
      !(next !== undefined && isVariationSelector(next))
    );
  }
  if (cp === 0x200d) {
    // Look past a presentation selector or skin tone on the emoji before the joiner.
    let j = i - 1;
    while (j >= 0 && (cps[j] === 0xfe0f || isSkinTone(cps[j]!))) j--;
    if (PICTOGRAPHIC.test(charOf(cps[j])) && PICTOGRAPHIC.test(charOf(next))) return true;
  }
  if (cp === 0x200c || cp === 0x200d) {
    const before = charOf(prev);
    const after = charOf(next);
    return (
      JOINING_LETTER.test(before) &&
      JOINING_LETTER.test(after) &&
      !LATIN.test(before) &&
      !LATIN.test(after)
    );
  }
  return false;
}

/** Marks the tag letters of subdivision flags (U+1F3F4, tag letters, cancel tag) as expected. */
function flagTags(cps: number[]): Set<number> {
  const ok = new Set<number>();
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== 0x1f3f4) continue;
    let j = i + 1;
    while (j < cps.length && cps[j]! >= 0xe0020 && cps[j]! <= 0xe007e) j++;
    if (j > i + 1 && cps[j] === 0xe007f) {
      for (let k = i + 1; k <= j; k++) ok.add(k);
      i = j;
    }
  }
  return ok;
}

function code(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function nameOf(cp: number): string {
  if (NAMES[cp]) return NAMES[cp]!;
  if (isTag(cp)) {
    return cp >= 0xe0020 && cp <= 0xe007e
      ? `TAG ${JSON.stringify(String.fromCharCode(cp - 0xe0000))}`
      : "TAG CHARACTER";
  }
  if (isVariationSelector(cp)) return "VARIATION SELECTOR";
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return "CONTROL CHARACTER";
  return "INVISIBLE CHARACTER";
}

/**
 * Splits text into what shows and what doesn't: invisible characters (zero-width spaces, tag
 * characters, bidi controls…) become marked runs instead of vanishing or silently reordering the
 * text around them.
 */
export function revealHidden(text: string): RevealedText {
  const cps = Array.from(text, (c) => c.codePointAt(0)!);
  const flags = flagTags(cps);
  const pieces: TextPiece[] = [];
  let plain = "";
  let hidden = 0;
  let bidi = false;
  let run: number[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const piece: TextPiece = {
      kind: "hidden",
      codes: run.map(code),
      names: run.map(nameOf),
    };
    const tags = run.filter((cp) => cp >= 0xe0020 && cp <= 0xe007e);
    if (tags.length > 0) piece.decoded = String.fromCharCode(...tags.map((cp) => cp - 0xe0000));
    pieces.push(piece);
    run = [];
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    // A CR before a LF is just a Windows line ending.
    const crlf = cp === 0x0d && cps[i + 1] === 0x0a;
    const invisible =
      !flags.has(i) &&
      !crlf &&
      (alwaysHidden(cp) ||
        cp === 0x0d ||
        ((isVariationSelector(cp) || cp === 0x200c || cp === 0x200d) && !expected(cps, i)));
    if (invisible) {
      if (plain) pieces.push({ kind: "text", text: plain });
      plain = "";
      run.push(cp);
      hidden++;
      if (isBidi(cp)) bidi = true;
    } else {
      flushRun();
      plain += String.fromCodePoint(cp);
    }
  }
  flushRun();
  if (plain) pieces.push({ kind: "text", text: plain });
  return { pieces, hidden, bidi };
}

/** A web address in message text, with its host as ASCII (punycode for international names). */
export interface FoundLink {
  text: string;
  host: string;
  /** The host uses international characters (`xn--`), which can imitate another name. */
  international: boolean;
}

/** Common top-level domains: a bare `name.tld` with one of these is a link on the recipient's phone. */
const BARE_TLDS =
  "com|net|org|io|co|app|dev|me|ly|gl|gg|tv|xyz|info|biz|us|uk|ca|de|fr|ru|cn|in|au|ai|link|click|top|site|online|shop|store|live|page|pay|bank|login|support|help|cc|to|su|tk|ml|ga|cf|gq|ws";
const BARE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}@./-])((?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.)+(?:${BARE_TLDS}))(?![\\p{L}\\p{N}-])(?:[/?#][^\\s<>"]*)?`,
  "giu",
);

function hostOf(raw: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The links in message text: full `http(s)://` and `www.` links, and bare domains with a common
 * top-level domain (the recipient's phone makes those clickable too). Each once, in order.
 */
export function linksIn(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const host = hostOf(raw);
    if (!host || seen.has(raw)) return;
    seen.add(raw);
    found.push({
      text: raw,
      host,
      international: host.split(".").some((l) => l.startsWith("xn--")),
    });
  };
  let rest = "";
  for (const part of linkify(text)) {
    if (typeof part === "string") rest += part;
    else {
      add(part.url);
      rest += " ".repeat(part.text.length);
    }
  }
  for (const match of rest.matchAll(BARE_DOMAIN)) add(match[0]);
  return found;
}

/** The distinct hosts of some links, in order. */
export function hostsOf(links: FoundLink[]): string[] {
  return [...new Set(links.map((l) => l.host))];
}

/** Long runs of blank lines or spaces, which can push the rest of a message out of sight. */
export function hasBlankGap(text: string): boolean {
  return /(?:[ \t]*\r?\n){5,}/.test(text) || /[ \t\u00A0\u2000-\u200A\u3000]{40,}/.test(text);
}

/** The text with every character `revealHidden` marks taken out ("Remove hidden characters"). */
export function stripHidden(text: string): string {
  return revealHidden(text)
    .pieces.map((p) => (p.kind === "text" ? p.text : ""))
    .join("");
}

/** A warning beside an agent draft's pill. */
export interface DraftChip {
  id: "hidden" | "lookalike" | "code" | "gap" | "note";
  tone: "info" | "warn" | "danger";
  icon: IconName;
  label: string;
  tip?: string;
}

const NOTES: Record<AgentDraftNote, Pick<DraftChip, "label" | "tip" | "icon">> = {
  hidden: {
    label: "Hidden from AI agents",
    icon: "hide",
    tip: "You hid this conversation, so agents can't read it. An agent's message to it always waits here for you, whatever your settings.",
  },
  shortCode: {
    label: "Short-code sender",
    icon: "shield",
    tip: "A short number businesses use for things like verification codes. Agents can't see these while verification codes are hidden, so their messages to one wait for you.",
  },
  outOfScope: {
    label: "Outside what agents can read",
    icon: "shield",
    tip: "Your settings don't let agents read conversations with this recipient, so their messages to it wait for you.",
  },
};

export interface ChipContext {
  /** Why the daemon held it for the user (desktop only). */
  note?: AgentDraftNote;
}

/**
 * Real warnings about an agent's draft, most serious first; empty for an ordinary draft, links
 * to ordinary addresses and new recipients included.
 */
export function draftChips(text: string, context: ChipContext = {}): DraftChip[] {
  const chips: DraftChip[] = [];
  const revealed = revealHidden(text);
  if (revealed.hidden > 0) {
    chips.push({
      id: "hidden",
      tone: revealed.bidi ? "danger" : "warn",
      icon: "hide",
      label: `${revealed.hidden} hidden character${revealed.hidden === 1 ? "" : "s"}${revealed.bidi ? ", including text-direction controls" : ""}`,
      tip: "Characters you can't see. On the recipient's phone they can hide or reorder text.",
    });
  }
  const lookalikes = hostsOf(linksIn(text).filter((l) => l.international));
  if (lookalikes.length > 0) {
    chips.push({
      id: "lookalike",
      tone: "warn",
      icon: "link",
      label: `${lookalikes.length === 1 ? "Link to" : "Links to"} ${lookalikes.join(", ")}`,
      tip: "An address starting xn-- uses international letters, which can imitate another site's name.",
    });
  }
  if (locateVerificationCode(text)) {
    chips.push({
      id: "code",
      tone: "warn",
      icon: "alert",
      label: "Looks like a verification code",
      tip: "Agents can be tricked by messages they read into forwarding login codes. Only send it if you meant to share it.",
    });
  }
  if (hasBlankGap(text)) {
    chips.push({
      id: "gap",
      tone: "warn",
      icon: "alert",
      label: "Long blank stretch",
      tip: "Lots of blank lines or spaces can push the rest of a message out of sight.",
    });
  }
  if (context.note) chips.push({ id: "note", tone: "info", ...NOTES[context.note] });
  return chips;
}

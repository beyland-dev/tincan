/*
 * One-time codes in texts ("Your verification code is 123456"), for the desktop app's copy banner
 * and the Copy code button on notifications. A heuristic: it only answers for texts that talk
 * about a code, and only with a single clear candidate.
 */

/** Words that mark a text as carrying a code. */
const CODE_WORDS =
  /code|passcode|otp\b|one[- ]time|verif|2fa|two[- ]factor|two[- ]step|authenticat|\bpin\b|log ?in|sign[- ]?in|código|codice/giu;

/** Codes that aren't one-time codes. */
const NOT_CODES =
  /\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|gift|referral|dress|source|error|status|tracking) codes?\b/giu;

const URLS = /\b(?:https?:\/\/|www\.)\S+/giu;

/**
 * 4–8 digits, or two groups of three ("123 456", "123-456"). Not part of a longer number, a phone
 * number, an amount, a time, a date or a decimal.
 */
const CANDIDATES =
  /(?<![\p{L}\p{N}$€£¥₹.,/@+:]|\d[ -])(\d{3}[ -]\d{3}|\d{4,8})(?![\p{L}\p{N}%°]|[.,:/]\d|[ -]\d)/gu;

const YEAR = /^(?:19|20)\d\d$/u;

/** Where a one-time code sits in a text. */
export interface LocatedCode {
  /** As you'd type it: digits only. */
  code: string;
  /** Every place it's written, as `[start, end)` offsets into the text ("123 456" included). */
  spans: Array<[number, number]>;
}

/**
 * The one-time code in `text`, as you'd type it (digits only), or null when the text doesn't read
 * like a code message or holds no single clear code.
 */
export function findVerificationCode(text: string): string | null {
  return locateVerificationCode(text)?.code ?? null;
}

/** `findVerificationCode`, with where the code is written, for highlighting it. */
export function locateVerificationCode(text: string): LocatedCode | null {
  // Blanked rather than removed, so offsets still point into `text`.
  const blank = (match: string) => " ".repeat(match.length);
  const cleaned = text.replace(URLS, blank).replace(NOT_CODES, blank);
  const words = [...cleaned.matchAll(CODE_WORDS)].map((m) => m.index);
  if (words.length === 0) return null;

  const found = new Map<string, Array<[number, number]>>();
  for (const match of cleaned.matchAll(CANDIDATES)) {
    const code = match[1]!.replace(/[ -]/gu, "");
    const span: [number, number] = [match.index, match.index + match[0].length];
    found.set(code, [...(found.get(code) ?? []), span]);
  }
  let candidates = [...found];
  // "Your code for the 2026 conference is 4821": a year is the weaker guess.
  const notYears = candidates.filter(([code]) => !YEAR.test(code));
  if (notYears.length > 0) candidates = notYears;
  if (candidates.length === 0) return null;

  // Several numbers: the one closest to the word that marks the code.
  const distance = ([, spans]: (typeof candidates)[number]) =>
    Math.min(...words.map((w) => Math.abs(w - spans[0]![0])));
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (distance(candidate) < distance(best)) best = candidate;
  }
  return { code: best[0], spans: best[1] };
}

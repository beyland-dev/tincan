import { groupNameKey, slugify, type Handle, type ThreadKey } from "@beyland/tincan-protocol";
import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

/**
 * Thread keys are the identity a conversation is stored under, so the same person must always
 * produce the same key: on every connection, from MAP and ANCS alike, and on every computer.
 *
 * - Phone numbers become E.164 (`tel:+12065550123`), read in the settings' default region when
 *   they have no country code. Short codes (six digits or fewer) keep their bare digits.
 * - Email addresses are trimmed and lowercased.
 * - Alphanumeric SMS senders (`MyBank`) become `sender:<lowercase id>`; they can't be replied to.
 * - Groups are `group:name:<slug>` or `group:members:<sorted slugs joined by +>`.
 */

const SHORT_CODE_MAX_DIGITS = 6;
const TEL_SUFFIX_DIGITS = 9;

function region(defaultRegion: string | undefined): CountryCode | undefined {
  const code = defaultRegion?.trim().toUpperCase();
  return code && isSupportedCountry(code) ? code : undefined;
}

/**
 * A phone number in E.164 (`+12065550123`), or its bare digits for a short code or a number
 * libphonenumber can't place. Null when there are no digits.
 */
export function normalizePhone(raw: string, defaultRegion?: string): string | null {
  const text = raw.trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length === 0) return null;
  const international = text.startsWith("+");
  if (!international && digits.length <= SHORT_CODE_MAX_DIGITS) return digits;

  const parsed = parsePhoneNumberFromString(text, { defaultCountry: region(defaultRegion) });
  if (parsed?.isPossible()) return parsed.number;
  return international ? `+${digits}` : digits;
}

/** A trimmed, lowercased email address, or null if it isn't one. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

/** An alphanumeric sender id: printable, no spaces, lowercase. */
function normalizeSender(raw: string): string | null {
  // oxlint-disable-next-line no-control-regex
  const id = raw.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  return id.length > 0 ? id : null;
}

/**
 * The handle for an address as the phone or the user wrote it: an email address if it has an
 * `@`, a sender id if it has a letter, otherwise a phone number.
 */
export function handleFor(raw: string, defaultRegion?: string): Handle | null {
  const text = raw.trim();
  if (text.includes("@")) {
    const email = normalizeEmail(text);
    return email ? `email:${email}` : null;
  }
  if (/\p{L}/u.test(text)) {
    const sender = normalizeSender(text);
    return sender ? `sender:${sender}` : null;
  }
  const tel = normalizePhone(text, defaultRegion);
  return tel ? `tel:${tel}` : null;
}

/**
 * Re-key a thread key from the Bluetooth layer, which keeps numbers as the phone sent them
 * (`tel:2065550123`), into its canonical form (`tel:+12065550123`). Group keys pass through.
 * Null for anything that isn't a thread key.
 */
export function normalizeThreadKey(key: string, defaultRegion?: string): ThreadKey | null {
  for (const prefix of ["group:name:", "group:members:"]) {
    if (key.startsWith(prefix)) return key.length > prefix.length ? key : null;
  }
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const scheme = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  switch (scheme) {
    case "tel": {
      const tel = normalizePhone(rest, defaultRegion);
      return tel ? `tel:${tel}` : null;
    }
    case "email": {
      const email = normalizeEmail(rest);
      return email ? `email:${email}` : null;
    }
    case "sender": {
      const sender = normalizeSender(rest);
      return sender ? `sender:${sender}` : null;
    }
    default:
      return null;
  }
}

// Shared with clients, which name groups too.
export { groupNameKey, slugify };

/**
 * The key of an unnamed group from its members' display names, as the notification lists them.
 * The user ("you") is never a member. Null with no other members.
 */
export function groupMembersKey(names: readonly string[]): ThreadKey | null {
  const slugs = names
    .map(slugify)
    .filter((slug) => slug && slug !== "you")
    .sort();
  return slugs.length > 0 ? `group:members:${slugs.join("+")}` : null;
}

/** Whether a thread is a one-to-one conversation with a phone number or email address. */
export function isDirectKey(key: string): boolean {
  return key.startsWith("tel:") || key.startsWith("email:");
}

/** Whether a key is an alphanumeric sender or a short code (`tel:` without `+`, ≤ 6 digits). */
export function isShortCode(key: string): boolean {
  if (key.startsWith("sender:")) return true;
  return /^tel:[0-9]{1,6}$/.test(key);
}

/** Whether Tincan can send to a thread: one-to-one threads with a number or email address. */
export function canReply(key: string): boolean {
  return isDirectKey(key);
}

/**
 * A coarse key that matches the same number written with or without its country code (the last
 * nine digits), for correlating ANCS notifications with MAP messages. Other keys are their own
 * bucket.
 */
export function threadBucket(key: string): string {
  if (!key.startsWith("tel:")) return key;
  const digits = key.slice(4).replace(/\D/g, "");
  if (digits.length === 0) return key;
  return `tel:${digits.length < TEL_SUFFIX_DIGITS ? digits : digits.slice(-TEL_SUFFIX_DIGITS)}`;
}

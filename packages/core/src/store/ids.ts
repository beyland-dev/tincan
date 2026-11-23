import { createHash, randomBytes } from "node:crypto";
import type { Message } from "@beyland/tincan-protocol";

/** What identifies a message that came from the phone, the same on every computer that sees it. */
export interface PhoneMessageIdentity {
  /** The phone's Bluetooth address. */
  device: string | null;
  threadKey: string;
  direction: Message["direction"];
  /** The phone's timestamp in ms. Only the second counts: MAP and ANCS report whole seconds. */
  phoneTime: number;
  body: string;
}

/**
 * The stable id of a MAP or ANCS message (ADR 0007):
 * a hash of the phone, thread, direction, phone time and body. `occurrence` tells apart identical
 * texts sent in the same second (0 for the first).
 */
export function phoneMessageId(m: PhoneMessageIdentity, occurrence: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "tincan-message-1",
        (m.device ?? "").toUpperCase(),
        m.threadKey,
        m.direction,
        Math.floor(m.phoneTime / 1000),
        m.body,
        occurrence,
      ]),
    )
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/** A random, time-ordered UUID (RFC 9562 version 7), for messages sent from this computer. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let time = Math.max(0, Math.trunc(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What identifies a phonebook entry: its name and addresses as the phone sent them. */
export interface PhoneContactIdentity {
  /** The phone's Bluetooth address. */
  device: string;
  name: string;
  tels: readonly string[];
  emails: readonly string[];
}

/**
 * The stable id of a contact pulled over PBAP: a hash of the phone, the name and the raw addresses
 * (so the default region doesn't change it). Editing a contact on the phone gives it a new id; the
 * old one is tombstoned. `occurrence` tells apart identical cards (0 for the first).
 */
export function phoneContactId(c: PhoneContactIdentity, occurrence: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "tincan-contact-1",
        c.device.toUpperCase(),
        c.name.normalize("NFC").trim(),
        c.tels.map((t) => t.trim()).sort(),
        c.emails.map((e) => e.trim().toLowerCase()).sort(),
        occurrence,
      ]),
    )
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

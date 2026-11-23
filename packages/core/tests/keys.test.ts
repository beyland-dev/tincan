import { Handle, ThreadKey } from "@beyland/tincan-protocol";
import { describe, expect, test } from "vite-plus/test";
import {
  canReply,
  groupMembersKey,
  groupNameKey,
  handleFor,
  isShortCode,
  normalizeEmail,
  normalizePhone,
  normalizeThreadKey,
  slugify,
  threadBucket,
} from "../src/keys.ts";

describe("normalizePhone", () => {
  test("national numbers take the default region", () => {
    expect(normalizePhone("(206) 555-0123", "US")).toBe("+12065550123");
    expect(normalizePhone("2065550123", "us")).toBe("+12065550123");
    expect(normalizePhone("1-206-555-0123", "US")).toBe("+12065550123");
    expect(normalizePhone("020 7946 0958", "GB")).toBe("+442079460958");
  });

  test("international numbers ignore the default region", () => {
    expect(normalizePhone("+1 206 555 0123", "GB")).toBe("+12065550123");
    expect(normalizePhone("+44 20 7946 0958", "US")).toBe("+442079460958");
  });

  test("every spelling of one number agrees", () => {
    const spellings = ["2065550123", "+12065550123", "(206) 555-0123", "1 206 555 0123"];
    expect(new Set(spellings.map((s) => normalizePhone(s, "US")))).toEqual(
      new Set(["+12065550123"]),
    );
  });

  test("short codes keep their digits", () => {
    expect(normalizePhone("12345", "US")).toBe("12345");
    expect(normalizePhone("262-966", "US")).toBe("262966");
  });

  test("numbers libphonenumber can't place keep their digits", () => {
    expect(normalizePhone("1234567", "US")).toBe("1234567");
    expect(normalizePhone("+999 1234", "US")).toBe("+9991234");
    expect(normalizePhone("2065550123", "ZZ")).toBe("2065550123");
  });

  test("no digits is no number", () => {
    expect(normalizePhone("", "US")).toBeNull();
    expect(normalizePhone(" - ", "US")).toBeNull();
  });
});

describe("handleFor", () => {
  test("picks the kind of address", () => {
    expect(handleFor(" Someone@Example.COM ", "US")).toBe("email:someone@example.com");
    expect(handleFor("206.555.0123", "US")).toBe("tel:+12065550123");
    expect(handleFor("My Bank", "US")).toBe("sender:mybank");
    expect(handleFor("", "US")).toBeNull();
    expect(handleFor("not@", "US")).toBeNull();
  });

  test("results are valid protocol handles", () => {
    for (const raw of ["a@b.co", "+12065550123", "12345", "AMAZON"]) {
      expect(Handle.safeParse(handleFor(raw, "US")).success).toBe(true);
    }
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  A.B@Example.com")).toBe("a.b@example.com");
    expect(normalizeEmail("a b@example.com")).toBeNull();
  });
});

describe("normalizeThreadKey", () => {
  test("re-keys raw keys from the Bluetooth layer", () => {
    expect(normalizeThreadKey("tel:2065550123", "US")).toBe("tel:+12065550123");
    expect(normalizeThreadKey("tel:+12065550123", "US")).toBe("tel:+12065550123");
    expect(normalizeThreadKey("tel:12345", "US")).toBe("tel:12345");
    expect(normalizeThreadKey("email:Me@Example.com", "US")).toBe("email:me@example.com");
    expect(normalizeThreadKey("sender:MyBank", "US")).toBe("sender:mybank");
  });

  test("is idempotent", () => {
    for (const key of ["tel:2065550123", "email:A@b.co", "sender:X", "group:name:book-club"]) {
      const once = normalizeThreadKey(key, "US");
      expect(once).not.toBeNull();
      expect(normalizeThreadKey(once as string, "US")).toBe(once);
      expect(ThreadKey.safeParse(once).success).toBe(true);
    }
  });

  test("rejects what isn't a key", () => {
    expect(normalizeThreadKey("", "US")).toBeNull();
    expect(normalizeThreadKey("2065550123", "US")).toBeNull();
    expect(normalizeThreadKey("tel:", "US")).toBeNull();
    expect(normalizeThreadKey("group:name:", "US")).toBeNull();
    expect(normalizeThreadKey("http://x", "US")).toBeNull();
  });
});

describe("group keys", () => {
  test("slugs collapse case and whitespace", () => {
    expect(slugify("  Book   Club ")).toBe("book-club");
    expect(slugify("Café")).toBe(slugify("Cafe\u0301"));
  });

  test("named groups", () => {
    expect(groupNameKey("Book Club")).toBe("group:name:book-club");
    expect(groupNameKey("   ")).toBeNull();
  });

  test("unnamed groups sort their members and leave out the user", () => {
    expect(groupMembersKey(["Bob", "you", "Alice Smith"])).toBe("group:members:alice-smith+bob");
    expect(groupMembersKey(["Alice Smith", "Bob"])).toBe(groupMembersKey(["bob", "alice  smith"]));
    expect(groupMembersKey(["You"])).toBeNull();
  });
});

describe("classification", () => {
  test("short codes and senders", () => {
    expect(isShortCode("tel:12345")).toBe(true);
    expect(isShortCode("sender:mybank")).toBe(true);
    expect(isShortCode("tel:+12065550123")).toBe(false);
    expect(isShortCode("tel:1234567")).toBe(false);
  });

  test("only direct threads can be replied to", () => {
    expect(canReply("tel:+12065550123")).toBe(true);
    expect(canReply("tel:12345")).toBe(true);
    expect(canReply("email:a@b.co")).toBe(true);
    expect(canReply("sender:mybank")).toBe(false);
    expect(canReply("group:name:book-club")).toBe(false);
  });

  test("buckets match a number with and without its country code", () => {
    expect(threadBucket("tel:+12065550123")).toBe(threadBucket("tel:2065550123"));
    expect(threadBucket("tel:12345")).toBe("tel:12345");
    expect(threadBucket("email:a@b.co")).toBe("email:a@b.co");
  });
});

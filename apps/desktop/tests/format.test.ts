import type { Message, Thread } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  attachmentSummary,
  attachmentLabel,
  firstLink,
  linkify,
  formatHandle,
  initials,
  isJumboEmoji,
  linkSummary,
  mergeMessages,
  placeholderLabel,
  placeholders,
  preview,
  sendFailureText,
  startsGroup,
  wroteIn,
} from "../src/renderer/format.ts";

function message(id: string, at: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    threadKey: "tel:+15550100001",
    direction: "incoming",
    sender: "tel:+15550100001",
    body: id,
    sentAt: at,
    receivedAt: at,
    source: "map",
    status: "received",
    read: false,
    reactions: [],
    ...extra,
  };
}

describe("formatHandle", () => {
  it("formats North American numbers and strips the scheme", () => {
    expect(formatHandle("tel:+15550100001")).toBe("+1 (555) 010-0001");
    // Outside North America the number is shown as stored (Ofcom's drama range, 020 7946 0xxx).
    expect(formatHandle("tel:+442079460958")).toBe("+442079460958");
    expect(formatHandle("email:a@example.com")).toBe("a@example.com");
  });
});

describe("initials", () => {
  it("takes up to two initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("cher")).toBe("C");
  });
});

describe("mergeMessages", () => {
  it("sorts oldest first, lets newer copies win and drops placed tapbacks", () => {
    const merged = mergeMessages(
      [message("b", 2000), message("a", 1000, { status: "pending" })],
      [
        message("a", 1000, { status: "sent" }),
        message("c", 3000),
        message("r", 3500, { reactionTo: "c", reaction: "love" }),
      ],
    );
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[0]?.status).toBe("sent");
  });

  it("orders by receipt when the phone gave no send time", () => {
    const merged = mergeMessages(
      [],
      [message("late", 0, { sentAt: null, receivedAt: 5000 }), message("early", 4000)],
    );
    expect(merged.map((m) => m.id)).toEqual(["early", "late"]);
  });
});

describe("scheduled messages", () => {
  const out = (id: string, at: number, extra: Partial<Message> = {}) =>
    message(id, at, { direction: "outgoing", sender: null, ...extra });

  it("sort by when they'll go", () => {
    const merged = mergeMessages(
      [],
      [out("held", 1000, { status: "scheduled", sendAt: 9000 }), message("reply", 5000)],
    );
    expect(merged.map((m) => m.id)).toEqual(["reply", "held"]);
  });

  it("don't count as the user writing in a conversation", () => {
    const thread = { lastMessage: null } as unknown as Thread;
    expect(wroteIn(thread, [out("held", 1, { status: "scheduled", sendAt: 2 })])).toBe(false);
    expect(wroteIn(thread, [out("sent", 1, { status: "sent" })])).toBe(true);
    const last = out("held", 1, { status: "scheduled" });
    expect(wroteIn({ lastMessage: last } as unknown as Thread, [])).toBe(false);
    expect(wroteIn({ lastMessage: { ...last, status: "pending" } } as unknown as Thread, [])).toBe(
      true,
    );
  });
});

describe("startsGroup", () => {
  it("breaks on a change of sender or a five-minute gap", () => {
    const first = message("a", 0);
    expect(startsGroup(undefined, first)).toBe(true);
    expect(startsGroup(first, message("b", 60_000))).toBe(false);
    expect(startsGroup(first, message("c", 6 * 60_000))).toBe(true);
    expect(startsGroup(first, message("d", 1000, { direction: "outgoing", sender: null }))).toBe(
      true,
    );
  });
});

describe("preview", () => {
  const thread = (last: Message, kind: Thread["kind"] = "direct"): Thread =>
    ({
      key: kind === "group" ? "group:name:Climbing" : "tel:+15550100001",
      kind,
      title: "x",
      members: [],
      lastMessage: last,
      unread: 0,
      muted: false,
      pinned: false,
    }) as Thread;

  it("prefixes your own messages and group senders' first names", () => {
    const names = new Map([["tel:+15550100002", "Grace Hopper"]]);
    expect(preview(thread(message("hi", 0, { direction: "outgoing" })), names)).toBe("You: hi");
    expect(preview(thread(message("yo", 0, { sender: "tel:+15550100002" }), "group"), names)).toBe(
      "Grace: yo",
    );
  });

  it("describes an attachment with no text", () => {
    const photo = message("p", 0, { body: "", attachmentHint: { count: 2, kinds: ["image"] } });
    expect(attachmentLabel(photo)).toBe("2 photos");
    expect(preview(thread(photo), new Map())).toBe("2 photos");
  });
});

describe("linkify", () => {
  it("leaves text without links alone", () => {
    expect(linkify("no links here")).toEqual(["no links here"]);
    expect(linkify("")).toEqual([]);
  });

  it("finds links and leaves sentence punctuation outside them", () => {
    expect(linkify("see https://example.com/a?b=1, then www.test.org.")).toEqual([
      "see ",
      { url: "https://example.com/a?b=1", text: "https://example.com/a?b=1" },
      ", then ",
      { url: "https://www.test.org", text: "www.test.org" },
      ".",
    ]);
  });

  it("keeps balanced brackets and drops unbalanced ones", () => {
    expect(linkify("(https://en.wikipedia.org/wiki/Tincan_(building))")).toEqual([
      "(",
      {
        url: "https://en.wikipedia.org/wiki/Tincan_(building)",
        text: "https://en.wikipedia.org/wiki/Tincan_(building)",
      },
      ")",
    ]);
  });

  it("ignores a bare scheme and finds the first link", () => {
    expect(linkify("http:// nothing")).toEqual(["http:// nothing"]);
    expect(firstLink("a http://one.example b https://two.example")).toBe("http://one.example");
    expect(firstLink("none")).toBeUndefined();
  });

  it("finds one to three emoji on their own", () => {
    expect(isJumboEmoji("😂")).toBe(true);
    expect(isJumboEmoji(" 😂🤩 ")).toBe(true);
    expect(isJumboEmoji("👍🏽❤️🇺🇸")).toBe(true);
    expect(isJumboEmoji("👨‍👩‍👧")).toBe(true);
    expect(isJumboEmoji("😂😂😂😂")).toBe(false);
    expect(isJumboEmoji("ok 😂")).toBe(false);
    expect(isJumboEmoji("1")).toBe(false);
    expect(isJumboEmoji("")).toBe(false);
  });

  it("reads iMessage's attachment and app placeholders", () => {
    expect(placeholders("plain")).toBeNull();
    expect(placeholders("\uFFFD")).toEqual({ attachments: 0, appItems: 1, text: "" });
    expect(placeholders("\uFFFC\uFFFC look")).toEqual({
      attachments: 2,
      appItems: 0,
      text: "look",
    });
    expect(placeholderLabel("\uFFFD")).toBe("Location or Messages app item");
    expect(placeholderLabel("\uFFFC")).toBe("1 attachment");
    expect(placeholderLabel("\uFFFC caption")).toBeNull();
  });

  it("reads the link summaries iOS sends", () => {
    expect(linkSummary("Website: patak (@patak.cat) (\u2066\u202Absky.app\u202C\u2069)")).toEqual({
      label: "Website",
      title: "patak (@patak.cat)",
      host: "bsky.app",
    });
    expect(linkSummary("Website: something (bsky.app)")).toBeNull();
    expect(linkSummary("hello")).toBeNull();
  });
});

describe("attachmentSummary", () => {
  it("reads the attachment descriptions iOS sends", () => {
    expect(attachmentSummary("Attachment: 1 Image")).toEqual([{ count: 1, kind: "image" }]);
    expect(attachmentSummary("Attachments: 3 Images")).toEqual([{ count: 3, kind: "image" }]);
    expect(attachmentSummary("Attachment: 1 Audio File")).toEqual([{ count: 1, kind: "audio" }]);
    expect(attachmentSummary("Attachment: 1 Sticker")).toEqual([{ count: 1, kind: "sticker" }]);
    expect(attachmentSummary("Attachments: 2 Images, 1 Video")).toEqual([
      { count: 2, kind: "image" },
      { count: 1, kind: "video" },
    ]);
    expect(attachmentSummary("Attachment: 1 File")).toEqual([{ count: 1, kind: "file" }]);
  });

  it("leaves ordinary text alone", () => {
    expect(attachmentSummary("Attachment: see below")).toBeNull();
    expect(attachmentSummary("The attachment: 1 image")).toBeNull();
  });
});

describe("sendFailureText", () => {
  it("says why one of your sends was paused", () => {
    const failed = message("m1", 1, { direction: "outgoing", status: "failed" });
    expect(sendFailureText({ ...failed, failure: { code: "PAUSED" } })).toBe(
      "Paused while your computer was asleep.",
    );
    expect(sendFailureText({ ...failed, failure: { code: "RESTARTED" } })).toBe(
      "Tincan was restarted before it was sent.",
    );
  });

  it("falls back to the plain failure otherwise", () => {
    const failed = message("m1", 1, { direction: "outgoing", status: "failed" });
    expect(sendFailureText(failed)).toBe("Not sent.");
    expect(sendFailureText({ ...failed, failure: { code: "NOT_CONNECTED" } })).toBe("Not sent.");
    expect(sendFailureText({ ...failed, status: "unknown" })).toBe("It may not have sent.");
  });
});

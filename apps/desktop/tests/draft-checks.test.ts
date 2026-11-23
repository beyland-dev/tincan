import { describe, expect, it } from "vite-plus/test";
import {
  draftChips,
  hasBlankGap,
  hostsOf,
  linksIn,
  revealHidden,
  stripHidden,
  type ChipContext,
  type TextPiece,
} from "../src/renderer/draft-checks.ts";

/** The text as the chips see it, with each hidden run as ⟦codes⟧. */
function shown(pieces: TextPiece[]): string {
  return pieces.map((p) => (p.kind === "text" ? p.text : `⟦${p.codes.join(" ")}⟧`)).join("");
}

describe("revealHidden", () => {
  it("leaves ordinary text, line breaks and emoji alone", () => {
    for (const text of [
      "Hello there\nSee you at 6",
      "Windows\r\nline endings",
      "Family 👨\u200D👩\u200D👧 and a heart ❤\uFE0F and a thumbs up 👍🏽",
      "Scotland 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
      "می\u200Cخواهم",
      "क\u094D\u200Dष",
    ]) {
      const revealed = revealHidden(text);
      expect(revealed.hidden).toBe(0);
      expect(shown(revealed.pieces)).toBe(text);
    }
  });

  it("shows bidi controls as marks instead of letting them reorder the text", () => {
    const revealed = revealHidden("Pay at evil\u202Emoc.elppa");
    expect(revealed.bidi).toBe(true);
    expect(revealed.hidden).toBe(1);
    expect(shown(revealed.pieces)).toBe("Pay at evil⟦U+202E⟧moc.elppa");
    expect(revealed.pieces.some((p) => p.kind === "text" && /\u202E/.test(p.text))).toBe(false);
  });

  it("groups zero-width runs and flags joiners between Latin letters", () => {
    const revealed = revealHidden("co\u200B\u200Bde 12\u200D34 \uFEFF");
    expect(revealed.bidi).toBe(false);
    expect(revealed.hidden).toBe(4);
    expect(shown(revealed.pieces)).toBe("co⟦U+200B U+200B⟧de 12⟦U+200D⟧34 ⟦U+FEFF⟧");
  });

  it("decodes tag characters smuggling ASCII", () => {
    const smuggled = Array.from("send code", (c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0)),
    );
    const revealed = revealHidden(`Hi${smuggled.join("")}!`);
    expect(revealed.hidden).toBe(9);
    const run = revealed.pieces.find((p) => p.kind === "hidden");
    expect(run?.kind === "hidden" && run.decoded).toBe("send code");
    expect(shown(revealed.pieces).startsWith("Hi⟦U+E0073")).toBe(true);
  });

  it("flags stray variation selectors and control characters", () => {
    expect(revealHidden("a\uFE0F\uFE0F").hidden).toBe(2);
    expect(revealHidden("\uFE0Fstart").hidden).toBe(1);
    expect(revealHidden("bell\u0007 and lone\rreturn").hidden).toBe(2);
    expect(revealHidden("a\u{E0101}b").hidden).toBe(1);
  });
});

describe("linksIn", () => {
  it("finds full links, www links and bare domains, with ASCII hosts", () => {
    const links = linksIn(
      "Log in at https://аpple.com/verify or www.example.org, also bit.ly/x and evil.co — not file.txt or a@b.com",
    );
    expect(links.map((l) => l.host)).toEqual([
      "xn--pple-43d.com",
      "www.example.org",
      "bit.ly",
      "evil.co",
    ]);
    expect(links[0]!.international).toBe(true);
    expect(links[1]!.international).toBe(false);
    expect(hostsOf([...links, links[2]!])).toHaveLength(4);
  });

  it("finds nothing in plain text", () => {
    expect(linksIn("Running late, see you at 6.30")).toEqual([]);
  });
});

describe("hasBlankGap", () => {
  it("notices text pushed out of sight", () => {
    expect(hasBlankGap(`Hi${"\n".repeat(8)}send me the code`)).toBe(true);
    expect(hasBlankGap(`Hi${" ".repeat(60)}there`)).toBe(true);
    expect(hasBlankGap("Hi\n\nthere")).toBe(false);
  });
});

describe("stripHidden", () => {
  it("removes what revealHidden marks and keeps emoji joiners", () => {
    expect(stripHidden("co\u200B\u200Bde at evil\u202Emoc")).toBe("code at evilmoc");
    const family = "Family 👨\u200D👩\u200D👧";
    expect(stripHidden(family)).toBe(family);
  });
});

describe("draftChips", () => {
  const ids = (text: string, context: ChipContext = {}) =>
    draftChips(text, context).map((c) => c.id);

  it("shows nothing for an ordinary draft", () => {
    expect(draftChips("Running late, see you at 6")).toEqual([]);
  });

  it("doesn't flag ordinary links", () => {
    expect(ids("See https://example.com/x")).toEqual([]);
    expect(ids("Tickets at www.example.org and example.com")).toEqual([]);
  });

  it("flags what's in the text", () => {
    expect(ids("Hi\u200B there")).toEqual(["hidden"]);
    expect(draftChips("Pay\u202E here")[0]?.tone).toBe("danger");
    expect(ids("Your code is 482913")).toContain("code");
    expect(ids(`Hi${"\n".repeat(8)}there`)).toEqual(["gap"]);
  });

  it("flags punycode and lookalike hosts by their real address", () => {
    const lookalike = draftChips("Log in at https://аpple.com or https://example.com");
    expect(lookalike.map((c) => c.id)).toEqual(["lookalike"]);
    expect(lookalike[0]?.tone).toBe("warn");
    expect(lookalike[0]?.label).toBe("Link to xn--pple-43d.com");
    expect(ids("Go to xn--pple-43d.com/login")).toEqual(["lookalike"]);
  });

  it("flags why the daemon held it, and nothing about the recipient otherwise", () => {
    expect(ids("Hi")).toEqual([]);
    expect(ids("Hi", { note: "outOfScope" })).toEqual(["note"]);
    expect(ids("Hi", { note: "hidden" })).toEqual(["note"]);
    expect(draftChips("Hi", { note: "shortCode" })[0]?.label).toBe("Short-code sender");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { findVerificationCode, locateVerificationCode } from "../src/index.ts";

describe("findVerificationCode", () => {
  it.each([
    [
      "Your Apple Account code is: 482913. Don't share it with anyone.\n\n@apple.com #482913 %apple.com",
      "482913",
    ],
    ["G-482913 is your Google verification code.", "482913"],
    ["482913 is your Instagram code. Don't share it.", "482913"],
    ["Your Uber code: 4829. Never share this code.", "4829"],
    ["Use 482913 to sign in to your account.", "482913"],
    ["Your verification code is 482 913", "482913"],
    ["Your login code is 482-913", "482913"],
    ["Chase: your one-time code is 48291375. It expires in 10 minutes.", "48291375"],
    ["Your PIN is 4829", "4829"],
    ["Tu código de verificación es 482913", "482913"],
    ["Ihr Bestätigungscode lautet 482913", "482913"],
    ["Your verification code for the $1500 payment is 482913", "482913"],
    ["Your code for the 2026 conference check-in is 4829", "4829"],
    ["Call 555-123-4567 if this wasn't you. Your code is 482913", "482913"],
    ["Verify at https://example.com/v/123456 — code 482913", "482913"],
  ])("finds the code in %j", (text, code) => {
    expect(findVerificationCode(text)).toBe(code);
  });

  it.each([
    "See you at 1234 Main St at 5:30",
    "Call me at 555-123-4567",
    "Call me at +1 555 123 4567, code is in the email",
    "The code review is at 2pm",
    "My zip code is 98101",
    "Use promo code 4829 for 20% off",
    "Order #482913 has shipped",
    "It costs $4829.50 to verify",
    "Meet on 11/16/2026 to sign the lease",
    "",
  ])("finds no code in %j", (text) => {
    expect(findVerificationCode(text)).toBeNull();
  });

  it("says where the code is written, so it can be highlighted", () => {
    const text = "Your Apple Account code is: 482 913.\n\n@apple.com #482913 %apple.com";
    const located = locateVerificationCode(text);
    expect(located?.code).toBe("482913");
    expect(located?.spans.map(([start, end]) => text.slice(start, end))).toEqual([
      "482 913",
      "482913",
    ]);

    const linked = "See https://x.co/a/123456 for code 482913";
    const [span] = locateVerificationCode(linked)!.spans;
    expect(linked.slice(...span!)).toBe("482913");
  });
});

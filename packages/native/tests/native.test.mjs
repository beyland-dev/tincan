// Exercises the built addon against the shared synthetic fixtures. Without a
// built `*.node` (run `pnpm build:native`) every test is skipped, so the
// workspace-wide `pnpm test` works without a Rust toolchain.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const indexUrl = new URL("../index.js", import.meta.url);
const fixture = (path) =>
  readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), "utf8");

let native;
let loadError;
try {
  native = await import(indexUrl.href);
} catch (error) {
  loadError = error;
}
const skip = native ? false : `addon not built (${loadError?.message?.split("\n")[0]})`;

describe("@beyland/tincan-native", { skip }, () => {
  it("reports the crate version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(native.nativeVersion(), pkg.version);
  });

  it("parses an incoming SMS", () => {
    const m = native.parseBMessage(fixture("bmessage/incoming-sms.bmsg"));
    assert.equal(m.valid, true);
    assert.equal(m.read, false);
    assert.equal(m.type, "SMS_GSM");
    assert.equal(m.folder, "telecom/msg/inbox");
    assert.deepEqual(m.originator, { name: "Jamie Example", tel: "+1 (555) 555-0142", email: "" });
    assert.equal(m.threadKey, "tel:+15555550142");
    assert.equal(m.recipients.length, 1);
    assert.equal(m.body, "Are we still on for lunch? 🌮");
    assert.equal(m.length, 53);
  });

  it("parses an email sender with a byte-stuffed line", () => {
    const m = native.parseBMessage(fixture("bmessage/incoming-email-multiline.bmsg"));
    assert.equal(m.threadKey, "email:riley.sample@example.com");
    assert.equal(m.body, "First line\nEND:MSG\nLast line");
    assert.equal(m.length, undefined);
  });

  it("parses a sent group message", () => {
    const m = native.parseBMessage(fixture("bmessage/sent-group.bmsg"));
    assert.equal(m.threadKey, "");
    assert.deepEqual(
      m.recipients.map((r) => r.name),
      ["Alex Placeholder", "Casey Placeholder"],
    );
  });

  it("never throws on malformed bMessages", () => {
    assert.equal(native.parseBMessage("").valid, false);
    assert.equal(native.parseBMessage("BEGIN:BMSG\r\nBEGIN:BENV").valid, true);
  });

  it("parses vCards", () => {
    const cards = native.parseVCards(fixture("vcard/phonebook.vcf"));
    assert.deepEqual(
      cards.map((c) => c.name),
      ["Jörg Müller", "Morgan Testcase", "Pat O, Example"],
    );
    assert.deepEqual(cards[0].tels[0], { value: "+1 555-555-0101", types: ["cell", "voice"] });
    assert.equal(cards[1].emails[0].value, "morgan.testcase@example.com");
    assert.equal(cards[1].photo?.mediaType.toLowerCase(), "image/jpeg");

    const calls = native.parseVCards(fixture("vcard/call-history.vcf"));
    assert.deepEqual(
      calls.map((c) => [c.callType, c.callTime]),
      [
        ["MISSED", "20260115T091500"],
        ["DIALED", "20260114T180002"],
      ],
    );
  });

  it("builds a bMessage that parses back", () => {
    const text = native.buildBMessage(["+1 555 555 0142", "riley@example.com"], "hi\nEND:MSG");
    assert.match(text, /^BEGIN:BMSG\r\n/);
    const m = native.parseBMessage(text);
    assert.equal(m.body, "hi\nEND:MSG");
    assert.deepEqual(
      m.recipients.map((r) => native.threadKeyFor(r.tel || r.email)),
      ["tel:+15555550142", "email:riley@example.com"],
    );
  });

  it("derives thread keys", () => {
    assert.equal(native.threadKeyFor("(555) 555-0199"), "tel:5555550199");
    assert.equal(native.threadKeyFor("Riley@Example.com"), "email:riley@example.com");
  });

  it("throws errors carrying a tincan error code", () => {
    assert.throws(() => native.buildBMessage([], "hi"), { code: "INVALID_INPUT" });
    assert.throws(() => native.threadKeyFor(""), { code: "INVALID_INPUT" });
  });

  it("rejects bluetoothSnapshot with a code when the system bus is unreachable", async () => {
    // A child process pointed at a bus socket that does not exist, so this
    // never touches the real BlueZ.
    const script = `
      const { bluetoothSnapshot } = await import(${JSON.stringify(indexUrl.href)});
      try { await bluetoothSnapshot(); console.log("resolved"); }
      catch (e) { console.log(JSON.stringify({ code: e.code, isError: e instanceof Error })); }`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/nonexistent/tincan-test-bus" },
      },
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.isError, true);
    assert.equal(result.code, "NOT_CONNECTED");
  });
});

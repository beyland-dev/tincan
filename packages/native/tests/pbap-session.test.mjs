// PbapSession without a phone: every scenario runs in a child process whose
// session (and system) bus is a private dbus-daemon, on which the `fake_obexd`
// example (crates/tincan-bt) serves `org.bluez.obex` with a synthetic
// phonebook, and a fake `org.bluez` with the phone bonded. Nothing here can
// reach the real obexd, BlueZ or a phone.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dbusDaemon, startPrivateBus } from "./private-bus.mjs";

const indexUrl = new URL("../index.js", import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fakeObexd = join(root, "target/debug/examples/fake_obexd");
const ADDRESS = "00:11:22:33:44:55";

let native;
try {
  native = await import(indexUrl.href);
} catch {}

function skipReason() {
  if (!native) return "addon not built (run `pnpm build:native`)";
  if (!dbusDaemon) return "no dbus-daemon";
  return false;
}

/** Runs `body` (an async function body using `PbapSession`) in a child process. */
async function runChild(body, busAddress) {
  const script = `
    const { PbapSession } = await import(${JSON.stringify(indexUrl.href)});
    const out = {};
    try { ${body} } catch (e) { out.thrown = { code: e.code, message: e.message }; }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
        DBUS_SYSTEM_BUS_ADDRESS: busAddress,
      },
      // A child that never exits means a leaked task.
      timeout: 15_000,
    },
  );
  return JSON.parse(stdout.trim());
}

/** Reads a stream line by line; `next()` resolves the next line, or null at its end. */
function lines(stream) {
  const queue = [];
  const waiting = [];
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    let i;
    while ((i = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, i);
      text = text.slice(i + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(line);
      else queue.push(line);
    }
  });
  stream.on("end", () => {
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  return {
    next: () =>
      queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r)),
  };
}

describe("PbapSession", { skip: skipReason() }, () => {
  it("rejects a bad address and an unreachable bus", async () => {
    const bad = await runChild(`await PbapSession.open("nope");`, "unix:path=/nonexistent/bus");
    assert.equal(bad.thrown.code, "INVALID_INPUT");
    const gone = await runChild(
      `await PbapSession.open(${JSON.stringify(ADDRESS)});`,
      "unix:path=/nonexistent/tincan-test-bus",
    );
    assert.equal(gone.thrown.code, "NOT_CONNECTED");
  });

  describe("with a fake obexd", () => {
    let bus;
    let fake;
    let fakeOut;
    const command = async (line) => {
      fake.stdin.write(line + "\n");
      const reply = await fakeOut.next();
      if (reply.startsWith("error")) throw new Error(reply);
      return reply === "ok" ? reply : JSON.parse(reply);
    };

    before(
      async (t) => {
        try {
          await promisify(execFile)(
            "cargo",
            ["build", "--example", "fake_obexd", "-p", "tincan-bt", "-q"],
            { cwd: root },
          );
        } catch {
          t.skip("cannot build the fake_obexd example");
          return;
        }
        bus = await startPrivateBus("tincan-pbap-");
      },
      { timeout: 600_000 },
    );

    after(() => bus?.stop());

    beforeEach(async () => {
      fake = spawn(fakeObexd, [], {
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: bus.address,
          DBUS_SYSTEM_BUS_ADDRESS: bus.address,
        },
        stdio: ["pipe", "pipe", "inherit"],
      });
      fakeOut = lines(fake.stdout);
      const exited = new Promise((_, reject) =>
        fake.on("exit", (code) => reject(new Error(`fake_obexd exited (${code})`))),
      );
      assert.equal(await Promise.race([fakeOut.next(), exited]), "ready");
    });

    afterEach(async () => {
      const exited = new Promise((resolve) => fake.on("exit", resolve));
      fake.stdin.end();
      await exited;
    });

    it("pulls contacts, favourites and call history, then closes", async () => {
      const out = await runChild(
        `const s = await PbapSession.open(${JSON.stringify(ADDRESS)});
         out.path = s.sessionPath;
         out.size = await s.size();
         out.contacts = await s.pullContacts();
         out.favorites = await s.pull("fav");
         out.calls = await s.pull("cch", { format: "vcard21" });
         out.version = await s.version();
         await s.close();
         await s.close();
         out.closed = s.closed;`,
        bus.address,
      );
      assert.equal(out.thrown, undefined, out.thrown?.message);
      assert.equal(out.path, "/org/bluez/obex/client/session2");
      assert.equal(out.size, 3);
      assert.deepEqual(
        out.contacts.map((c) => [c.name, c.version, c.tels[0].value, c.favorite, c.photo]),
        [
          ["Owner Example", "3.0", "+15550100", false, undefined],
          ["Ada Example", "3.0", "+15550101", false, undefined],
          ["Grace Example", "3.0", "+15550102", false, undefined],
        ],
      );
      assert.deepEqual(
        out.favorites.map((c) => [c.name, c.favorite]),
        [["Ada Example", true]],
      );
      assert.deepEqual(
        out.calls.map((c) => [c.name, c.version, c.callType, c.callTime]),
        [["Ada Example", "2.1", "MISSED", "20261005T122204"]],
      );
      assert.equal(out.version.folder, "/telecom/pb");
      assert.equal(out.version.primaryCounter, (3).toString(16).padStart(32, "0"));
      assert.equal(out.closed, true);
      assert.equal((await command("state")).pbapOpen, false);
    });

    it("refuses a phone BlueZ hasn't bonded with", async () => {
      assert.equal(await command("bonded false"), "ok");
      const out = await runChild(
        `await PbapSession.open(${JSON.stringify(ADDRESS)});`,
        bus.address,
      );
      assert.equal(out.thrown?.code, "PERMISSION_DENIED");
      assert.equal((await command("state")).pbapOpen, false);
    });

    it("passes pull options through", async () => {
      const out = await runChild(
        `const s = await PbapSession.open(${JSON.stringify(ADDRESS)});
         try {
           out.cards = await s.pullContacts({ offset: 1, maxCount: 1, photos: true });
         } finally { await s.close(); }`,
        bus.address,
      );
      assert.equal(out.thrown, undefined, out.thrown?.message);
      assert.deepEqual(out.cards.length, 1);
      assert.equal(out.cards[0].name, "Ada Example");
      assert.equal(out.cards[0].photo.data, "/9j/4AAQSkZJRg==");
      const { lastPull } = await command("state");
      assert.equal(lastPull.format, "vcard30");
      assert.equal(lastPull.offset, 1);
      assert.equal(lastPull.maxCount, 1);
      assert.ok(lastPull.fields.includes("PHOTO"));
    });

    it("rejects bad options before calling obexd", async () => {
      const out = await runChild(
        `const s = await PbapSession.open(${JSON.stringify(ADDRESS)});
         const codes = [];
         for (const call of [
           () => s.pull("../pb"),
           () => s.pullContacts({ format: "vcard40" }),
           () => s.pullContacts({ maxCount: 70000 }),
           () => s.size("nope"),
         ]) {
           try { await call(); codes.push(null); } catch (e) { codes.push(e.code); }
         }
         out.codes = codes;
         await s.close();
         try { await PbapSession.open(${JSON.stringify(ADDRESS)}, { transferTimeoutMs: 0 }); }
         catch (e) { out.timeout = e.code; }`,
        bus.address,
      );
      assert.equal(out.thrown, undefined, out.thrown?.message);
      assert.deepEqual(out.codes, Array(4).fill("INVALID_INPUT"));
      assert.equal(out.timeout, "INVALID_INPUT");
      assert.equal((await command("state")).lastPull, null);
    });

    it("reports failed and stalled pulls", async () => {
      await command("mode fail");
      const failed = await runChild(
        `const s = await PbapSession.open(${JSON.stringify(ADDRESS)});
         try { await s.pullContacts(); } finally { await s.close(); }`,
        bus.address,
      );
      assert.equal(failed.thrown.code, "INTERNAL");
      await command("mode stall");
      const stalled = await runChild(
        `const s = await PbapSession.open(${JSON.stringify(ADDRESS)}, { transferTimeoutMs: 300 });
         try { await s.pullContacts(); } finally { await s.close(); }`,
        bus.address,
      );
      assert.equal(stalled.thrown.code, "TIMEOUT");
      assert.equal((await command("state")).pbapOpen, false);
    });
  });
});

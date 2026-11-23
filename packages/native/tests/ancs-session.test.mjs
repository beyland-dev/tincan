// AncsSession without a phone: every scenario runs in a child process whose
// system bus is a private dbus-daemon, on which the `fake_ancs` example
// (crates/tincan-bt) serves `org.bluez` with a fake iPhone exposing ANCS.
// Nothing here can reach the real BlueZ or a phone.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dbusDaemon, startPrivateBus } from "./private-bus.mjs";

const indexUrl = new URL("../index.js", import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fakeAncs = join(root, "target/debug/examples/fake_ancs");
const ADDRESS = "00:11:22:33:44:55";
const OPTIONS = JSON.stringify({ retryMs: 50, verifyMs: 100 });

let native;
try {
  native = await import(indexUrl.href);
} catch {}

function skipReason() {
  if (!native) return "addon not built (run `pnpm build:native`)";
  if (!dbusDaemon) return "no dbus-daemon";
  return false;
}

/**
 * Runs `body` (an async function body using `AncsSession`) in a child
 * process. `onEvent` records every event in `events`; `until(predicate)`
 * waits for a matching one.
 */
async function runChild(body, busAddress) {
  const script = `
    const { AncsSession } = await import(${JSON.stringify(indexUrl.href)});
    const out = {};
    const events = [];
    const waiters = new Set();
    const onEvent = (e) => { events.push(e); for (const w of [...waiters]) w(); };
    const until = (predicate, ms = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error("no matching event")); }, ms);
      function check() {
        const found = events.find(predicate);
        if (found) { waiters.delete(check); clearTimeout(timer); resolve(found); }
      }
      waiters.add(check);
      check();
    });
    const isState = (kind) => (e) => e.kind === "state" && e.state.kind === kind;
    try { ${body} } catch (e) { out.thrown = { code: e.code, message: e.message }; }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: busAddress },
      // A child that never exits means a leaked task or callback.
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

describe("AncsSession", { skip: skipReason() }, () => {
  it("rejects a bad address, a bad option and an unreachable bus", async () => {
    const missing = "unix:path=/nonexistent/tincan-test-bus";
    const bad = await runChild(`await AncsSession.start("nope", undefined, () => {});`, missing);
    assert.equal(bad.thrown.code, "INVALID_INPUT");
    const option = await runChild(
      `await AncsSession.start(${JSON.stringify(ADDRESS)}, { verifyMs: 0 }, () => {});`,
      missing,
    );
    assert.equal(option.thrown.code, "INVALID_INPUT");
    const gone = await runChild(
      `await AncsSession.start(${JSON.stringify(ADDRESS)}, undefined, () => {});`,
      missing,
    );
    assert.equal(gone.thrown.code, "NOT_CONNECTED");
  });

  describe("with a fake phone", () => {
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
            ["build", "--example", "fake_ancs", "-p", "tincan-bt", "-q"],
            { cwd: root },
          );
        } catch {
          t.skip("cannot build the fake_ancs example");
          return;
        }
        bus = await startPrivateBus("tincan-ancs-");
      },
      { timeout: 600_000 },
    );

    after(() => bus?.stop());

    beforeEach(async () => {
      fake = spawn(fakeAncs, [], {
        env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: bus.address },
        stdio: ["pipe", "pipe", "inherit"],
      });
      fakeOut = lines(fake.stdout);
      const exited = new Promise((_, reject) =>
        fake.on("exit", (code) => reject(new Error(`fake_ancs exited (${code})`))),
      );
      assert.equal(await Promise.race([fakeOut.next(), exited]), "ready");
    });

    afterEach(async () => {
      const exited = new Promise((resolve) => fake.on("exit", resolve));
      fake.stdin.end();
      await exited;
    });

    it("delivers notifications, runs actions and reports removals", async () => {
      await command("backlog 7 Ada_Example See_you_at_noon");
      const child = runChild(
        `const s = await AncsSession.start(${JSON.stringify(ADDRESS)}, ${OPTIONS}, onEvent);
         try {
           await until(isState("ready"));
           out.notification = (await until((e) => e.kind === "notification")).notification;
           out.recent = (await s.recent()).map((n) => n.uid);
           await s.performAction(7, "negative");
           try { await s.performAction(99, "positive"); } catch (e) { out.unknown = e.code; }
           try { await s.performAction(7, "maybe"); } catch (e) { out.badAction = e.code; }
           out.removed = (await until((e) => e.kind === "removed")).uid;
           out.state = s.state().kind;
         } finally {
           await s.close();
           await s.close();
         }
         out.closed = s.state().kind;
         out.lastEvent = events.at(-1);
         try { await s.recent(); } catch (e) { out.afterClose = e.code; }`,
        bus.address,
      );
      // Remove it once the action reached the phone.
      for (let i = 0; i < 200; i++) {
        if ((await command("state")).actions.length) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await command("remove 7");
      const out = await child;
      assert.equal(out.thrown, undefined, out.thrown?.message);
      const n = out.notification;
      assert.equal(n.uid, 7);
      assert.equal(n.appId, "com.apple.MobileSMS");
      assert.equal(n.appName, "Messages");
      assert.equal(n.title, "Ada Example");
      assert.equal(n.body, "See you at noon");
      assert.equal(n.category, "social");
      assert.equal(n.preExisting, true);
      assert.equal(n.hasPositiveAction, true);
      assert.equal(n.hasNegativeAction, true);
      assert.equal(typeof n.received, "number");
      assert.deepEqual(out.recent, [7]);
      assert.equal(out.unknown, "NOT_FOUND");
      assert.equal(out.badAction, "INVALID_INPUT");
      assert.equal(out.removed, 7);
      assert.equal(out.state, "ready");
      assert.equal(out.closed, "closed");
      assert.deepEqual(out.lastEvent, { kind: "state", state: { kind: "closed" } });
      assert.equal(out.afterClose, "NOT_CONNECTED");
      const state = await command("state");
      assert.deepEqual(state.actions, [[7, 1]]);
      assert.equal(state.notifying, false);
    });

    it("waits while the phone doesn't share notifications", async () => {
      await command("sharing off");
      const out = await runChild(
        `const s = await AncsSession.start(${JSON.stringify(ADDRESS)}, ${OPTIONS}, onEvent);
         try {
           out.hint = (await until(isState("waiting"))).state.hint;
           try { await s.performAction(1, "positive"); } catch (e) { out.action = e.code; }
         } finally { await s.close(); }`,
        bus.address,
      );
      assert.equal(out.thrown, undefined, out.thrown?.message);
      assert.match(out.hint, /Share System Notifications/);
      assert.equal(out.action, "NOT_CONNECTED");
    });

    it("reports a lost link and resubscribes", async () => {
      const child = runChild(
        `const s = await AncsSession.start(${JSON.stringify(ADDRESS)}, ${OPTIONS}, onEvent);
         try {
           await until(isState("ready"));
           const later = (kind, from) => (e) => events.indexOf(e) >= from && isState(kind)(e);
           const lost = await until(later("unavailable", events.length), 10000);
           out.lost = lost.state;
           await until(later("ready", events.indexOf(lost)), 10000);
           out.resubscribed = true;
         } finally { await s.close(); }`,
        bus.address,
      );
      for (let i = 0; i < 200 && !(await command("state")).notifying; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await command("disconnect");
      await new Promise((r) => setTimeout(r, 200));
      await command("reconnect");
      const out = await child;
      assert.equal(out.thrown, undefined, out.thrown?.message);
      assert.equal(out.lost.code, "NOT_CONNECTED");
      assert.equal(out.resubscribed, true);
    });
  });
});

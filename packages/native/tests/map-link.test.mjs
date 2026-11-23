// MapLink without a phone: argument checks, an unreachable bus, and a full
// lifecycle against a private dbus-daemon with no services on it (no
// `<servicedir>`, so nothing — obexd included — can be activated). Each
// lifecycle runs in a child process whose session *and* system bus are that
// private bus, so it can never reach the real obexd, BlueZ or the phone.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dbusDaemon, startPrivateBus } from "./private-bus.mjs";

const indexUrl = new URL("../index.js", import.meta.url);
const ADDRESS = "00:11:22:33:44:55";

let native;
try {
  native = await import(indexUrl.href);
} catch {}
const skip = native ? false : "addon not built (run `pnpm build:native`)";

/** Runs `body` (an async function body using `MapLink`) in a child process. */
async function runChild(body, env) {
  const script = `
    const { MapLink } = await import(${JSON.stringify(indexUrl.href)});
    const out = {};
    try { ${body} } catch (e) { out.thrown = { code: e.code, message: e.message }; }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...env },
      // A child that never exits means a leaked callback or task.
      timeout: 15_000,
    },
  );
  return JSON.parse(stdout.trim());
}

describe("MapLink", { skip }, () => {
  it("rejects a bad address or option with INVALID_INPUT", async () => {
    const noop = () => {};
    await assert.rejects(native.MapLink.start("not-an-address", null, noop), {
      code: "INVALID_INPUT",
    });
    await assert.rejects(native.MapLink.start(ADDRESS, { backoffMinMs: 0 }, noop), {
      code: "INVALID_INPUT",
    });
    await assert.rejects(
      native.MapLink.start(ADDRESS, { backoffMinMs: 2000, backoffMaxMs: 1000 }, noop),
      { code: "INVALID_INPUT" },
    );
  });

  it("rejects with NOT_CONNECTED when the buses are unreachable", async () => {
    const out = await runChild(`await MapLink.start(${JSON.stringify(ADDRESS)}, null, () => {});`, {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/tincan-test-session-bus",
      DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/nonexistent/tincan-test-system-bus",
    });
    assert.equal(out.thrown?.code, "NOT_CONNECTED");
  });

  describe(
    "on a bus without obexd or BlueZ",
    { skip: dbusDaemon ? false : "no dbus-daemon" },
    () => {
      let bus;
      let busAddress;

      before(async () => {
        bus = await startPrivateBus("tincan-maplink-");
        busAddress = bus.address;
      });

      after(() => bus?.stop());

      it("retries, pauses, resumes and shuts down cleanly", async () => {
        const out = await runChild(
          `
        const events = [];
        const waitFor = (pred) => new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timed out: " + JSON.stringify(events))), 5000);
          const check = () => {
            const e = events.find(pred);
            if (e) { clearTimeout(t); resolve(e); } else setTimeout(check, 10);
          };
          check();
        });
        const link = await MapLink.start(${JSON.stringify(ADDRESS)},
          { backoffMinMs: 50, backoffMaxMs: 200, openTimeoutMs: 2000 },
          (e) => events.push(e));
        out.first = events[0] ?? (await waitFor(() => true));
        out.openFailed = await waitFor((e) => e.kind === "openFailed");
        out.waiting = await waitFor((e) => e.kind === "state" && e.state.kind === "waiting");
        out.watchFailed = await waitFor((e) => e.kind === "systemWatchFailed");

        const codeOf = (p) => p.then(() => "resolved", (e) => e.code);
        out.list = await codeOf(link.listMessages("inbox"));
        out.badFilter = await codeOf(link.listMessages("inbox", { maxCount: 70000 }));
        out.get = await codeOf(link.getMessage("/org/bluez/obex/client/session1/message1"));
        out.setRead = await codeOf(link.setRead("/org/bluez/obex/client/session1/message1", true));
        out.badRecipient = await codeOf(link.pushMessage([], "hi"));
        out.push = await codeOf(link.pushMessage(["5555550142"], "hi"));
        try { link.trigger("bogus"); } catch (e) { out.badTrigger = e.code; }

        link.trigger("sleep");
        await waitFor((e) => e.kind === "state" && e.state.kind === "paused");
        out.paused = link.state();
        const before = events.length;
        link.trigger("resume");
        await waitFor((e, i) => events.indexOf(e) >= before && e.kind === "state" && e.state.kind === "connecting");

        await link.shutdown();
        await link.shutdown();
        out.state = link.state();
        out.last = events.at(-1);
        link.trigger("reconnect");
        `,
          { DBUS_SESSION_BUS_ADDRESS: busAddress, DBUS_SYSTEM_BUS_ADDRESS: busAddress },
        );
        assert.equal(out.thrown, undefined, JSON.stringify(out.thrown));
        assert.deepEqual(out.first, { kind: "state", state: { kind: "connecting", attempt: 1 } });
        assert.equal(out.openFailed.attempt, 1);
        assert.equal(out.openFailed.code, "NOT_CONNECTED");
        assert.equal(out.waiting.state.attempt, 1);
        assert.ok(out.waiting.state.delayMs >= 50);
        assert.equal(out.watchFailed.code, "NOT_CONNECTED");
        assert.equal(out.list, "NOT_CONNECTED");
        assert.equal(out.badFilter, "INVALID_INPUT");
        assert.equal(out.get, "NOT_CONNECTED");
        assert.equal(out.setRead, "NOT_CONNECTED");
        assert.equal(out.badRecipient, "INVALID_INPUT");
        assert.equal(out.push, "NOT_CONNECTED");
        assert.equal(out.badTrigger, "INVALID_INPUT");
        assert.deepEqual(out.paused, { kind: "paused", reason: "sleep" });
        assert.deepEqual(out.state, { kind: "stopped" });
        assert.deepEqual(out.last, { kind: "state", state: { kind: "stopped" } });
      });
    },
  );
});

// Bluetooth without a phone or adapter: every scenario runs in a child process
// whose system *and* session bus are a private dbus-daemon, on which the
// `fake_bluez` example (crates/tincan-bt) serves `org.bluez`. Nothing here can
// reach the real BlueZ. A child that never exits means a leaked callback.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dbusDaemon, startPrivateBus } from "./private-bus.mjs";

const indexUrl = new URL("../index.js", import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fakeBluez = join(root, "target/debug/examples/fake_bluez");
const KNOWN = "00:11:22:33:44:55";
const DISCOVERED = "66:77:88:99:AA:BB";

let native;
try {
  native = await import(indexUrl.href);
} catch {}

function skipReason() {
  if (!native) return "addon not built (run `pnpm build:native`)";
  if (!dbusDaemon) return "no dbus-daemon";
  return false;
}

/** Runs `body` (an async function body using `bt`) in a child process. */
async function runChild(busAddress, body) {
  const script = `
    const native = await import(${JSON.stringify(indexUrl.href)});
    const out = {};
    const settle = (p) => p.then(() => "ok", (e) => e.code);
    try { const bt = await native.Bluetooth.open(); ${body} } catch (e) { out.thrown = { code: e.code, message: e.message }; }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        DBUS_SYSTEM_BUS_ADDRESS: busAddress,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      },
      timeout: 15_000,
    },
  );
  return JSON.parse(stdout.trim());
}

describe("Bluetooth", { skip: skipReason() }, () => {
  it("rejects open() with NOT_CONNECTED when the bus is unreachable", async () => {
    const out = await runChild("unix:path=/nonexistent/tincan-test-bus", "");
    assert.equal(out.thrown?.code, "NOT_CONNECTED");
  });

  describe("against a fake BlueZ", () => {
    let bus;
    let fake;

    before(
      async (t) => {
        try {
          await promisify(execFile)(
            "cargo",
            ["build", "--example", "fake_bluez", "-p", "tincan-bt", "-q"],
            { cwd: root },
          );
        } catch {
          t.skip("cannot build the fake_bluez example");
          return;
        }
        bus = await startPrivateBus("tincan-bluetooth-");
      },
      { timeout: 600_000 },
    );

    after(() => bus?.stop());

    // A fresh fake per test, so pairings don't leak between them.
    beforeEach(async () => {
      fake = spawn(fakeBluez, [], {
        env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: bus.address },
        stdio: ["pipe", "pipe", "inherit"],
      });
      await new Promise((resolve, reject) => {
        let text = "";
        fake.stdout.on("data", (chunk) => {
          text += chunk;
          if (text.includes("ready")) resolve();
        });
        fake.on("exit", (code) => reject(new Error(`fake_bluez exited (${code})`)));
      });
    });

    afterEach(async () => {
      const exited = new Promise((resolve) => fake.on("exit", resolve));
      fake.stdin.end();
      await exited;
    });

    it("lists the adapter and devices", async () => {
      const out = await runChild(
        bus.address,
        `out.adapter = await bt.adapter();
         out.devices = (await bt.devices()).map((d) => [d.address, d.paired]);`,
      );
      assert.equal(out.thrown, undefined);
      assert.equal(out.adapter.path, "/org/bluez/hci0");
      assert.equal(out.adapter.powered, true);
      assert.deepEqual(out.devices, [[KNOWN, false]]);
    });

    it("pairs, connects, disconnects and forgets", async () => {
      const out = await runChild(
        bus.address,
        `const events = [];
         const watch = await bt.watchDevices((e) => events.push(e));
         out.requests = [];
         await bt.pair(${JSON.stringify(KNOWN)}, async (request) => {
           out.requests.push(request);
           return true;
         });
         const paired = (await bt.devices()).find((d) => d.address === ${JSON.stringify(KNOWN)});
         out.paired = [paired.paired, paired.trusted];
         await bt.connect(${JSON.stringify(KNOWN)});
         out.connected = (await bt.devices())[0].connected;
         await bt.disconnect(${JSON.stringify(KNOWN)});
         out.disconnected = !(await bt.devices())[0].connected;
         await bt.forget(${JSON.stringify(KNOWN)});
         out.afterForget = await settle(bt.connect(${JSON.stringify(KNOWN)}));
         out.devices = (await bt.devices()).length;
         for (let i = 0; i < 100 && !events.some((e) => e.kind === "deviceRemoved"); i++) {
           await new Promise((r) => setTimeout(r, 10));
         }
         out.removed = events.find((e) => e.kind === "deviceRemoved");
         out.changed = events.some((e) => e.kind === "deviceChanged" && e.device.connected);
         watch.close();
         watch.close();`,
      );
      assert.equal(out.thrown, undefined);
      assert.deepEqual(out.requests, [{ kind: "confirm", address: KNOWN, passkey: "004242" }]);
      assert.deepEqual(out.paired, [true, true]);
      assert.equal(out.connected, true);
      assert.equal(out.disconnected, true);
      assert.equal(out.afterForget, "NOT_FOUND");
      assert.equal(out.devices, 0);
      assert.equal(out.removed?.address, KNOWN);
      assert.equal(out.changed, true);
    });

    it("rejects connect on an unpaired device with NOT_CONNECTED", async () => {
      const out = await runChild(
        bus.address,
        `out.connect = await settle(bt.connect(${JSON.stringify(KNOWN)}));
         out.unknown = await settle(bt.pair("01:02:03:04:05:06", () => true));
         out.bad = await settle(bt.pair("nope", () => true));`,
      );
      assert.equal(out.connect, "NOT_CONNECTED");
      assert.equal(out.unknown, "NOT_FOUND");
      assert.equal(out.bad, "INVALID_INPUT");
    });

    it("treats false, a throw, a non-boolean or a rejection as a decline", async () => {
      const out = await runChild(
        bus.address,
        `const a = ${JSON.stringify(KNOWN)};
         out.results = [
           await settle(bt.pair(a, () => false)),
           await settle(bt.pair(a, () => { throw new Error("no"); })),
           await settle(bt.pair(a, () => "yes")),
           await settle(bt.pair(a, () => Promise.reject(new Error("no")))),
           await settle(bt.pair(a, () => Promise.resolve(true))),
         ];
         out.paired = (await bt.devices())[0].paired;`,
      );
      assert.deepEqual(out.results, [
        "PERMISSION_DENIED",
        "PERMISSION_DENIED",
        "PERMISSION_DENIED",
        "PERMISSION_DENIED",
        "ok",
      ]);
      assert.equal(out.paired, true);
    });

    it("cancels a pairing whose callback never answers, and still exits", async () => {
      const out = await runChild(
        bus.address,
        `const a = ${JSON.stringify(KNOWN)};
         let asked;
         const asking = new Promise((r) => { asked = r; });
         const first = settle(bt.pair(a, () => { asked(); return new Promise(() => {}); }));
         await asking;
         out.second = await settle(bt.pair(a, () => true));
         await bt.cancelPairing(a);
         out.first = await first;
         out.paired = (await bt.devices())[0].paired;`,
      );
      assert.equal(out.thrown, undefined);
      assert.equal(out.second, "BUSY");
      assert.equal(out.first, "PERMISSION_DENIED");
      assert.equal(out.paired, false);
    });

    it("reports discovery", async () => {
      const out = await runChild(
        bus.address,
        `const events = [];
         const watch = await bt.watchDevices((e) => events.push(e));
         await bt.startDiscovery();
         for (let i = 0; i < 100 && !events.some((e) => e.kind === "deviceAdded"); i++) {
           await new Promise((r) => setTimeout(r, 10));
         }
         await bt.stopDiscovery();
         out.discovering = events.some((e) => e.kind === "adapterChanged" && e.adapter.discovering);
         out.added = events.filter((e) => e.kind === "deviceAdded").map((e) => e.device.address);
         watch.close();`,
      );
      assert.equal(out.thrown, undefined);
      assert.equal(out.discovering, true);
      assert.deepEqual(out.added, [DISCOVERED]);
    });
  });
});

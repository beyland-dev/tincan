// setLogger without a phone: each case runs in a child process whose session
// and system bus are a private dbus-daemon with no services, so MapLink fails
// to open (and logs it) and Vault falls back to a key file (and warns).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function skipReason() {
  if (!native) return "addon not built (run `pnpm build:native`)";
  if (!dbusDaemon) return "no dbus-daemon";
  return false;
}

// Logs at `level`, opens a MapLink (and with `vault`, a Vault) until the
// expected records arrive, then clears the logger and checks nothing follows.
const childScript = `
  const { MapLink, Vault, setLogger } = await import(${JSON.stringify(indexUrl.href)});
  const { level, vaultPath, waitFor: wanted } = JSON.parse(process.env.TINCAN_TEST_ARGS);
  const records = [];
  const out = { records };
  const waitFor = (pred) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out: " + JSON.stringify(records))), 5000);
    const check = () => {
      if (records.some(pred)) { clearTimeout(t); resolve(); } else setTimeout(check, 10);
    };
    check();
  });
  try {
    setLogger((record) => records.push(record), level);
    const link = await MapLink.start(${JSON.stringify(ADDRESS)},
      { backoffMinMs: 50, backoffMaxMs: 200, openTimeoutMs: 2000 }, () => {});
    if (vaultPath) (await Vault.open(vaultPath, { id: "log-test" })).close();
    await waitFor((r) => r.message === wanted);
    await link.shutdown();
    setLogger(null);
    await new Promise((r) => setTimeout(r, 50));
    out.cleared = records.length;
    const again = await MapLink.start(${JSON.stringify(ADDRESS)},
      { backoffMinMs: 50, backoffMaxMs: 200, openTimeoutMs: 2000 }, () => {});
    await new Promise((r) => setTimeout(r, 200));
    await again.shutdown();
    out.after = records.length;
  } catch (e) {
    out.thrown = { code: e.code, message: e.message };
  }
  console.log(JSON.stringify(out));`;

describe("setLogger", { skip: skipReason() }, () => {
  let bus;
  let dir;

  before(async () => {
    bus = await startPrivateBus("tincan-log-");
    dir = mkdtempSync(join(tmpdir(), "tincan-log-test-"));
  });
  after(() => {
    bus?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the child; it must exit on its own, since the logger is weak. */
  async function run(args, env = {}) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          TINCAN_LOG_SENSITIVE: "",
          ...env,
          DBUS_SESSION_BUS_ADDRESS: bus.address,
          DBUS_SYSTEM_BUS_ADDRESS: bus.address,
          TINCAN_TEST_ARGS: JSON.stringify(args),
        },
        timeout: 15_000,
      },
    );
    const out = JSON.parse(stdout.trim());
    assert.equal(out.thrown, undefined, JSON.stringify(out.thrown));
    assert.equal(out.after, out.cleared, "records arrived after setLogger(null)");
    return out.records;
  }

  it("rejects an unknown level with INVALID_INPUT", () => {
    assert.throws(() => native.setLogger(() => {}, "loud"), { code: "INVALID_INPUT" });
  });

  it("forwards native events with structured fields and a redacted device", async () => {
    const records = await run({ level: "info", waitFor: "opening the MAP session failed" });
    const failed = records.find((r) => r.message === "opening the MAP session failed");
    assert.deepEqual(failed, {
      level: "info",
      target: "tincan_bt::supervisor",
      message: "opening the MAP session failed",
      fields: { attempt: "1", code: "NOT_CONNECTED", device: "…:44:55" },
    });
    assert.ok(!JSON.stringify(records).includes("00:11:22:33"));
    for (const r of records) {
      assert.ok(["error", "warn", "info"].includes(r.level), JSON.stringify(r));
      if (!r.target.startsWith("tincan_")) assert.ok(["error", "warn"].includes(r.level));
    }
  });

  it("reveals sensitive values only with TINCAN_LOG_SENSITIVE=1", async () => {
    const records = await run(
      { level: "debug", waitFor: "opening the MAP session failed" },
      { TINCAN_LOG_SENSITIVE: "1" },
    );
    const failed = records.find((r) => r.message === "opening the MAP session failed");
    assert.equal(failed.fields.device, ADDRESS);
    for (const r of records) {
      if (!r.target.startsWith("tincan_")) assert.ok(["error", "warn"].includes(r.level));
    }
  });

  it("drops events below the level", async () => {
    const warning = "no Secret Service; using a key file";
    const records = await run({
      level: "warn",
      vaultPath: join(dir, "vault.db"),
      waitFor: warning,
    });
    assert.ok(records.length > 0);
    for (const r of records) assert.ok(["error", "warn"].includes(r.level), JSON.stringify(r));
    const fallback = records.find((r) => r.message === warning);
    assert.equal(fallback.level, "warn");
    assert.match(fallback.target, /^tincan_vault/);
  });
});

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ClientInfo, DoctorCheck } from "@beyland/tincan-protocol";
import { Core, diagnose, unknownFacts, type RuntimeFacts, type SystemFacts } from "../src/index.ts";

const cli: ClientInfo = { kind: "cli", name: "test" };
const PHONE = "AA:BB:CC:DD:EE:FF";
const NOW = 1_780_000_000_000;
const HOUR = 60 * 60 * 1000;

function healthy(): SystemFacts {
  return {
    native: { loaded: true, version: "0.1.0", error: null },
    bluezVersion: "5.79",
    bluetoothd: { running: true, experimental: true },
    ertmDisabled: false,
    bluetooth: {
      adapters: [{ address: "00:11:22:33:44:55", name: "laptop", powered: true, class: 0x240408 }],
      phones: [{ address: PHONE, name: "iPhone", paired: true, bonded: true, connected: true }],
    },
    obexd: "running",
    service: { installed: true, enabled: true, active: true },
    keyStorage: "keyring",
  };
}

function running(): RuntimeFacts {
  return {
    version: "1.0.0",
    phoneAddress: PHONE,
    map: { link: { kind: "connected", session: "s" }, lastError: null },
    contacts: { lastSyncAt: 1_000, lastError: null },
    ancs: { kind: "ready" },
    history: {
      now: NOW,
      events: [{ at: NOW - 60_000, kind: "phone", state: "connected", address: PHONE, code: null }],
    },
  };
}

function byId(checks: DoctorCheck[]): Record<string, DoctorCheck> {
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

const statuses = (checks: DoctorCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("diagnose", () => {
  test("a healthy setup passes every check, in a fixed order", () => {
    const checks = diagnose(healthy(), running());
    expect(checks.map((c) => c.id)).toEqual([
      "daemon",
      "native",
      "bluez",
      "bluetoothd",
      "kernel",
      "adapter",
      "class",
      "obexd",
      "phone",
      "map",
      "contacts",
      "ancs",
      "history",
      "keyring",
      "service",
    ]);
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
  });

  test("the history check warns when the phone keeps dropping", () => {
    const runtime = running();
    const phone = (at: number, state: string) =>
      ({ at, kind: "phone", state, address: PHONE, code: null }) as const;
    runtime.history = {
      now: NOW,
      events: [
        // A day and a half ago: doesn't count.
        phone(NOW - 36 * HOUR, "connected"),
        phone(NOW - 30 * HOUR, "disconnected"),
        phone(NOW - 5 * HOUR, "connected"),
        phone(NOW - 4 * HOUR, "disconnected"),
        phone(NOW - 3 * HOUR, "connected"),
        // Disconnecting on purpose isn't a drop.
        phone(NOW - 2 * HOUR, "paused"),
        phone(NOW - 90 * 60_000, "connected"),
        phone(NOW - HOUR, "connecting"),
        phone(NOW - 10 * 60_000, "connected"),
      ],
    };
    expect(byId(diagnose(healthy(), runtime)).history).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("dropped 2 times in the last day"),
    });

    runtime.history.events.push(phone(NOW - 60_000, "disconnected"));
    const check = byId(diagnose(healthy(), runtime)).history;
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toContain("dropped 3 times");
    expect(check?.hint).toContain("tincan device history");
  });

  test("the history check warns about refused messages and a reset adapter class", () => {
    const runtime = running();
    runtime.history!.events.push(
      { at: NOW - HOUR, kind: "messages", state: "refused", address: PHONE, code: "NOT_FOUND" },
      { at: NOW - HOUR, kind: "adapter", state: "not-hands-free", address: null, code: null },
    );
    const check = byId(diagnose(healthy(), runtime)).history;
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("refused messages");
    expect(check?.detail).toContain("hands-free");

    runtime.history = { now: NOW, events: [] };
    expect(byId(diagnose(healthy(), runtime)).history?.status).toBe("skip");
  });

  test("without a daemon the phone checks are skipped and the daemon fails", () => {
    const checks = byId(diagnose(healthy(), null));
    expect(checks.daemon).toMatchObject({ status: "fail", autoFix: "service.install" });
    for (const id of ["map", "contacts", "ancs", "history"])
      expect(checks[id]?.status).toBe("skip");
  });

  test("with nothing probed only the daemon and addon are judged", () => {
    const facts = unknownFacts({ loaded: false, version: null, error: "missing .node" });
    const checks = statuses(diagnose(facts, null));
    expect(checks).toMatchObject({ daemon: "fail", native: "fail" });
    const rest = Object.entries(checks).filter(([id]) => !["daemon", "native"].includes(id));
    expect(rest.every(([, status]) => status === "skip")).toBe(true);
  });

  test("warns about an old BlueZ and missing experimental features", () => {
    const facts = healthy();
    facts.bluezVersion = "missing";
    expect(byId(diagnose(facts, running())).bluez?.status).toBe("fail");
    facts.bluezVersion = "5.53";
    facts.bluetoothd = { running: true, experimental: false };
    const checks = byId(diagnose(facts, running()));
    expect(checks.bluez?.status).toBe("warn");
    expect(checks.bluetoothd).toMatchObject({ status: "warn", autoFix: "system.setup" });
    facts.bluetoothd = { running: false, experimental: false };
    expect(byId(diagnose(facts, running())).bluetoothd?.status).toBe("fail");
  });

  test("fails when ERTM is disabled", () => {
    const facts = healthy();
    facts.ertmDisabled = true;
    expect(byId(diagnose(facts, running())).kernel?.status).toBe("fail");
  });

  test("fails without a powered adapter, or when BlueZ can't be read", () => {
    const facts = healthy();
    facts.bluetooth = { adapters: [], phones: [] };
    expect(statuses(diagnose(facts, running()))).toMatchObject({
      adapter: "fail",
      class: "skip",
      phone: "fail",
    });
    facts.bluetooth = {
      adapters: [{ address: "00:11:22:33:44:55", name: "hci0", powered: false, class: null }],
      phones: [],
    };
    expect(statuses(diagnose(facts, running()))).toMatchObject({ adapter: "fail", class: "skip" });
    facts.bluetooth = { error: "org.bluez not on the bus" };
    expect(byId(diagnose(facts, running())).adapter).toMatchObject({
      status: "fail",
      detail: "org.bluez not on the bus",
    });
  });

  test("a non-hands-free class fails before pairing and warns after", () => {
    const facts = healthy();
    if (!facts.bluetooth || !("adapters" in facts.bluetooth)) throw new Error("unreachable");
    facts.bluetooth.adapters[0]!.class = 0x6c010c;
    expect(byId(diagnose(facts, running())).class).toMatchObject({
      status: "warn",
      hint: expect.stringMatching(/btmgmt class 4 8/),
      autoFix: "system.setup",
    });
    facts.bluetooth.phones = [];
    expect(byId(diagnose(facts, running())).class?.status).toBe("fail");
  });

  test("reports the phone's pairing, bond and connection", () => {
    const facts = healthy();
    if (!facts.bluetooth || !("phones" in facts.bluetooth)) throw new Error("unreachable");
    const phone = facts.bluetooth.phones[0]!;
    phone.connected = false;
    expect(byId(diagnose(facts, running())).phone?.status).toBe("warn");
    phone.bonded = false;
    expect(byId(diagnose(facts, running())).phone?.hint).toMatch(/tincan pair/);
    phone.paired = false;
    expect(byId(diagnose(facts, running())).phone).toMatchObject({ status: "fail" });
  });

  test("prefers the phone Tincan is set up with", () => {
    const facts = healthy();
    if (!facts.bluetooth || !("phones" in facts.bluetooth)) throw new Error("unreachable");
    facts.bluetooth.phones.unshift({
      address: "11:11:11:11:11:11",
      name: "Old iPhone",
      paired: true,
      bonded: true,
      connected: false,
    });
    const phone = byId(diagnose(facts, { ...running(), phoneAddress: PHONE.toLowerCase() })).phone;
    expect(phone).toMatchObject({ status: "ok" });
    expect(phone?.detail).toContain(PHONE);
  });

  test("explains why MAP won't connect", () => {
    const runtime = running();
    runtime.map = { link: { kind: "waiting", attempt: 3, delayMs: 4000 }, lastError: null };
    expect(byId(diagnose(healthy(), runtime)).map?.status).toBe("warn");
    runtime.map.lastError = { code: "BUSY", at: 1 };
    expect(byId(diagnose(healthy(), runtime)).map).toMatchObject({
      status: "fail",
      hint: expect.stringMatching(/other Bluetooth messaging apps/),
    });
    runtime.map.lastError = { code: "PERMISSION_DENIED", at: 1 };
    expect(byId(diagnose(healthy(), runtime)).map?.hint).toMatch(/Show Message Notifications/);
    runtime.map.lastError = { code: "NOT_FOUND", at: 1 };
    expect(byId(diagnose(healthy(), runtime)).map).toMatchObject({
      status: "fail",
      hint: expect.stringMatching(/restart the iPhone/),
    });
    runtime.map.failures = 4;
    expect(byId(diagnose(healthy(), runtime)).map?.detail).toMatch(/4 tries in a row/);
    runtime.map = null;
    expect(byId(diagnose(healthy(), runtime)).map?.status).toBe("skip");
  });

  test("reports contact sync failures", () => {
    const runtime = running();
    runtime.contacts = { lastSyncAt: null, lastError: null };
    expect(byId(diagnose(healthy(), runtime)).contacts?.status).toBe("warn");
    runtime.contacts.lastError = { code: "PERMISSION_DENIED" };
    expect(byId(diagnose(healthy(), runtime)).contacts).toMatchObject({
      status: "fail",
      hint: expect.stringMatching(/Sync Contacts/),
    });
  });

  test("reports the notification subscription", () => {
    const runtime = running();
    runtime.ancs = { kind: "waiting", hint: "Turn on Share System Notifications" };
    expect(byId(diagnose(healthy(), runtime)).ancs).toMatchObject({
      status: "warn",
      detail: "Turn on Share System Notifications",
    });
    runtime.ancs = { kind: "unavailable", code: "UNSUPPORTED", reason: "No LE" };
    expect(byId(diagnose(healthy(), runtime)).ancs?.status).toBe("fail");
  });

  test("flags a key in a file and a missing service", () => {
    const facts = healthy();
    facts.keyStorage = "file";
    facts.service = { installed: false, enabled: null, active: null };
    expect(statuses(diagnose(facts, running()))).toMatchObject({
      keyring: "warn",
      service: "warn",
    });
    facts.service = { installed: true, enabled: true, active: false };
    expect(statuses(diagnose(facts, running()))).toMatchObject({ service: "warn" });
  });
});

describe("doctor command", () => {
  let core: Core;
  afterEach(async () => core.close());

  test("combines the system probe with what the daemon knows", async () => {
    core = await Core.open({
      version: "9.9.9",
      now: () => 5_000,
      probeSystem: async () => healthy(),
    });
    core.attach({
      sync: {
        status: {
          link: { kind: "waiting", attempt: 2, delayMs: 2000 },
          syncing: false,
          lastSyncAt: null,
          lastError: { code: "BUSY", at: 1 },
          failures: 2,
        },
        sync: async () => null,
        trigger: () => {},
        markReadOnPhone: async () => 0,
      },
    });
    const report = await core.call("doctor", {}, cli);
    expect(report.generatedAt).toBe(5_000);
    expect(report.daemon).toBe(true);
    const checks = byId(report.checks);
    expect(checks.daemon?.detail).toContain("9.9.9");
    expect(checks.map?.status).toBe("fail");
    expect(checks.contacts?.status).toBe("skip");
  });

  test("skips system checks without a probe", async () => {
    core = await Core.open({ version: "1.0.0" });
    const checks = byId((await core.call("doctor", {}, cli)).checks);
    expect(checks.daemon?.status).toBe("ok");
    expect(checks.adapter?.status).toBe("skip");
  });
});

import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterInfo, BtDevice, NativeInfo } from "@beyland/tincan-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  daemonService,
  disableService,
  experimentalInConf,
  installService,
  probeSystem,
  renderUnit,
  serviceStatus,
  uninstallService,
  type Systemctl,
  type SystemIo,
} from "../src/index.ts";

const native: NativeInfo = { loaded: true, version: "0.1.0", error: null };

function fakeIo(overrides: Partial<SystemIo> & { files?: Record<string, string> } = {}): SystemIo {
  const files = overrides.files ?? {
    "/sys/module/bluetooth/parameters/disable_ertm": "N\n",
  };
  return {
    exec: async (command) => {
      if (command === "bluetoothctl") return { code: 0, stdout: "bluetoothctl: 5.87\n" };
      if (command === "busctl") {
        return {
          code: 0,
          stdout:
            "org.bluez.obex 4242 obexd alice :1.30 user@1000.service - -\n" +
            "org.freedesktop.Notifications - - - (activatable) - -\n",
        };
      }
      return null;
    },
    readFile: async (file) => files[file] ?? null,
    exists: async (file) => file in files,
    processes: async () => [["/usr/libexec/bluetooth/bluetoothd", "--experimental"], ["bash"]],
    ...overrides,
  };
}

const adapter: AdapterInfo = {
  path: "/org/bluez/hci0",
  address: "00:11:22:33:44:55",
  name: "BlueZ 5.87",
  alias: "laptop",
  powered: true,
  discoverable: false,
  pairable: true,
  discovering: false,
  class: 0x240408,
};

function device(overrides: Partial<BtDevice>): BtDevice {
  return {
    path: "/org/bluez/hci0/dev_AA",
    adapter: "/org/bluez/hci0",
    address: "AA:BB:CC:DD:EE:FF",
    alias: "My iPhone",
    paired: true,
    bonded: true,
    trusted: true,
    blocked: false,
    connected: true,
    uuids: [],
    isIphone: true,
    supportsMap: true,
    supportsPbap: true,
    supportsAncs: true,
    ...overrides,
  };
}

function fakePort(devices: BtDevice[], fail?: Error) {
  return {
    Bluetooth: {
      open: async () => {
        if (fail) throw fail;
        return { adapter: async () => adapter, devices: async () => devices } as never;
      },
    },
  };
}

describe("probeSystem", () => {
  it("reads BlueZ, the kernel, obexd and the paired iPhone", async () => {
    const facts = await probeSystem({
      native,
      port: fakePort([device({}), device({ address: "11:22:33:44:55:66", isIphone: false })]),
      io: fakeIo(),
      service: async () => ({ installed: false, enabled: null, active: null }),
    });
    expect(facts).toEqual({
      native,
      bluezVersion: "5.87",
      bluetoothd: { running: true, experimental: true },
      ertmDisabled: false,
      bluetooth: {
        adapters: [{ address: adapter.address, name: "laptop", powered: true, class: 0x240408 }],
        phones: [
          {
            address: "AA:BB:CC:DD:EE:FF",
            name: "My iPhone",
            paired: true,
            bonded: true,
            connected: true,
          },
        ],
      },
      obexd: "running",
      service: { installed: false, enabled: null, active: null },
      keyStorage: null,
    });
  });

  it("notices disabled ERTM, a missing bluetoothctl and obexd", async () => {
    const facts = await probeSystem({
      native,
      port: fakePort([], new Error("org.bluez is not on the bus")),
      io: fakeIo({
        files: {
          "/sys/module/bluetooth/parameters/disable_ertm": "Y\n",
        },
        exec: async (command) =>
          command === "busctl" ? { code: 0, stdout: "org.freedesktop.DBus 1 dbus-broker\n" } : null,
        processes: async () => [["bash"]],
      }),
    });
    expect(facts).toMatchObject({
      bluezVersion: "missing",
      bluetoothd: { running: false },
      ertmDisabled: true,
      bluetooth: { error: "org.bluez is not on the bus" },
      obexd: "missing",
      service: null,
    });
  });

  it("reports what it couldn't read as unknown", async () => {
    const facts = await probeSystem({
      native,
      port: null,
      io: fakeIo({
        files: {},
        exec: async (command) =>
          command === "bluetoothctl" ? { code: 0, stdout: "garbage" } : { code: 1, stdout: "" },
        processes: async () => null,
      }),
      service: async () => {
        throw new Error("no user bus");
      },
    });
    expect(facts).toMatchObject({
      bluezVersion: null,
      bluetoothd: null,
      ertmDisabled: null,
      bluetooth: null,
      obexd: null,
      service: null,
    });
  });

  it("finds -E and Experimental = true in main.conf", async () => {
    const io = fakeIo({ processes: async () => [["bluetoothd", "-nE"]] });
    expect((await probeSystem({ native, port: null, io })).bluetoothd?.experimental).toBe(true);
    expect(experimentalInConf("[General]\n#Experimental = true\n")).toBe(false);
    expect(experimentalInConf("[Policy]\nExperimental = true\n")).toBe(false);
    expect(experimentalInConf("[General]\nName = x\n  Experimental=true\n")).toBe(true);
    expect(experimentalInConf("[General]\nExperimental = true # inline comment\n")).toBe(false);
    expect(experimentalInConf("[General]\nExperimental = true\nExperimental = false\n")).toBe(
      false,
    );
  });
});

describe("systemd user service", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let calls: string[][];
  let state: { enabled: boolean; active: boolean };
  const run: Systemctl = async (args) => {
    calls.push(args);
    const [verb] = args;
    if (verb === "enable") state.enabled = true;
    if (verb === "restart" || verb === "start") state.active = true;
    if (verb === "disable")
      state = { enabled: false, active: state.active && !args.includes("--now") };
    const stdout =
      verb === "is-enabled"
        ? state.enabled
          ? "enabled\n"
          : "disabled\n"
        : verb === "is-active"
          ? state.active
            ? "active\n"
            : "inactive\n"
          : "";
    return { code: 0, stdout, stderr: "" };
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "tincan-service-"));
    env = { HOME: home };
    calls = [];
    state = { enabled: false, active: false };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("installs, reports and uninstalls the unit", async () => {
    expect(await serviceStatus({ env, systemctl: run })).toMatchObject({
      installed: false,
      enabled: null,
    });
    expect(calls).toEqual([]);

    const status = await installService(["/opt/node bin/node", "/opt/tincan/bin.mjs", "daemon"], {
      env,
      systemctl: run,
    });
    expect(status).toEqual({
      path: path.join(home, ".config/systemd/user/tincan.service"),
      execStart: '"/opt/node bin/node" /opt/tincan/bin.mjs daemon',
      installed: true,
      enabled: true,
      active: true,
    });
    expect(calls.slice(0, 3)).toEqual([
      ["daemon-reload"],
      ["enable", "tincan.service"],
      ["restart", "tincan.service"],
    ]);
    const unit = await readFile(status.path, "utf8");
    expect(unit).toContain(
      `ReadWritePaths="-${home}/.local/share/tincan" "-${home}/.config/tincan"`,
    );
    expect((await stat(path.join(home, ".local/share/tincan"))).mode & 0o777).toBe(0o700);

    calls = [];
    expect(await uninstallService({ env, systemctl: run })).toMatchObject({ installed: false });
    expect(calls).toEqual([["disable", "--now", "tincan.service"], ["daemon-reload"]]);
  });

  it("lets a running daemon enable the unit, then start it once it has stopped", async () => {
    const service = daemonService(["/usr/bin/tincan", "daemon"], { env, systemctl: run });
    expect(await service.status()).toEqual({ installed: false, enabled: null, active: null });
    expect(await service.enable()).toEqual({ installed: true, enabled: true, active: false });
    expect(calls.map(([verb]) => verb)).not.toContain("restart");
    await service.start();
    expect(calls).toContainEqual(["start", "tincan.service"]);
    expect(await service.status()).toEqual({ installed: true, enabled: true, active: true });
  });

  it("disables the unit without stopping or removing it", async () => {
    const status = await installService(["tincan"], { env, systemctl: run });
    calls = [];
    expect(await disableService({ env, systemctl: run })).toMatchObject({
      installed: true,
      enabled: false,
      active: true,
    });
    expect(calls[0]).toEqual(["disable", "tincan.service"]);
    expect(await readFile(status.path, "utf8")).toContain("ExecStart=tincan");
  });

  it("lets the service, which can't write its unit, turn itself off and on again", async () => {
    const status = await installService(["tincan"], { env, systemctl: run });
    const service = daemonService(["tincan"], { env, systemctl: run });
    const unitDir = path.dirname(status.path);
    await chmod(unitDir, 0o500);
    try {
      expect(await service.disable()).toEqual({ installed: true, enabled: false, active: true });
      calls = [];
      expect(await service.enable()).toEqual({ installed: true, enabled: true, active: true });
      expect(calls[0]).toEqual(["enable", "tincan.service"]);
    } finally {
      await chmod(unitDir, 0o700);
    }
  });

  it("reports no status when systemd can't be asked", async () => {
    const missing: Systemctl = async () => {
      throw new Error("systemctl isn't installed");
    };
    await installService(["tincan"], { env, systemctl: run });
    expect(await daemonService(["tincan"], { env, systemctl: missing }).status()).toBeNull();
  });

  it("surfaces a failing systemctl", async () => {
    const failing: Systemctl = async () => ({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus",
    });
    await expect(installService(["tincan"], { env, systemctl: failing })).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("Failed to connect to bus"),
    });
  });

  it("matches the unit shipped in packaging/", async () => {
    const shipped = await readFile(
      new URL("../../../packaging/systemd/tincan.service", import.meta.url),
      "utf8",
    );
    const body = shipped.slice(shipped.indexOf("[Unit]"));
    expect(body).toBe(renderUnit({ execStart: ["/usr/bin/env", "tincan", "daemon"] }));
  });

  it("escapes % and $ so systemd doesn't expand them and renders Environment lines", () => {
    expect(
      renderUnit({
        execStart: ["/bin/true"],
        dataDir: "/home/a b/data",
        configDir: "/home/a b/cfg",
      }),
    ).toContain('ReadWritePaths="-/home/a b/data" "-/home/a b/cfg"');
    expect(renderUnit({ execStart: ["/home/a%b/$c/node"] })).toContain(
      'ExecStart="/home/a%%b/$$c/node"',
    );
    const withEnv = renderUnit({
      execStart: [
        "/opt/Tincan/tincan-desktop",
        "/opt/Tincan/resources/daemon/dist/bin.mjs",
        "daemon",
      ],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(withEnv).toContain("Environment=ELECTRON_RUN_AS_NODE=1\nExecStart=");
  });

  it("refuses line breaks that would inject unit directives", () => {
    expect(() => renderUnit({ execStart: ["/opt/tincan\nExecStartPre=/bin/evil"] })).toThrow(
      /line break/,
    );
    expect(() =>
      renderUnit({ execStart: ["tincan"], environment: { A: "1\r\nExecStartPre=/bin/evil" } }),
    ).toThrow(/line break/);
  });

  it("stops restarting a unit whose program is gone and keeps files private", () => {
    const unit = renderUnit({ execStart: ["tincan", "daemon"] });
    const section = (name: string) => unit.slice(unit.indexOf(`[${name}]`)).split(/\n\[/)[0]!;
    expect(section("Unit")).toContain("StartLimitIntervalSec=60\nStartLimitBurst=3\n");
    expect(section("Service")).toContain("RestartPreventExitStatus=203\n");
    expect(section("Service")).toContain("UMask=0077\n");
  });
});

import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import type {
  AdapterFacts,
  NativeInfo,
  PhoneFacts,
  PhonePort,
  ServiceFacts,
  SystemFacts,
} from "@beyland/tincan-core";
import type { LoadedNative } from "./native.ts";
import { serviceStatus } from "./service.ts";
import { childEnv } from "./env.ts";

/** The parts of the computer `probeSystem` reads; tests swap them out. */
export interface SystemIo {
  /** Runs a command. Null when it isn't installed or didn't finish in time. */
  exec(command: string, args: string[]): Promise<{ code: number; stdout: string } | null>;
  /** A file's contents, or null when it can't be read. */
  readFile(file: string): Promise<string | null>;
  exists(file: string): Promise<boolean>;
  /** Every process's argv; null when /proc can't be read. */
  processes(): Promise<string[][] | null>;
}

export const nodeSystemIo: SystemIo = {
  exec: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 5_000, env: childEnv() }, (error, stdout) => {
        if (error && typeof error.code !== "number") resolve(null);
        else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
      });
    }),
  readFile: (file) => readFile(file, "utf8").catch(() => null),
  exists: (file) =>
    access(file).then(
      () => true,
      () => false,
    ),
  processes: async () => {
    let entries: string[];
    try {
      entries = await readdir("/proc");
    } catch {
      return null;
    }
    const argvs = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map((pid) => readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")),
    );
    return argvs.filter((cmdline) => cmdline).map((cmdline) => cmdline.split("\0").filter(Boolean));
  },
};

export interface ProbeOptions {
  native: NativeInfo;
  /** The addon's Bluetooth API; without it the Bluetooth checks are skipped. */
  port: Pick<PhonePort, "Bluetooth"> | null;
  io?: SystemIo;
  /** The background service's state; usually `serviceStatus`. */
  service?: () => Promise<ServiceFacts | null>;
  keyStorage?: SystemFacts["keyStorage"];
}

/** The probe the daemon (and an offline `tincan doctor`) runs. */
export function systemProbe(
  native: LoadedNative,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<SystemFacts> {
  return () =>
    probeSystem({ native: native.info, port: native.port, service: () => serviceStatus({ env }) });
}

/** Gathers what `doctor` needs to know about the computer. Never throws. */
export async function probeSystem(options: ProbeOptions): Promise<SystemFacts> {
  const io = options.io ?? nodeSystemIo;
  const [bluezVersion, processes, mainConf, ertm, bluetooth, obexd, service] = await Promise.all([
    bluezVersionOf(io),
    io.processes(),
    io.readFile("/etc/bluetooth/main.conf"),
    io.readFile("/sys/module/bluetooth/parameters/disable_ertm"),
    bluetoothFacts(options.port),
    obexdState(io),
    options.service ? options.service().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    native: options.native,
    bluezVersion,
    bluetoothd: processes && bluetoothdFacts(processes, mainConf),
    ertmDisabled: ertm === null ? null : /^[Y1]/i.test(ertm.trim()),
    bluetooth,
    obexd,
    service,
    keyStorage: options.keyStorage ?? null,
  };
}

async function bluezVersionOf(io: SystemIo): Promise<string | null> {
  const result = await io.exec("bluetoothctl", ["--version"]);
  if (!result) return "missing";
  return result.stdout.match(/\d+\.\d+/)?.[0] ?? null;
}

function bluetoothdFacts(
  processes: string[][],
  mainConf: string | null,
): NonNullable<SystemFacts["bluetoothd"]> {
  const argv = processes.find((args) => basename(args[0]) === "bluetoothd");
  if (!argv) return { running: false, experimental: false };
  const flag = argv.slice(1).some((arg) => arg === "--experimental" || /^-[a-zA-Z]*E/.test(arg));
  return { running: true, experimental: flag || experimentalInConf(mainConf) };
}

/** `Experimental = true` (the effective last value, no inline comment) in main.conf's [General] section. */
export function experimentalInConf(conf: string | null): boolean {
  if (!conf) return false;
  let section = "";
  let value: boolean | null = null;
  for (const raw of conf.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) section = line;
    else if (section === "[General]") {
      const match = /^Experimental\s*=\s*(.+)$/.exec(line);
      if (match) value = /^true$/i.test(match[1]!.trim());
    }
  }
  return value === true;
}

async function bluetoothFacts(
  port: Pick<PhonePort, "Bluetooth"> | null,
): Promise<SystemFacts["bluetooth"]> {
  if (!port) return null;
  try {
    const bluetooth = await port.Bluetooth.open();
    const [adapter, devices] = await Promise.all([bluetooth.adapter(), bluetooth.devices()]);
    const adapters: AdapterFacts[] = adapter
      ? [
          {
            address: adapter.address,
            name: adapter.alias || adapter.name,
            powered: adapter.powered,
            class: adapter.class ?? null,
          },
        ]
      : [];
    const phones: PhoneFacts[] = devices
      .filter((device) => device.isIphone)
      .map((device) => ({
        address: device.address,
        name: device.alias || device.name || "iPhone",
        paired: device.paired,
        bonded: device.bonded,
        connected: device.connected,
      }));
    return { adapters, phones };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function obexdState(io: SystemIo): Promise<SystemFacts["obexd"]> {
  const result = await io.exec("busctl", ["--user", "list", "--no-legend"]);
  if (!result || result.code !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const [name, pid] = line.trim().split(/\s+/);
    if (name === "org.bluez.obex") return pid === "-" ? "activatable" : "running";
  }
  return "missing";
}

function basename(file: string | undefined): string {
  return file?.split("/").pop() ?? "";
}

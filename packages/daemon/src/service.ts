import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServiceFacts } from "@beyland/tincan-core";
import { TincanError } from "@beyland/tincan-protocol";

export const SERVICE_NAME = "tincan.service";

export interface UnitOptions {
  /** The command line, each argument unquoted. */
  execStart: string[];
  /** Extra environment variables for the service (`Environment="K=V"` lines). */
  environment?: Record<string, string>;
  /** Directories the daemon writes to; systemd specifiers like `%h` are kept as they are. */
  dataDir?: string;
  configDir?: string;
}

/**
 * The systemd user unit. `packaging/systemd/tincan.service` is this with `/usr/bin/env tincan daemon`;
 * a test keeps the two in step.
 */
export function renderUnit(options: UnitOptions): string {
  const dataDir = options.dataDir ?? "%h/.local/share/tincan";
  const configDir = options.configDir ?? "%h/.config/tincan";
  const envLines = Object.entries(options.environment ?? {}).map(
    ([key, value]) => `Environment=${quoteArg(`${key}=${value}`)}\n`,
  );
  return `[Unit]
Description=Tincan — iPhone messages on Linux
Documentation=https://tincan.beyland.dev
After=bluetooth.target dbus.socket
Wants=bluetooth.target
# Give up after 3 failed starts in a minute instead of retrying forever.
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
${envLines.join("")}ExecStart=${options.execStart.map(quoteArg).join(" ")}
Restart=on-failure
RestartSec=5
# 203/EXEC: the program is gone (e.g. Tincan was uninstalled); restarting won't help.
RestartPreventExitStatus=203
UMask=0077
# ProtectSystem=strict leaves $XDG_RUNTIME_DIR read-only, so systemd makes the socket's directory.
RuntimeDirectory=tincan
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${quotePath(`-${dataDir}`)} ${quotePath(`-${configDir}`)}
# No RestrictAddressFamilies=: the daemon itself only needs AF_UNIX (its socket, D-Bus), but it
# runs agent CLIs (\`claude mcp add\`), clipboard tools and doctor probes that may need others.

[Install]
WantedBy=default.target
`;
}

/**
 * Quotes a path list entry such as `ReadWritePaths=` (systemd unquotes each word, then reads the
 * `-` prefix), so a path with spaces stays one entry. `%` is left alone so specifiers like `%h`
 * still work; `$` isn't expanded there.
 */
function quotePath(entry: string): string {
  if (/[\r\n\0]/.test(entry)) {
    throw new TincanError(
      "INVALID_INPUT",
      "Can't write a systemd unit for a path or setting that contains a line break",
    );
  }
  return `"${entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Quotes an ExecStart argument the way systemd parses it (escaping `\`, `"`, `%`, and `$`). A line
 * break would end the directive and start a new one, so it's refused.
 */
function quoteArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new TincanError(
      "INVALID_INPUT",
      "Can't write a systemd unit for a path or setting that contains a line break",
    );
  }
  const escaped = arg
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return /[\s"'\\;$]/.test(arg) ? `"${escaped}"` : escaped;
}

export interface ServicePaths {
  unit: string;
  dataDir: string;
  configDir: string;
}

export function servicePaths(env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const home = env.HOME || os.homedir();
  const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return {
    unit: path.join(config, "systemd", "user", SERVICE_NAME),
    dataDir: path.join(data, "tincan"),
    configDir: path.join(config, "tincan"),
  };
}

export interface SystemctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `systemctl --user <args>`. */
export type Systemctl = (args: string[]) => Promise<SystemctlResult>;

export const systemctl: Systemctl = (args) =>
  new Promise((resolve, reject) => {
    execFile("systemctl", ["--user", ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(
          error.code === "ENOENT"
            ? new TincanError("NOT_FOUND", "systemctl isn't installed")
            : new TincanError("INTERNAL", error.message),
        );
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

export interface ServiceOptions {
  env?: NodeJS.ProcessEnv;
  systemctl?: Systemctl;
  /** Extra environment variables written into the systemd unit (`Environment=...`). */
  environment?: Record<string, string>;
}

export interface ServiceStatus extends ServiceFacts {
  path: string;
  execStart: string | null;
}

/** Writes the unit for `execStart`, then enables and starts it. */
export async function installService(
  execStart: string[],
  options: ServiceOptions = {},
): Promise<ServiceStatus> {
  await writeAndEnable(execStart, options);
  // A restart picks up a changed ExecStart when the service was already running.
  await check(options.systemctl ?? systemctl, ["restart", SERVICE_NAME]);
  return serviceStatus(options);
}

/** Writes the unit for `execStart` and enables it, without starting it. */
export async function enableService(
  execStart: string[],
  options: ServiceOptions = {},
): Promise<ServiceStatus> {
  await writeAndEnable(execStart, options);
  return serviceStatus(options);
}

async function writeAndEnable(execStart: string[], options: ServiceOptions): Promise<void> {
  const paths = servicePaths(options.env);
  const run = options.systemctl ?? systemctl;
  // ReadWritePaths skips missing directories, and ProtectHome then stops the daemon making them.
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const unit = renderUnit({
    execStart,
    environment: options.environment,
    dataDir: paths.dataDir,
    configDir: paths.configDir,
  });
  // The service can't write its own unit (ProtectHome), so leave an unchanged one alone.
  if ((await readUnit(paths.unit)) !== unit) {
    await mkdir(path.dirname(paths.unit), { recursive: true });
    await writeFile(paths.unit, unit);
    await check(run, ["daemon-reload"]);
  }
  await check(run, ["enable", SERVICE_NAME]);
}

/** Starts the installed service. */
export async function startService(options: ServiceOptions = {}): Promise<void> {
  await check(options.systemctl ?? systemctl, ["start", SERVICE_NAME]);
}

/** The service as a running daemon sees it; `runDaemon` hands over to it after `enable`. */
export interface DaemonService {
  /** Null when systemd can't be asked. */
  status(): Promise<ServiceFacts | null>;
  /** Writes and enables the unit without starting it. */
  enable(): Promise<ServiceFacts>;
  start(): Promise<void>;
  /** Disables the unit without stopping it, so a daemon that is the service can reply first. */
  disable(): Promise<ServiceFacts>;
}

/** The service that runs `execStart`, for a daemon to install itself as. */
export function daemonService(execStart: string[], options: ServiceOptions = {}): DaemonService {
  return {
    status: () => serviceStatus(options).then(facts, () => null),
    enable: () => enableService(execStart, options).then(facts),
    start: () => startService(options),
    disable: () => disableService(options).then(facts),
  };
}

function facts(status: ServiceStatus): ServiceFacts {
  return { installed: status.installed, enabled: status.enabled, active: status.active };
}

/** Stops and disables the service and removes its unit. Removing one that isn't there is fine. */
export async function uninstallService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const paths = servicePaths(options.env);
  const run = options.systemctl ?? systemctl;
  if (await readUnit(paths.unit)) await run(["disable", "--now", SERVICE_NAME]);
  await rm(paths.unit, { force: true });
  await check(run, ["daemon-reload"]);
  return serviceStatus(options);
}

/**
 * Disables the service, leaving a running one to stop on its own. The unit stays: the service can't
 * remove it (ProtectHome), and systemd does the disabling.
 */
export async function disableService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const paths = servicePaths(options.env);
  if (await readUnit(paths.unit))
    await check(options.systemctl ?? systemctl, ["disable", SERVICE_NAME]);
  return serviceStatus(options);
}

export async function serviceStatus(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const paths = servicePaths(options.env);
  const run = options.systemctl ?? systemctl;
  const unit = await readUnit(paths.unit);
  const execStart = unit?.match(/^ExecStart=(.*)$/m)?.[1] ?? null;
  if (unit === null) {
    return { path: paths.unit, execStart, installed: false, enabled: null, active: null };
  }
  const [enabled, active] = await Promise.all([
    run(["is-enabled", SERVICE_NAME]),
    run(["is-active", SERVICE_NAME]),
  ]);
  return {
    path: paths.unit,
    execStart,
    installed: true,
    enabled: enabled.stdout.trim() === "enabled",
    active: active.stdout.trim() === "active",
  };
}

async function readUnit(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function check(run: Systemctl, args: string[]): Promise<void> {
  const result = await run(args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new TincanError("INTERNAL", `systemctl --user ${args.join(" ")} failed: ${detail}`);
  }
}

import { realpathSync } from "node:fs";
import { diagnose, type SystemFacts } from "@beyland/tincan-core";
import {
  daemonService,
  installService,
  loadNative,
  serviceStatus,
  systemProbe,
  uninstallService,
  type DaemonService,
  type ServiceStatus,
  type Systemctl,
} from "@beyland/tincan-daemon";
import { TincanError, type DoctorReport } from "@beyland/tincan-protocol";

/** How the CLI reaches the computer outside the daemon; tests swap these out. */
export interface SystemHooks {
  probe?: () => Promise<SystemFacts>;
  systemctl?: Systemctl;
  /** The command line the service runs (default: this node and this tincan, then `daemon`). */
  execStart?: string[];
}

/** `doctor` without a daemon: the same checks, from this process, with the phone ones skipped. */
export async function offlineDoctor(
  env: NodeJS.ProcessEnv,
  hooks: SystemHooks = {},
): Promise<DoctorReport> {
  const probe = hooks.probe ?? systemProbe(await loadNative(), env);
  return { generatedAt: Date.now(), daemon: false, checks: diagnose(await probe(), null) };
}

export const SERVICE_ACTIONS = ["install", "uninstall", "status"] as const;

export const SERVICE_HELP = `tincan service <install|uninstall|status> [--json]

Run the Tincan daemon in the background as a systemd user service.

  install     Write ~/.config/systemd/user/tincan.service for this tincan, then enable and start it
  uninstall   Stop and disable the service and remove its unit
  status      Show whether the service is installed, enabled and running`;

export async function runService(
  action: string | undefined,
  env: NodeJS.ProcessEnv,
  hooks: SystemHooks = {},
): Promise<ServiceStatus> {
  const launch = hooks.execStart
    ? { execStart: hooks.execStart, environment: undefined }
    : currentExecStart(env);
  const options = {
    env,
    systemctl: hooks.systemctl,
    environment: launch.environment,
  };
  switch (action) {
    case "install":
      return installService(launch.execStart, options);
    case "uninstall":
      return uninstallService(options);
    case "status":
    case undefined:
      return serviceStatus(options);
    default:
      throw new TincanError("INVALID_INPUT", `Unknown service action: ${action}`, {
        expected: SERVICE_ACTIONS,
      });
  }
}

/**
 * The service `tincan daemon` can install itself as, for the desktop's offer. None for a fake phone or
 * a socket of its own: the unit runs the real phone on the default socket, so it can't stand in.
 */
export function managedService(
  env: NodeJS.ProcessEnv,
  ownSocket: boolean,
  hooks: SystemHooks = {},
): DaemonService | undefined {
  if (env.TINCAN_FAKE_PHONE || env.TINCAN_SOCKET || ownSocket) return undefined;
  const launch = hooks.execStart
    ? { execStart: hooks.execStart, environment: undefined }
    : currentExecStart(env);
  return daemonService(launch.execStart, {
    env,
    systemctl: hooks.systemctl,
    environment: launch.environment,
  });
}

/**
 * Resolves a stable `ExecStart` and optional `Environment` so the unit survives shell shims,
 * `.deb` Electron bundles (`ELECTRON_RUN_AS_NODE=1`), and AppImages (`$APPIMAGE` instead of an
 * ephemeral `/tmp/.mount_...` path).
 */
export function currentExecStart(env: NodeJS.ProcessEnv = process.env): {
  execStart: string[];
  environment?: Record<string, string>;
} {
  const isElectron = Boolean(process.versions.electron || env.ELECTRON_RUN_AS_NODE);
  if (isElectron && env.APPIMAGE) {
    return {
      execStart: [
        realpathSync(env.APPIMAGE),
        "-e",
        'const bin = process.env.APPDIR + "/resources/daemon/dist/bin.mjs"; process.argv.splice(1, 0, bin); await import(bin);',
        "--",
        "daemon",
      ],
      // User systemd units with ProtectSystem/ProtectHome/PrivateTmp run in an unprivileged user
      // namespace where setuid fusermount3 cannot mount FUSE; extract-and-run works inside PrivateTmp
      // while keeping full sandboxing (including NoNewPrivileges=yes).
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        APPIMAGE_EXTRACT_AND_RUN: "1",
      },
    };
  }
  const script = process.argv[1];
  if (!script) throw new TincanError("INTERNAL", "Can't tell where tincan is installed");
  return {
    execStart: [realpathSync(process.execPath), realpathSync(script), "daemon"],
    ...(isElectron ? { environment: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  };
}

/** Shown before `tincan setup install|uninstall`, which restart bluetooth.service as root. */
export const BLUETOOTH_RESTART_WARNING =
  "This restarts bluetooth.service: Bluetooth keyboards, mice and headphones disconnect for a moment.";

/**
 * How to run the system setup script for `action`: through sudo unless already root, with
 * `--yes` to skip the script's own restart question (it only asks on a terminal), and without
 * `ELECTRON_RUN_AS_NODE`, which the packaged `tincan` sets for itself but sudo shouldn't inherit.
 */
export function setupInvocation(
  script: string,
  action: string,
  options: { needsRoot: boolean; yes?: boolean; env?: NodeJS.ProcessEnv },
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const scriptArgs = [action, ...(options.yes && action !== "status" ? ["--yes"] : [])];
  const env = { ...(options.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  return options.needsRoot
    ? { command: "sudo", args: [script, ...scriptArgs], env }
    : { command: script, args: scriptArgs, env };
}

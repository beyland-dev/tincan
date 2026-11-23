import { execFile, spawn } from "node:child_process";
import { TincanError } from "@beyland/tincan-protocol";
import { TincanClient, type ConnectOptions } from "./client.ts";

export interface EnsureDaemonOptions extends ConnectOptions {
  /** systemd user unit to start when it's enabled (default `tincan.service`; null skips systemd). */
  service?: string | null;
  /** Command to spawn when no service is installed (default `tincan daemon`; null never spawns). */
  spawn?: { command: string; args?: Array<string>; env?: NodeJS.ProcessEnv } | null;
  /** How long to wait for the daemon to answer after starting it (default 10 s). */
  waitMs?: number;
  /** Replaces `systemctl --user <args>` (tests). Resolves on exit 0, rejects otherwise. */
  systemctl?: (args: Array<string>) => Promise<void>;
}

const userSystemctl = (args: Array<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("systemctl", ["--user", ...args], { timeout: 15_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/**
 * Connects to the daemon, starting it first if nothing is listening: the systemd user service when
 * it's enabled, otherwise a detached `tincan daemon`.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<TincanClient> {
  try {
    return await TincanClient.connect(options);
  } catch (error) {
    if (!(error instanceof TincanError) || error.code !== "NOT_CONNECTED") throw error;
  }

  const service = options.service === undefined ? "tincan.service" : options.service;
  const systemctl = options.systemctl ?? userSystemctl;
  let started = false;
  if (service) {
    try {
      // A disabled unit means the user turned the background service off.
      await systemctl(["is-enabled", "--quiet", service]);
      await systemctl(["start", service]);
      started = true;
    } catch {
      // Not installed, turned off, or no systemd: fall back to spawning.
    }
  }
  const spawnSpec =
    options.spawn === undefined ? { command: "tincan", args: ["daemon"] } : options.spawn;
  if (!started && spawnSpec) {
    const child = spawn(spawnSpec.command, spawnSpec.args ?? [], {
      detached: true,
      stdio: "ignore",
      env: spawnSpec.env ?? process.env,
    });
    child.on("error", () => {});
    child.unref();
    started = true;
  }
  if (!started) {
    throw new TincanError("NOT_CONNECTED", "The Tincan daemon is not running and can't be started");
  }

  const deadline = Date.now() + (options.waitMs ?? 10_000);
  for (;;) {
    try {
      return await TincanClient.connect(options);
    } catch (error) {
      const retryable = error instanceof TincanError && error.code === "NOT_CONNECTED";
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

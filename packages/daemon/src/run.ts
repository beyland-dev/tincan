import {
  Core,
  importPhotoFiles,
  type AgentConnections,
  type NativeInfo,
  type PhonePort,
  type SystemFacts,
} from "@beyland/tincan-core";
import { errorCodeOf } from "@beyland/tincan-protocol";
import { runtimePaths, type RuntimePaths } from "@beyland/tincan-protocol/paths";
import { startPhone, type PhoneRuntime } from "./phone.ts";
import { startDaemon, type Daemon } from "./server.ts";
import type { DaemonService } from "./service.ts";
import type { OpenedStore } from "./store.ts";

/** Long enough for a `service.*` reply to reach the client before the socket closes. */
const HANDOVER_DELAY_MS = 300;

export interface RunDaemonOptions {
  version: string;
  paths?: RuntimePaths;
  native?: NativeInfo;
  /** Inspects the computer for `doctor` (see `systemProbe`). */
  probeSystem?: () => Promise<SystemFacts>;
  log?: (message: string) => void;
  /** Stop on SIGINT/SIGTERM (default true). */
  handleSignals?: boolean;
  /** The message store; closed when the daemon stops. Without it nothing is kept. */
  store?: OpenedStore;
  /** The phone (the native addon, or a fake). Needs `store`. */
  port?: PhonePort | null;
  /**
   * The folder older versions kept contact photos in as plain files: imported into the store and
   * removed at startup.
   */
  legacyPhotosDir?: string | null;
  /** Where contact photos are written briefly as notification icons (`runtimeIconDir()`). */
  iconDir?: string | null;
  /**
   * Tincan's systemd user service, for `service.*`. Installing it from a daemon that isn't the
   * service stops this daemon and starts the service in its place; removing it while this daemon
   * is the service stops this daemon, and the app starts its own.
   */
  service?: DaemonService;
  /** Adds Tincan's MCP server to agents, for `agents.*`. */
  agentConnections?: AgentConnections;
}

/** Run the daemon until it receives SIGINT/SIGTERM or `stop()` is called. */
export async function runDaemon(options: RunDaemonOptions): Promise<{
  daemon: Daemon;
  core: Core;
  phone: PhoneRuntime | null;
  stop: () => Promise<void>;
  stopped: Promise<void>;
}> {
  const log = options.log ?? ((message: string) => process.stderr.write(`tincan: ${message}\n`));
  const opened = options.store;
  const probe = options.probeSystem;
  const service = options.service;
  let handingOver = false;
  const stopSoon = (message: string) =>
    setTimeout(() => {
      log(message);
      void stop();
    }, HANDOVER_DELAY_MS);
  const core = await Core.open({
    version: options.version,
    native: options.native,
    store: opened?.store,
    agentConnections: options.agentConnections,
    probeSystem:
      probe &&
      (async () => {
        const facts = await probe();
        return { ...facts, keyStorage: facts.keyStorage ?? opened?.keyStorage ?? null };
      }),
    service: service && {
      status: () => service.status(),
      install: async () => {
        const facts = await service.enable();
        // The lock lets one daemon run, so a running service is this daemon.
        const handover = !facts.active;
        if (handover && !handingOver) {
          handingOver = true;
          stopSoon("handing over to the background service");
        }
        return { ...facts, handover };
      },
      disable: async () => {
        const before = await service.status();
        const facts = await service.disable();
        // A clean exit doesn't trip Restart=on-failure, so the service stays stopped.
        const handover = before?.active === true;
        if (handover) stopSoon("background service turned off, stopping");
        return { ...facts, handover };
      },
    },
  });
  let daemon: Daemon;
  try {
    daemon = await startDaemon({ core, paths: options.paths ?? runtimePaths(), log });
  } catch (error) {
    await core.close();
    opened?.close();
    throw error;
  }
  if (opened && options.legacyPhotosDir) {
    try {
      const moved = importPhotoFiles(opened.store, options.legacyPhotosDir);
      if (moved) log(`moved ${moved.imported} contact photos into the store`);
    } catch (error) {
      log(`couldn't move contact photos into the store (${errorCodeOf(error)})`);
    }
  }
  const phone =
    opened && options.port
      ? await startPhone({ core, port: options.port, iconDir: options.iconDir, log })
      : null;
  core.setControl(phone);

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      core.setControl(null);
      await phone?.stop();
      await core.close();
      await daemon.close();
      opened?.close();
      if (handingOver) {
        await service?.start().catch((error: unknown) => {
          log(`couldn't start the background service: ${(error as Error).message}`);
        });
      }
      resolveStopped();
    })();
    return stopping;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    log(`received ${signal}, shutting down`);
    void stop();
  };
  if (options.handleSignals ?? true) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  return { daemon, core, phone, stop, stopped };
}

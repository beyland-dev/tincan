import { z } from "zod";
import { defineContract } from "../contract.ts";
import {
  AgentSettingsPatch,
  AgentVisibleSettings,
  ConnectionState,
  Device,
  DoctorReport,
  SendDelaySeconds,
  Settings,
  Timestamp,
} from "../entities.ts";
import { PROTOCOL_VERSION } from "../envelope.ts";

export const status = defineContract({
  name: "status",
  title: "Status",
  description: "Daemon, Bluetooth and phone connection status.",
  kind: "query",
  input: z.object({}),
  output: z.object({
    daemon: z.object({
      version: z.string(),
      protocolVersion: z.literal(PROTOCOL_VERSION),
      pid: z.number().int(),
      startedAt: Timestamp,
      uptimeMs: z.number().int().nonnegative(),
    }),
    native: z.object({
      loaded: z.boolean(),
      version: z.string().nullable(),
      error: z.string().nullable(),
    }),
    phone: z.object({
      state: ConnectionState,
      device: Device.nullable(),
    }),
  }),
});

export const version = defineContract({
  name: "version",
  title: "Version",
  description: "Daemon and protocol versions.",
  kind: "query",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
  }),
});

export const doctor = defineContract({
  name: "doctor",
  title: "Diagnose setup",
  description:
    "Check Bluetooth, the phone and Tincan's own setup. Each check is ok, warn, fail or skip, with a hint for fixing it.",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: DoctorReport,
});

export const CommandDescriptorSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["query", "mutation"]),
  positional: z.array(z.string()),
  internal: z.boolean(),
  sensitive: z.boolean(),
  agentScope: z.enum(["read", "drafts", "manage", "ownDrafts"]).optional(),
  approval: z.enum(["none", "agent"]),
  destructive: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

export const commands = defineContract({
  name: "commands",
  title: "List commands",
  description:
    "Every command the daemon implements, with JSON Schemas for its input and output and its policy flags.",
  kind: "query",
  input: z.object({
    includeInternal: z
      .boolean()
      .optional()
      .describe("Include commands only the desktop app or an interactive CLI may call"),
  }),
  output: z.array(CommandDescriptorSchema),
});

export const settingsGet = defineContract({
  name: "settings.get",
  title: "Get settings",
  description:
    "Current settings. AI agents get only the agent policy (`agents`): what access the user has given them.",
  kind: "query",
  input: z.object({}),
  output: z.union([Settings, AgentVisibleSettings]),
});

/**
 * `AgentSettingsPatch` refusing keys it doesn't know, so a client still sending a removed setting
 * (`agents.enabled`, replaced by `agents.access`) gets an error rather than a silent no-op.
 */
const StrictAgentSettingsPatch = z.strictObject(AgentSettingsPatch.shape, {
  error: (issue) => {
    if (issue.code !== "unrecognized_keys") return undefined;
    if (issue.keys.includes("enabled")) {
      return "agents.enabled was replaced by agents.access (off, readOnly, assistant or full)";
    }
    if (issue.keys.includes("drafts")) {
      return "agents.drafts was removed: agents may save drafts whenever they may send (agents.access)";
    }
    return `Unknown agent setting${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}`;
  },
});

export const settingsSet = defineContract({
  name: "settings.set",
  title: "Change settings",
  description: "Change settings. Only the desktop app or an interactive CLI may change them.",
  kind: "mutation",
  internal: true,
  input: z.object({
    agents: StrictAgentSettingsPatch.optional(),
    notifications: Settings.shape.notifications.partial().optional(),
    defaultRegion: Settings.shape.defaultRegion.optional(),
    sendDelaySeconds: SendDelaySeconds.optional().describe(
      "How long your own messages wait on this computer before going to the phone (0: off)",
    ),
  }),
  output: Settings,
});

export const ServiceState = z.object({
  installed: z.boolean(),
  /** Null when the service isn't installed. */
  enabled: z.boolean().nullable(),
  active: z.boolean().nullable(),
});
export type ServiceState = z.infer<typeof ServiceState>;

export const serviceStatus = defineContract({
  name: "service.status",
  title: "Background service",
  description:
    "Whether Tincan's systemd user service is installed, enabled and running. Null when this daemon can't ask systemd.",
  kind: "query",
  internal: true,
  input: z.object({}),
  output: ServiceState.nullable(),
});

export const serviceInstall = defineContract({
  name: "service.install",
  title: "Install the background service",
  description:
    "Install and enable Tincan's systemd user service, so the daemon starts at login and restarts if it stops. A daemon that isn't the service hands over to it (`handover`): it stops, and the service starts in its place.",
  kind: "mutation",
  internal: true,
  input: z.object({}),
  output: ServiceState.extend({ handover: z.boolean() }),
});

export const serviceDisable = defineContract({
  name: "service.disable",
  title: "Turn off the background service",
  description:
    "Disable Tincan's systemd user service, so the daemon no longer starts at login. The unit stays (`tincan service uninstall` removes it). When this daemon is the service it then stops (`handover`), and the app starts its own daemon in its place.",
  kind: "mutation",
  internal: true,
  input: z.object({}),
  output: ServiceState.extend({ handover: z.boolean() }),
});

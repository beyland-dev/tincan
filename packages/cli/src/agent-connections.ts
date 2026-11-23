import type { AgentConnections } from "@beyland/tincan-core";
import {
  ErrorCode,
  TincanError,
  type AgentClient,
  type AgentConnection,
} from "@beyland/tincan-protocol";
import {
  installMcpConfig,
  MCP_CLIENT_NAMES,
  MCP_CLIENTS,
  mcpConfigBody,
  mcpConfigStatus,
  removeMcpConfig,
  shellQuote,
  type Exec,
  type StdioLaunch,
} from "./mcp-config.ts";

/** What running the CLI elsewhere printed. */
export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentConnectionOptions {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  /** How a terminal runs this CLI: `tincan`, or this Node and script when it isn't on PATH. */
  cli: string[];
  /**
   * Runs this CLI with `args` outside this process's sandbox. The background service can't write
   * the agents' configs (ProtectHome), so it changes them through this instead.
   */
  outside?: (args: string[]) => Promise<CliRun>;
  /** Extra `tincan mcp` arguments, e.g. `--socket`, kept in step with `launch`. */
  launchArgs?: string[];
}

/** Sets agents up to start `launch` (this CLI's `tincan mcp`), for the daemon's `agents.*`. */
export function agentConnections(
  launch: StdioLaunch,
  options: AgentConnectionOptions,
): AgentConnections {
  const { env, exec, outside } = options;
  const describe = async (client: AgentClient): Promise<AgentConnection> => {
    const status = await mcpConfigStatus(client, launch, { env });
    return {
      client,
      name: MCP_CLIENT_NAMES[client],
      file: status.file,
      configured: status.configured,
      current: status.current,
      snippet: mcpConfigBody(client, launch),
      terminal: [...options.cli, "connect", client].map(shellQuote).join(" "),
    };
  };
  const runOutside = async (args: string[]) => {
    const result = await outside!([...(options.launchArgs ?? []), ...args, "--json"]);
    if (result.status === 0) return;
    throw cliError(result);
  };
  return {
    launch,
    list: () => Promise.all(MCP_CLIENTS.map(describe)),
    connect: async (client, force) => {
      if (outside) await runOutside(["connect", client, ...(force ? ["--force"] : [])]);
      else await installMcpConfig(client, launch, { env, exec, force });
      return describe(client);
    },
    disconnect: async (client) => {
      if (outside) await runOutside(["disconnect", client]);
      else await removeMcpConfig(client, { env, exec });
      return describe(client);
    },
  };
}

/** The error a `--json` run printed (`{ ok: false, error: { code, message } }`), as a TincanError. */
function cliError(result: CliRun): TincanError {
  try {
    const { error } = JSON.parse(result.stderr) as { error?: { code?: string; message?: string } };
    if (error?.message) {
      const code = ErrorCode.safeParse(error.code);
      return new TincanError(code.success ? code.data : "INTERNAL", error.message);
    }
  } catch {
    // Not JSON: fall through to the raw output.
  }
  const detail = (result.stderr || result.stdout).trim() || `exit ${result.status ?? "signal"}`;
  return new TincanError("INTERNAL", `Couldn't change the agent's config: ${detail}`);
}

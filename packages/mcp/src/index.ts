import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ReadResourceResult,
  RegisteredResource,
  RegisteredResourceTemplate,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  contracts,
  effectiveAgents,
  errorCodeOf,
  AgentVisibleSettings,
  type AnyContract,
  type TincanEvent,
} from "@beyland/tincan-protocol";
import { DaemonConnection, type TincanConnection } from "./connection.ts";
import {
  GUIDE,
  GUIDE_URI,
  INSTRUCTIONS,
  THREAD_URI_TEMPLATE,
  THREADS_URI,
  UNTRUSTED_NOTE,
} from "./guide.ts";

export {
  DaemonConnection,
  type DaemonConnectionOptions,
  type TincanConnection,
} from "./connection.ts";
export {
  GUIDE,
  GUIDE_URI,
  INSTRUCTIONS,
  THREAD_URI_TEMPLATE,
  THREADS_URI,
  UNTRUSTED_NOTE,
} from "./guide.ts";

const SERVER_NAME = "tincan";
const DEFAULT_VERSION = "0.0.0";
const RECENT_MESSAGES = 50;

export interface McpServerOptions {
  /** The daemon connection; its client kind should be `mcp` so the agent policy applies. */
  client: TincanConnection;
  /** Reported as the MCP server version. */
  version?: string;
}

/** MCP tool name for a Tincan command: `message.send` → `message_send`. */
export function toolNameFor(command: string): string {
  return command.replaceAll(".", "_");
}

/** Every contract an agent can call: internal ones (settings.set, draft.send, …) are left out. */
export function agentContracts(): AnyContract[] {
  return (contracts as readonly AnyContract[]).filter((contract) => !contract.internal);
}

/**
 * An MCP server exposing every non-internal Tincan command as a tool, plus resources: `tincan://guide`
 * always, and `tincan://threads` / `tincan://thread/{key}` while the user lets agents read messages
 * (`agents.read` isn't `off` as `agents.access` caps it; the daemon applies its scope to what they
 * return).
 *
 * Tool input and output schemas are the commands' zod schemas. Commands that return an array
 * (thread.list, message.list, …) keep their array output schema rather than being wrapped here: the
 * MCP SDK adapts it to the negotiated protocol, advertising and returning `{ result: [...] }` to
 * 2025-protocol clients (whose output schemas must be objects) and the bare array on 2026-07-28.
 */
export async function createMcpServer(options: McpServerOptions): Promise<McpServer> {
  const { client } = options;
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? DEFAULT_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const contract of agentContracts()) registerCommandTool(server, client, contract);

  server.registerResource(
    "guide",
    GUIDE_URI,
    {
      title: "Tincan guide for agents",
      description: "What Tincan is, how sends and agent drafts work, and privacy expectations.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  // Registered only while reading is on: the SDK still lists disabled resource templates.
  let readable: (RegisteredResource | RegisteredResourceTemplate)[] | undefined;
  const apply = (settings: AgentVisibleSettings): void => {
    // `effectiveAgents`: off access reads nothing; read-only access always reads something.
    const on = effectiveAgents(settings.agents).read !== "off";
    if (on && !readable) readable = registerReadResources(server, client);
    if (!on && readable) {
      for (const resource of readable) resource.remove();
      readable = undefined;
    }
  };
  const refresh = async (): Promise<void> => {
    try {
      // Agents get only the agent policy (`AgentVisibleSettings`).
      apply(AgentVisibleSettings.parse(await client.call("settings.get", {})));
    } catch {
      // Daemon not running yet (or an older one): keep message resources hidden until it is.
    }
  };

  client.onConnect?.(() => void refresh());
  if (client.subscribe) {
    try {
      await client.subscribe((event: TincanEvent) => {
        if (event.event !== "settings.changed") return;
        const parsed = AgentVisibleSettings.safeParse(event.data);
        if (parsed.success) apply(parsed.data);
      });
    } catch {
      // Not connected yet; the connection subscribes once it is.
    }
  }
  await refresh();
  return server;
}

function registerCommandTool(
  server: McpServer,
  client: TincanConnection,
  contract: AnyContract,
): void {
  const description =
    contract.approval === "agent"
      ? `${contract.description}\n\nThis returns at once. Depending on the user's agents.send setting the message goes after the agent send delay (\`scheduled\`, then \`sent\`) or waits in Tincan as an agent draft for the user to send, edit or discard (\`queued\`): always with \`approve\`; with \`replied\` unless it's to someone the user has texted themselves. Tell the user it's ready in Tincan rather than polling; draft_get (optionally with \`wait\`) tells you how it ended. Don't send it again after \`discarded\` or \`cancelled\` unless the user asks.`
      : contract.description;
  const untrusted = carriesUntrustedContent(contract);
  const fullDescription = untrusted ? `${description}\n\n${UNTRUSTED_NOTE}` : description;
  server.registerTool(
    toolNameFor(contract.name),
    {
      title: contract.title,
      description: fullDescription,
      inputSchema: contract.input,
      outputSchema: contract.output,
      annotations: {
        title: contract.title,
        readOnlyHint: contract.kind === "query",
        destructiveHint: contract.destructive === true,
        openWorldHint: false,
      },
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        const result = await client.call(contract.name, args ?? {});
        const text = JSON.stringify(result, null, 2);
        return {
          content: untrusted
            ? [
                { type: "text", text: UNTRUSTED_NOTE },
                { type: "text", text },
              ]
            : [{ type: "text", text }],
          structuredContent: result as CallToolResult["structuredContent"],
          ...(untrusted ? { _meta: { "tincan/untrusted": true } } : {}),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/**
 * Whether a command's result carries text from the phone or other people (messages, names, titles,
 * group names, contact fields, agent drafts): every `sensitive` command.
 */
export function carriesUntrustedContent(contract: AnyContract): boolean {
  return contract.sensitive === true;
}

/** Errors as `CODE: message`, the same codes the CLI and desktop app see. */
export function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `${errorCodeOf(error)}: ${message}` }] };
}

function registerReadResources(
  server: McpServer,
  client: TincanConnection,
): (RegisteredResource | RegisteredResourceTemplate)[] {
  // Resources aren't schema-bound, so the untrusted marker goes into the JSON itself.
  const json = (uri: URL, value: unknown): ReadResourceResult => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ _untrusted: UNTRUSTED_NOTE, data: value }, null, 2),
      },
    ],
  });
  const threads = server.registerResource(
    "threads",
    THREADS_URI,
    {
      title: "Conversations",
      description: "Recent conversations with their last message and unread count.",
      mimeType: "application/json",
    },
    async (uri) => json(uri, await client.call("thread.list", {})),
  );
  const thread = server.registerResource(
    "thread",
    new ResourceTemplate(THREAD_URI_TEMPLATE, { list: undefined }),
    {
      title: "Conversation",
      description: `A conversation and its ${RECENT_MESSAGES} most recent messages. The key is a percent-encoded \`key\` from thread_list (an opaque handle ID while handles are hidden), e.g. tincan://thread/handle%3AAbC123xYz.`,
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = variables.key;
      const key = decodeURIComponent(Array.isArray(raw) ? raw.join("/") : String(raw));
      const [conversation, messages] = await Promise.all([
        client.call("thread.get", { key }),
        client.call("message.list", { threadKey: key, limit: RECENT_MESSAGES }),
      ]);
      return json(uri, { ...(conversation as object), messages });
    },
  );
  return [threads, thread];
}

export interface StdioServerOptions {
  /** Daemon socket (default: the standard runtime path). */
  socketPath?: string;
  version?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/**
 * Serve MCP over stdio, connected to the daemon as an `mcp` client. Resolves when the MCP client
 * disconnects. Writes nothing but protocol messages to stdout.
 */
export async function runStdioServer(options: StdioServerOptions = {}): Promise<void> {
  const client = new DaemonConnection({ socketPath: options.socketPath });
  const server = await createMcpServer({ client, version: options.version });
  const transport = new StdioServerTransport(
    options.stdin as ConstructorParameters<typeof StdioServerTransport>[0],
    options.stdout as ConstructorParameters<typeof StdioServerTransport>[1],
  );
  const stdin = options.stdin ?? process.stdin;
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    stdin.once("end", () => resolve());
    stdin.once("close", () => resolve());
  });
  await server.connect(transport);
  try {
    await closed;
  } finally {
    await server.close().catch(() => {});
    await client.close();
  }
}

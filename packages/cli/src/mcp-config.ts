// Adds Tincan's MCP server to AI agents' user-level configs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TincanError } from "@beyland/tincan-protocol";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";

export type McpClient =
  | "copilot"
  | "claude"
  | "codex"
  | "antigravity"
  | "muse"
  | "cursor"
  | "opencode"
  | "pi";

export const MCP_CLIENTS: McpClient[] = [
  "copilot",
  "claude",
  "codex",
  "antigravity",
  "muse",
  "cursor",
  "opencode",
  "pi",
];

/** What each client is called in the app. */
export const MCP_CLIENT_NAMES: Record<McpClient, string> = {
  copilot: "Copilot",
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  muse: "Muse Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

/** Other names that still work (not listed in help). */
const CLIENT_ALIASES: Record<string, McpClient> = {
  vscode: "copilot",
  code: "copilot",
  "copilot-cli": "copilot",
  "claude-code": "claude",
};

export const DEFAULT_SERVER_NAME = "tincan";

/** The client a name refers to, including aliases; undefined for unknown names. */
export function resolveMcpClient(name: string): McpClient | undefined {
  return MCP_CLIENTS.includes(name as McpClient) ? (name as McpClient) : CLIENT_ALIASES[name];
}

export interface StdioLaunch {
  command: string;
  args: string[];
}

export interface McpConfigInstallResult {
  client: McpClient;
  file: string;
  name: string;
  status: "created" | "updated" | "unchanged";
  /** Set when the client's own CLI wrote its config (e.g. `claude mcp add`). */
  via?: string;
}

/** Runs another program synchronously (the client CLIs that own their config files). */
export type Exec = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string; error?: Error };

/**
 * The environment for programs the CLI starts. The packaged `tincan` runs the Electron binary as
 * Node with `ELECTRON_RUN_AS_NODE=1`, which would turn any Electron app those programs start into
 * plain Node too. (Starting tincan itself sets it again where needed.)
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

/** Runs a client CLI without passing on `ELECTRON_RUN_AS_NODE`. */
export const spawnExec: Exec = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", env: childEnv() });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  name?: string;
  force?: boolean;
  exec?: Exec;
}

const portableMcpEntry = (launch: StdioLaunch): Record<string, unknown> => ({
  command: launch.command,
  args: launch.args,
  tools: ["*"],
});

const stdioEntry = (launch: StdioLaunch) => ({ command: launch.command, args: launch.args });

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

function configHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config");
}

function copilotMcpConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.COPILOT_HOME || path.join(homeOf(env), ".copilot"), "mcp-config.json");
}

/** OpenCode reads opencode.jsonc or opencode.json from its config folder; use whichever exists. */
function opencodeConfigPath(env: NodeJS.ProcessEnv): string {
  const dir = path.join(configHome(env), "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : path.join(dir, "opencode.json");
}

/** A client whose config is a JSON(C) file we merge into. */
interface JsonTarget {
  kind: "json";
  note: string;
  file: (env: NodeJS.ProcessEnv) => string;
  /** Where the server entry goes, e.g. ["mcpServers", name]. */
  key: (name: string) => string[];
  entry: (launch: StdioLaunch) => Record<string, unknown>;
  /** Top-level fields for a new file. */
  init?: Record<string, unknown>;
}

/** A client that owns its config (a format we don't edit), so its CLI adds the server. */
interface CliTarget {
  kind: "cli";
  note: string;
  bin: string;
  file: (env: NodeJS.ProcessEnv) => string;
  /** The current entry for `name`, or undefined (read-only; the CLI does the writing). */
  current: (text: string, name: string) => StdioLaunch | undefined;
  add: (name: string, launch: StdioLaunch) => string[];
  remove: (name: string) => string[];
  snippet: (name: string, launch: StdioLaunch) => string;
}

const TARGETS: Record<McpClient, JsonTarget | CliTarget> = {
  copilot: {
    kind: "json",
    note: "GitHub Copilot in VS Code, the Copilot app, and the Copilot CLI (~/.copilot/mcp-config.json, or $COPILOT_HOME/mcp-config.json)",
    file: copilotMcpConfigPath,
    key: (name) => ["mcpServers", name],
    entry: portableMcpEntry,
  },
  cursor: {
    kind: "json",
    note: "Cursor (~/.cursor/mcp.json)",
    file: (env) => path.join(homeOf(env), ".cursor", "mcp.json"),
    key: (name) => ["mcpServers", name],
    entry: stdioEntry,
  },
  antigravity: {
    kind: "json",
    note: "Google Antigravity 2.0, IDE, and CLI (~/.gemini/config/mcp_config.json)",
    file: (env) => path.join(homeOf(env), ".gemini", "config", "mcp_config.json"),
    key: (name) => ["mcpServers", name],
    entry: stdioEntry,
  },
  muse: {
    kind: "json",
    note: "Muse Code (~/.config/muse/settings.json)",
    file: (env) => path.join(configHome(env), "muse", "settings.json"),
    key: (name) => ["mcp_servers", name],
    // "optional": Muse Code aborts a run when a required server can't start.
    entry: (l) => ({ transport: "stdio", command: l.command, args: l.args, mode: "optional" }),
    // Muse Code refuses to start without a schema version.
    init: { schema_version: 1 },
  },
  pi: {
    kind: "json",
    note: "Pi 0.99+ (~/.pi/agent/mcp.json; run /reload in open sessions)",
    file: (env) => path.join(homeOf(env), ".pi", "agent", "mcp.json"),
    key: (name) => ["mcpServers", name],
    entry: stdioEntry,
  },
  opencode: {
    kind: "json",
    note: "OpenCode (~/.config/opencode/opencode.json)",
    file: opencodeConfigPath,
    key: (name) => ["mcp", name],
    entry: (l) => ({ type: "local", command: [l.command, ...l.args], enabled: true }),
    init: { $schema: "https://opencode.ai/config.json" },
  },
  claude: {
    kind: "cli",
    note: "Claude Code (user scope, via `claude mcp add`)",
    bin: "claude",
    file: (env) => path.join(env.CLAUDE_CONFIG_DIR || homeOf(env), ".claude.json"),
    current: (text, name) => {
      const servers = (parse(text) as { mcpServers?: Record<string, unknown> } | undefined)
        ?.mcpServers;
      const entry = isRecord(servers) ? servers[name] : undefined;
      return isRecord(entry) && typeof entry.command === "string"
        ? { command: entry.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [] }
        : undefined;
    },
    add: (name, l) => ["mcp", "add", "--scope", "user", name, "--", l.command, ...l.args],
    remove: (name) => ["mcp", "remove", "--scope", "user", name],
    snippet: (name, l) =>
      ["claude", "mcp", "add", "--scope", "user", name, "--", l.command, ...l.args]
        .map(shellQuote)
        .join(" "),
  },
  codex: {
    kind: "cli",
    note: "Codex CLI and IDE extension (~/.codex/config.toml, via `codex mcp add`)",
    bin: "codex",
    file: (env) => path.join(env.CODEX_HOME || path.join(homeOf(env), ".codex"), "config.toml"),
    current: (text, name) => {
      const section = tomlSection(text, `mcp_servers.${name}`);
      if (section === undefined) return undefined;
      const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(section)?.[1];
      const args = /^\s*args\s*=\s*(\[[^\]]*\])/m.exec(section)?.[1];
      try {
        return {
          command: command ? (JSON.parse(command) as string) : "",
          args: args ? (JSON.parse(args) as string[]) : [],
        };
      } catch {
        return { command: "", args: [] };
      }
    },
    add: (name, l) => ["mcp", "add", name, "--", l.command, ...l.args],
    remove: (name) => ["mcp", "remove", name],
    snippet: (name, l) =>
      `[mcp_servers.${name}]\ncommand = ${JSON.stringify(l.command)}\nargs = ${JSON.stringify(l.args)}`,
  },
};

/** Where `client` keeps its MCP servers. */
export function mcpConfigFile(client: McpClient, env: NodeJS.ProcessEnv = process.env): string {
  return TARGETS[client].file(env);
}

/** The body of `[header]` in a TOML file (up to the next table header), or undefined. */
function tomlSection(text: string, header: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export function mcpConfigSnippet(
  client: McpClient,
  launch: StdioLaunch,
  name = DEFAULT_SERVER_NAME,
): string {
  return `${TARGETS[client].note}\n\n${mcpConfigBody(client, launch, name)}`;
}

/** The command to run, or the JSON to merge, that adds Tincan to `client`. */
export function mcpConfigBody(
  client: McpClient,
  launch: StdioLaunch,
  name = DEFAULT_SERVER_NAME,
): string {
  const target = TARGETS[client];
  if (target.kind === "cli") return target.snippet(name, launch);
  let value: unknown = target.entry(launch);
  for (const key of target.key(name).toReversed()) value = { [key]: value };
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formattingOptions(text: string): FormattingOptions {
  const indent = /(?:^|\r?\n)([ \t]+)"/.exec(text)?.[1];
  return {
    insertSpaces: !indent?.includes("\t"),
    tabSize: indent && !indent.includes("\t") ? indent.length : 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** Parses a JSON(C) config, or throws `INVALID_INPUT` naming the file. */
function parseConfig(file: string, text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !isRecord(config))
    throw new TincanError(
      "INVALID_INPUT",
      `${file} is not a valid JSON object. Fix it before changing Tincan's MCP server.`,
    );
  return config;
}

/** Sets (or, with undefined, removes) the value at `key`, keeping comments and formatting. */
async function editJson(file: string, text: string, key: string[], value: unknown): Promise<void> {
  const format = formattingOptions(text);
  const next = applyEdits(text, modify(text, key, value, { formattingOptions: format }));
  const eol = format.eol ?? "\n";
  await writeFileAtomic(file, next.endsWith(eol) ? next : `${next}${eol}`);
}

/**
 * Replaces `file` so that a crash or full disk leaves either the old or the new contents, never a
 * truncated config: writes a temporary file beside it, syncs it, then renames it over. Keeps an
 * existing file's permissions (new files are private) and writes through a symlink to its target.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  let target = file;
  let mode = 0o600;
  try {
    target = await realpath(file);
    mode = (await stat(target)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.tincan-${randomBytes(6).toString("hex")}`);
  const handle = await open(temp, "wx", mode);
  try {
    try {
      await handle.writeFile(data, "utf8");
      // `open`'s mode is filtered by the umask; set the one the file had.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  // Persist the rename itself (best effort: not every filesystem lets a directory be synced).
  const dirHandle = await open(dir, "r").catch(() => null);
  await dirHandle?.sync().catch(() => {});
  await dirHandle?.close();
}

/** Merge the Tincan server into a JSON(C) config without touching other servers or comments. */
async function installJson(
  client: McpClient,
  target: JsonTarget,
  launch: StdioLaunch,
  options: InstallOptions,
): Promise<McpConfigInstallResult> {
  const file = target.file(options.env ?? process.env);
  const name = options.name?.trim() || DEFAULT_SERVER_NAME;
  let exists = true;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
    text = target.init ? `${JSON.stringify(target.init, null, 2)}\n` : "{}\n";
  }

  const config = parseConfig(file, text);
  const [parentKey] = target.key(name);
  const parent = config[parentKey!];
  if (parent !== undefined && !isRecord(parent))
    throw new TincanError(
      "INVALID_INPUT",
      `${file} has an invalid ${parentKey} value; expected an object.`,
    );

  const entry = target.entry(launch);
  const current = isRecord(parent) ? parent[name] : undefined;
  if (current !== undefined) {
    if (isDeepStrictEqual(current, entry)) return { client, file, name, status: "unchanged" };
    if (!options.force)
      throw new TincanError(
        "CONFLICT",
        `MCP server ${JSON.stringify(name)} already exists in ${file}. Re-run with --force to replace only that entry.`,
      );
  }

  await editJson(file, text, target.key(name), entry);
  return { client, file, name, status: exists ? "updated" : "created" };
}

/**
 * Where `name` is installed: on PATH, or in the user's own bin folders, which a background
 * service's PATH may lack.
 */
export function findCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = homeOf(env);
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Runs the client's own CLI, explaining a missing one with what to add by hand. */
function runClientCli(
  target: CliTarget,
  options: InstallOptions,
  args: string[],
  launch?: StdioLaunch,
): void {
  const env = options.env ?? process.env;
  const name = options.name?.trim() || DEFAULT_SERVER_NAME;
  const exec = options.exec ?? spawnExec;
  const result = exec(findCommand(target.bin, env) ?? target.bin, args);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT")
    throw new TincanError(
      "NOT_FOUND",
      launch
        ? `Couldn't find the ${target.bin} command. Install it, or add Tincan yourself:\n\n${target.snippet(name, launch)}`
        : `Couldn't find the ${target.bin} command.`,
    );
  if (result.status !== 0)
    throw new TincanError(
      "INTERNAL",
      `${target.bin} ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
}

/** Let the client's own CLI add the server, after checking what's there already. */
async function installViaCli(
  client: McpClient,
  target: CliTarget,
  launch: StdioLaunch,
  options: InstallOptions,
): Promise<McpConfigInstallResult> {
  const env = options.env ?? process.env;
  const file = target.file(env);
  const name = options.name?.trim() || DEFAULT_SERVER_NAME;
  const text = await readFile(file, "utf8").catch(() => "");
  const current = text ? target.current(text, name) : undefined;
  if (current) {
    if (isDeepStrictEqual(current, launch))
      return { client, file, name, status: "unchanged", via: target.bin };
    if (!options.force)
      throw new TincanError(
        "CONFLICT",
        `MCP server ${JSON.stringify(name)} already exists in ${file}. Re-run with --force to replace it.`,
      );
  }
  if (!current) {
    runClientCli(target, options, target.add(name, launch), launch);
    return { client, file, name, status: "created", via: target.bin };
  }
  // These CLIs refuse to add a name that exists, so the old entry goes first; if the new one then
  // can't be added, put the old one back rather than leave the user with neither.
  runClientCli(target, options, target.remove(name), launch);
  try {
    runClientCli(target, options, target.add(name, launch), launch);
  } catch (error) {
    try {
      runClientCli(target, options, target.add(name, current), current);
    } catch {
      throw new TincanError(
        "INTERNAL",
        `${(error as Error).message}\n\nThe previous ${JSON.stringify(name)} entry was removed and couldn't be restored. To restore it:\n\n${target.snippet(name, current)}`,
      );
    }
    throw error;
  }
  return { client, file, name, status: "updated", via: target.bin };
}

/** Add Tincan to a client's user-level MCP config (idempotent; `force` replaces a different entry). */
export function installMcpConfig(
  client: McpClient,
  launch: StdioLaunch,
  options: InstallOptions = {},
): Promise<McpConfigInstallResult> {
  const target = TARGETS[client];
  return target.kind === "json"
    ? installJson(client, target, launch, options)
    : installViaCli(client, target, launch, options);
}

export interface McpConfigStatus {
  client: McpClient;
  file: string;
  /** Tincan (`name`) is in the client's config. */
  configured: boolean;
  /** …and launches the way `launch` would (false: another install, or an older path). */
  current: boolean;
}

/** Read-only: is Tincan already set up for this client? Unreadable configs count as not set up. */
export async function mcpConfigStatus(
  client: McpClient,
  launch: StdioLaunch,
  options: { env?: NodeJS.ProcessEnv; name?: string } = {},
): Promise<McpConfigStatus> {
  const target = TARGETS[client];
  const file = target.file(options.env ?? process.env);
  const name = options.name?.trim() || DEFAULT_SERVER_NAME;
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) return { client, file, configured: false, current: false };
  if (target.kind === "cli") {
    const current = target.current(text, name);
    return {
      client,
      file,
      configured: Boolean(current),
      current: Boolean(current && isDeepStrictEqual(current, launch)),
    };
  }
  let value: unknown = parse(text, [], { allowTrailingComma: true, disallowComments: false });
  for (const key of target.key(name)) value = isRecord(value) ? value[key] : undefined;
  return {
    client,
    file,
    configured: value !== undefined,
    current: value !== undefined && isDeepStrictEqual(value, target.entry(launch)),
  };
}

/** Removes Tincan's entry from `client`'s config; `absent` when there was none. */
export async function removeMcpConfig(
  client: McpClient,
  options: InstallOptions = {},
): Promise<"removed" | "absent"> {
  const target = TARGETS[client];
  const file = target.file(options.env ?? process.env);
  const name = options.name?.trim() || DEFAULT_SERVER_NAME;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (target.kind === "cli") {
    if (!target.current(text, name)) return "absent";
    runClientCli(target, options, target.remove(name));
    return "removed";
  }
  let value: unknown = parseConfig(file, text);
  for (const key of target.key(name)) value = isRecord(value) ? value[key] : undefined;
  if (value === undefined) return "absent";
  await editJson(file, text, target.key(name), undefined);
  return "removed";
}

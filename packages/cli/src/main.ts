import { execFile, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TincanClient } from "@beyland/tincan-client";
import {
  loadNative,
  openMemoryStore,
  openVaultStore,
  runDaemon,
  runtimeIconDir,
  SERVICE_NAME,
  servicePaths,
  systemProbe,
  type LoadedNative,
  type OpenedStore,
} from "@beyland/tincan-daemon";
import {
  accessPatch,
  agentEnvironmentMarker,
  agentEnvironmentName,
  describeContracts,
  isTincanError,
  redactDoctorReport,
  TincanError,
  protocolSchema,
  type AgentAccess,
  type AgentConnection,
  type AgentDraft,
  type ClientInfo,
  type ContractDescriptor,
  type DoctorReport,
  type OutputOf,
  type SendResult,
  type Settings,
} from "@beyland/tincan-protocol";
import { runtimePaths, type RuntimePaths } from "@beyland/tincan-protocol/paths";
import { agentConnections } from "./agent-connections.ts";
import { commandHelp, parseCommandInput } from "./args.ts";
import {
  DRAFT_NOTES,
  formatters,
  lookups,
  oneLine,
  person,
  PLAIN,
  type FormatContext,
} from "./format.ts";
import {
  findCommand,
  installMcpConfig,
  removeMcpConfig,
  MCP_CLIENT_NAMES,
  MCP_CLIENTS,
  mcpConfigBody,
  mcpConfigFile,
  mcpConfigSnippet,
  resolveMcpClient,
  type Exec,
  type McpClient,
  type StdioLaunch,
  spawnExec,
} from "./mcp-config.ts";
import { Directory } from "./names.ts";
import {
  BLUETOOTH_RESTART_WARNING,
  managedService,
  offlineDoctor,
  runService,
  SERVICE_HELP,
  setupInvocation,
  type SystemHooks,
} from "./system.ts";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Resolves when the user interrupts a long-running command (`daemon`, `watch`). */
  interrupted?: () => Promise<void>;
  /** Stand-ins for the system probe and systemctl (tests). */
  system?: SystemHooks;
  /** The MCP server's transport for `tincan mcp` (default: the process's stdin and stdout). */
  stdin?: NodeJS.ReadableStream;
  stdoutStream?: NodeJS.WritableStream;
  /**
   * Asks before sending, deleting or changing settings. Without it the CLI prompts on a terminal;
   * with nobody to ask, commands that need confirming fail unless `--yes` is passed (and policy
   * commands always fail: see {@link isPolicyCommand}).
   */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Whether a person is at a terminal to answer (default: stdin and stderr are TTYs, or `confirm`
   * is given). Tests set it.
   */
  interactive?: boolean;
  /** Runs client CLIs for `tincan connect` (e.g. `claude mcp add`); tests stub it. */
  exec?: Exec;
  /**
   * Shows a line that replaces the one before it on the terminal (the send countdown). Default:
   * rewrites the current line of stderr.
   */
  status?: (line: string) => void;
  /** Waits `ms` (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  stderr: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  cwd: process.cwd(),
  env: process.env,
};

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Path to the executable entry, used when generating MCP client configs. */
export const BIN_PATH = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./bin.ts" : "./bin.mjs", import.meta.url),
);

const CLIENT: ClientInfo = { kind: "cli", name: "tincan" };

/**
 * Who the CLI connects as: itself, or, in an AI agent's shell, that agent, so the agent policy
 * applies to everything it runs (there's deliberately no way to override this from the
 * environment, which the agent controls).
 */
function clientFor(io: CliIO): ClientInfo {
  const marker = agentEnvironmentMarker(io.env);
  return marker ? { kind: "mcp", name: `${agentEnvironmentName(marker)} (CLI)` } : CLIENT;
}

/** Says, once, that the CLI is running as an agent. */
function noteAgentClient(io: CliIO, client: ClientInfo): void {
  if (client.kind !== "mcp") return;
  io.stderr(
    `tincan: running as ${client.name.replace(/ \(CLI\)$/, "")} (agent shell detected); the AI agent settings in Tincan apply. To use your full CLI, run tincan from a normal terminal.`,
  );
}

/** Short forms for the commands people type most. */
const SHORTCUTS: Record<string, string[]> = {
  send: ["message", "send"],
  threads: ["thread", "list"],
  drafts: ["draft", "list"],
};

/** Other names for commands: `tincan draft show <id>` is `draft.get`. */
const ALIASES: Record<string, string> = {
  "draft.show": "draft.get",
  "thread.show": "thread.get",
  "contact.show": "contact.get",
};

/** The CLI lists every command the protocol defines, so help works without a daemon. */
const descriptors = new Map(
  describeContracts({ includeInternal: true }).map((d) => [d.name, d] as const),
);

interface Globals {
  socket?: string;
  json: boolean;
  /** Also print thread keys, handles and Bluetooth addresses. */
  verbose: boolean;
  help: boolean;
  version: boolean;
  yes: boolean;
  rest: string[];
}

function extractGlobals(argv: string[]): Globals {
  const globals: Globals = {
    json: false,
    verbose: false,
    help: false,
    version: false,
    yes: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      globals.rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--json") globals.json = true;
    else if (arg === "-h" || arg === "--help") globals.help = true;
    else if (arg === "--verbose") globals.verbose = true;
    else if (arg === "-v" || arg === "--version") globals.version = true;
    else if (arg === "-y" || arg === "--yes") globals.yes = true;
    else if (arg === "--socket") globals.socket = argv[++i];
    else if (arg.startsWith("--socket=")) globals.socket = arg.slice("--socket=".length);
    else globals.rest.push(arg);
  }
  return globals;
}

const camel = (token: string) => token.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Accepts `threads.list`, `threads list` and `messages mark-read`. */
function resolveCommand(
  tokens: string[],
): { descriptor: ContractDescriptor; args: string[] } | undefined {
  const words = tokens.map(camel);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const name = words.slice(0, n).join(".");
    const descriptor = descriptors.get(ALIASES[name] ?? name);
    if (descriptor) return { descriptor, args: tokens.slice(n) };
  }
  return undefined;
}

function resolvePaths(globals: Globals, io: CliIO): RuntimePaths {
  const env = globals.socket
    ? { ...io.env, TINCAN_SOCKET: path.resolve(io.cwd, globals.socket) }
    : io.env;
  return runtimePaths(env);
}

function mainHelp(): string {
  // `tincan service` runs here rather than in the daemon, so the daemon's `service.*` aren't reachable.
  const reachable = [...descriptors.values()].filter((d) => !d.name.startsWith("service."));
  const commandLines = reachable.map((d) => {
    const usage = `${d.name}${d.positional.length ? ` ${d.positional.map((p) => `<${p}>`).join(" ")}` : ""}`;
    return `  ${usage.padEnd(36)} ${d.title}`;
  });
  return `Tincan ${VERSION} — your iPhone's messages on Linux

Usage: tincan <command> [options]

Phone:
  pair [address]                       Pair an iPhone with this computer
  setup [install|uninstall|status]     Configure BlueZ experimental mode & hands-free device class

Daemon:
  daemon                               Run the daemon in the foreground
  watch                                Print daemon events as they happen
  service <install|uninstall|status>   Run the daemon in the background (systemd user service)
  schema                               Print the whole protocol as JSON Schema

AI agents:
  connect [agent] [--print]            Add Tincan to an agent, or list them
  disconnect <agent>                   Remove Tincan from an agent
  mcp                                  Serve Tincan to AI agents over MCP (stdio)

Shortcuts:
  send <to> <text>                     message.send
  threads                              thread.list (thread show <thread>: thread.get)
  drafts                               draft.list (draft show <id>: draft.get)

Commands (also available to the desktop app and agents over MCP):
${commandLines.join("\n")}

Global options:
  --socket <path>         Daemon socket (default: $TINCAN_SOCKET or $XDG_RUNTIME_DIR/tincan/tincan.sock)
  --json                  Print machine-readable JSON
  --verbose               Also print thread keys, handles and Bluetooth addresses, to copy into
                          other commands (output names people and conversations otherwise)
  -y, --yes               Don't ask before sending, deleting or other changes (never skips
                          confirming agent drafts or agent settings)
  -h, --help              Show help (also: tincan <command> --help)
  -v, --version           Show version

Commands can be dotted, spaced or kebab-cased: \`tincan settings.get\`, \`tincan settings get\`.
Wherever a command takes a conversation, a contact or group name works as well as a key.`;
}

function printResult(
  io: CliIO,
  globals: Globals,
  name: string,
  value: unknown,
  context: FormatContext = { ...PLAIN, verbose: globals.verbose },
): void {
  const format = formatters[name] as
    | ((value: unknown, context: FormatContext) => string)
    | undefined;
  io.stdout(globals.json || !format ? JSON.stringify(value, null, 2) : format(value, context));
}

/**
 * Prints a command's result. Human output names people and conversations, looking up what the
 * result doesn't carry once, in a batch; `--json` prints the result as it came.
 */
async function printCommandResult(
  io: CliIO,
  globals: Globals,
  name: string,
  value: unknown,
  input: Record<string, unknown>,
  directory: Directory,
): Promise<void> {
  if (globals.json || !formatters[name]) return printResult(io, globals, name, value);
  const lookup = (lookups[name] as ((v: unknown, i: typeof input) => object) | undefined)?.(
    value,
    input,
  );
  const context = await directory.context(lookup ?? {}, { verbose: globals.verbose, input });
  printResult(io, globals, name, value, context);
}

function interrupted(io: CliIO): Promise<void> {
  if (io.interrupted) return io.interrupted();
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const globals = extractGlobals(argv);
  const [name, ...rest] = globals.rest;
  try {
    if (globals.version) {
      io.stdout(VERSION);
      return 0;
    }
    if (!name || name === "help") {
      const target = rest.length ? resolveCommand(rest) : undefined;
      io.stdout(target ? helpFor(target.descriptor) : mainHelp());
      return 0;
    }

    switch (name) {
      case "daemon":
        if (globals.help) {
          io.stdout(
            "tincan daemon [--socket <path>]\n\nRun the Tincan daemon in the foreground. Stop it with Ctrl+C.",
          );
          return 0;
        }
        return await runDaemonCommand(globals, io);
      case "watch":
        if (globals.help) {
          io.stdout("tincan watch [--json]\n\nPrint daemon events until interrupted.");
          return 0;
        }
        return await runWatch(globals, io);
      case "schema":
        io.stdout(JSON.stringify(protocolSchema(), null, 2));
        return 0;
      case "service":
        if (globals.help) {
          io.stdout(SERVICE_HELP);
          return 0;
        }
        if (rest.length > 1)
          throw new TincanError("INVALID_INPUT", `Unexpected: ${rest.slice(1).join(" ")}`);
        printResult(io, globals, "service", await runService(rest[0], io.env, io.system));
        return 0;
      case "doctor":
        if (globals.help) {
          io.stdout(DOCTOR_HELP);
          return 0;
        }
        return await runDoctor(rest, globals, io);
      case "setup":
        if (globals.help) {
          io.stdout(SETUP_HELP);
          return 0;
        }
        if (rest.length > 1)
          throw new TincanError("INVALID_INPUT", `Unexpected: ${rest.slice(1).join(" ")}`);
        return runSetup(rest[0] ?? "install", globals, io);
      case "mcp":
        if (globals.help) {
          io.stdout(MCP_HELP);
          return 0;
        }
        if (rest.length) throw new TincanError("INVALID_INPUT", `Unexpected: ${rest.join(" ")}`);
        return await runMcp(globals, io);
      case "connect":
      case "disconnect":
        if (globals.help) {
          io.stdout(name === "connect" ? connectHelp() : disconnectHelp());
          return 0;
        }
        return await runConnect(name, rest, globals, io);
      case "pair":
        if (globals.help) {
          io.stdout(PAIR_HELP);
          return 0;
        }
        if (rest.length > 1)
          throw new TincanError("INVALID_INPUT", `Unexpected: ${rest.slice(1).join(" ")}`);
        return await runPair(rest[0], globals, io);
    }

    const shortcut = SHORTCUTS[name];
    const resolved = resolveCommand(shortcut ? [...shortcut, ...rest] : globals.rest);
    if (!resolved) {
      io.stderr(
        `Unknown command: ${globals.rest.join(" ")}\nRun \`tincan help\` to see available commands.`,
      );
      return 1;
    }
    if (globals.help) {
      io.stdout(helpFor(resolved.descriptor));
      return 0;
    }
    const { access, args } =
      resolved.descriptor.name === "settings.set"
        ? takeAccess(resolved.args)
        : { access: undefined, args: resolved.args };
    const input = await parseCommandInput(resolved.descriptor, args, io.cwd);
    // What `--access` changes depends on the current settings, read once connected; until then
    // this marks the command as changing agent settings.
    if (access) input.agents = { access, ...(input.agents as object | undefined) };
    const policy = isPolicyCommand(resolved.descriptor, input);
    if (policy) assertPersonAtTerminal(`tincan ${resolved.descriptor.name}`, io);
    const question = policy ? undefined : confirmationFor(resolved.descriptor, input);
    if (question && !globals.yes && !(await confirm(io, question))) {
      io.stderr("Cancelled");
      return 1;
    }
    const as = clientFor(io);
    noteAgentClient(io, as);
    const client = await TincanClient.connect({
      socketPath: resolvePaths(globals, io).socket,
      client: as,
      // draft.get may wait up to a minute for a change.
      ...(resolved.descriptor.name === "draft.get" ? { timeoutMs: 75_000 } : {}),
    });
    // Names for this run's output, each looked up at most once.
    const directory = new Directory(client);
    try {
      if (access) {
        // `--access` picks a level as the app does (`accessPatch`); other --agents-* flags win.
        const current = (await client.call("settings.get", {})) as Settings;
        const explicit = { ...(input.agents as Record<string, unknown>) };
        delete explicit.access;
        input.agents = { ...accessPatch(access, current.agents), ...explicit };
      }
      // Policy commands always ask, whatever --yes says.
      if (
        policy &&
        !(await confirm(
          io,
          await policyQuestion(client, resolved.descriptor, input, directory, globals.verbose),
        ))
      ) {
        io.stderr("Cancelled");
        return 1;
      }
      // The CLI is an interactive client, so it sees internal commands too (not as an agent).
      const params =
        resolved.descriptor.name === "commands" &&
        input.includeInternal === undefined &&
        as.kind !== "mcp"
          ? { ...input, includeInternal: true }
          : input;
      const result = await client.call(resolved.descriptor.name, params);
      if (
        resolved.descriptor.name === "message.send" &&
        !globals.json &&
        as.kind !== "mcp" &&
        isInteractive(io) &&
        (result as SendResult).outcome === "scheduled"
      ) {
        return await countdown(io, client, result as SendResult, String(input.to));
      }
      await printCommandResult(io, globals, resolved.descriptor.name, result, input, directory);
      return 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    if (globals.json) {
      const payload = isTincanError(error)
        ? { ok: false, error: error.toWire() }
        : { ok: false, error: { code: "INTERNAL", message: (error as Error).message } };
      io.stderr(JSON.stringify(payload, null, 2));
    } else {
      io.stderr(`error: ${(error as Error).message}`);
    }
    return 1;
  }
}

/**
 * Commands that change what AI agents may do or act on what they asked: settings for agents,
 * sending or discarding their drafts, adding Tincan to (or removing it from) agents, and
 * showing someone hidden from agents to them again (hiding is an ordinary change). They run only when the user answers at a
 * terminal: never with `--yes`, from a script, or from an AI agent's shell.
 */
export function isPolicyCommand(
  descriptor: Pick<ContractDescriptor, "name">,
  input: Record<string, unknown>,
): boolean {
  switch (descriptor.name) {
    case "draft.send":
    case "draft.discard":
    case "agents.connect":
    case "agents.disconnect":
      return true;
    case "settings.set":
      return input.agents !== undefined;
    case "agents.show":
      return true;
    default:
      return false;
  }
}

/** Refuses a policy command from an AI agent's shell or without a person to answer. */
function assertPersonAtTerminal(command: string, io: CliIO): void {
  const marker = agentEnvironmentMarker(io.env);
  if (marker) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `\`${command}\` changes what AI agents may do, so it doesn't run from an AI agent's shell ($${marker} is set). Run it yourself in a terminal, or use the Tincan app.`,
    );
  }
  if (!isInteractive(io)) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `\`${command}\` needs you to confirm it at a terminal (--yes doesn't skip this). Run it in a terminal, or use the Tincan app.`,
    );
  }
}

/**
 * What to ask before a policy command. For an agent draft it's the draft itself: who wrote it, who
 * it goes to (and why it needed you), and the text; sending pins the revision shown, so an edit
 * made meanwhile isn't sent unseen.
 */
async function policyQuestion(
  client: TincanClient,
  descriptor: ContractDescriptor,
  input: Record<string, unknown>,
  directory: Directory,
  verbose: boolean,
): Promise<string> {
  switch (descriptor.name) {
    case "draft.send":
    case "draft.discard": {
      const verb = descriptor.name === "draft.send" ? "Send" : "Discard";
      const draft = (await client
        .call("draft.get", { id: input.id })
        .catch(() => null)) as AgentDraft | null;
      if (!draft) return `${verb} draft ${String(input.id)}?`;
      if (descriptor.name === "draft.send" && input.revision === undefined) {
        input.revision = draft.revision;
      }
      const to = person(draft.to, { ...PLAIN, verbose, people: await directory.people() });
      const note = draft.note ? ` (${DRAFT_NOTES[draft.note]})` : "";
      const text = typeof input.text === "string" ? input.text : (draft.text ?? draft.body);
      const delay =
        descriptor.name === "draft.send"
          ? await client
              .call("settings.get", {})
              .then((s) => (s as Settings).agents.sendDelaySeconds)
              .catch(() => 0)
          : 0;
      const when = delay > 0 ? ` It waits ${delay}s before going to your phone.` : "";
      return `${verb} ${oneLine(draft.agentName)}'s draft to ${to}${note}? ${oneLine(text)}${when}`;
    }
    case "settings.set": {
      const agents = (input.agents ?? {}) as Record<string, unknown>;
      const current = (await client
        .call("settings.get", {})
        .then((s) => (s as Settings).agents)
        .catch(() => null)) as Settings["agents"] | null;
      const toFull = agents.access === "full" && current?.access !== "full";
      const warnings = [
        agents.read === "all" &&
          "Agents will read every conversation, including texts from strangers.",
        agents.send === "always" && "Agents will send messages to anyone without asking you.",
        agents.sendDelaySeconds === 0 &&
          "With no agent send delay, an agent's message goes to your phone at once and you can't cancel it.",
        toFull &&
          `With full access there's no send limit and nothing asks first, not even for conversations you hid. ${INJECTION_WARNING}`,
      ].filter(Boolean);
      return `Change what AI agents may do (${JSON.stringify(input.agents)})?${warnings.map((w) => ` ${w}`).join("")}`;
    }
    case "agents.connect":
      return `Give ${String(input.client)} access to your messages through Tincan's MCP server?`;
    case "agents.disconnect":
      return `Remove Tincan from ${String(input.client)}?`;
    case "agents.show": {
      const who = await showLabel(client, input);
      return `Show ${who} to AI agents again? They'll be able to read the conversations again, as your agent settings allow.`;
    }
    default:
      return `${descriptor.title}?`;
  }
}

/** Who `agents.show` names, for its question: a hidden person's label when the input is their id. */
async function showLabel(client: TincanClient, input: Record<string, unknown>): Promise<string> {
  const given = input.personId ?? input.target ?? input.groupKey;
  const raw = typeof given === "string" ? given : "";
  const hidden = (await client
    .call("agents.hidden", {})
    .catch(() => null)) as OutputOf<"agents.hidden"> | null;
  const person = hidden?.people.find((p) => p.id === raw);
  const group = hidden?.groups.find((g) => g.threadKey === raw);
  return oneLine(person?.label ?? group?.title ?? raw);
}

/** The warning about prompt injection, wherever the CLI gives agents more room. */
export const INJECTION_WARNING =
  "Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it.";

/**
 * Counts down a send held for its delay on one line, cancelling it on Ctrl+C. Returns the exit
 * code: 0 once it has gone, 1 when cancelled.
 */
async function countdown(
  io: CliIO,
  client: TincanClient,
  result: SendResult,
  to: string,
): Promise<number> {
  const message = result.message!;
  const sendAt = result.sendAt ?? message.sendAt ?? Date.now();
  const status =
    io.status ??
    ((line: string) => {
      process.stderr.write(`\r\u001b[2K${line}`);
    });
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stop = interrupted(io).then(() => "stop" as const);
  const label = oneLine(to);
  for (;;) {
    const remaining = sendAt - Date.now();
    if (remaining <= 0) break;
    status(`Sending to ${label} in ${Math.ceil(remaining / 1000)}s… Ctrl+C to cancel`);
    const next = await Promise.race([
      sleep(Math.min(1000, remaining)).then(() => "tick" as const),
      stop,
    ]);
    if (next === "stop") {
      status("");
      try {
        await client.call("message.cancel", { id: message.id });
        io.stderr("Cancelled: it never reached your phone");
        return 1;
      } catch (error) {
        // Too late: it's already going.
        io.stderr(`Couldn't cancel: ${(error as Error).message}`);
        return 1;
      }
    }
  }
  status("");
  io.stdout(`Sent to your phone (${message.id})`);
  return 0;
}

/**
 * The question to ask before running a command that sends, deletes or changes something only the
 * user may (an internal command), if it does.
 */
function confirmationFor(
  descriptor: ContractDescriptor,
  input: Record<string, unknown>,
): string | undefined {
  switch (descriptor.name) {
    case "message.send":
      return `Send this message to ${String(input.to)}?`;
    case "message.retry":
      return "Send this message again?";
    case "message.cancel":
    case "message.sendNow":
    case "draft.update":
    case "draft.restore":
      // Undoing a send, or hurrying one already confirmed, is quicker than asking.
      return undefined;
    case "group.delete":
      return `Forget the group ${String(input.threadKey)}?`;
    case "agents.hide":
      return `Hide ${String(input.target ?? input.handle ?? input.groupKey ?? input.contactId)} from AI agents?`;
  }
  if (descriptor.destructive || descriptor.approval === "agent") return `${descriptor.title}?`;
  if (descriptor.internal && descriptor.kind === "mutation") return `${descriptor.title}?`;
  return undefined;
}

function isInteractive(io: CliIO): boolean {
  if (io.interactive !== undefined) return io.interactive;
  if (io.confirm) return true;
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Asks on the terminal. With nobody there to ask (a script or pipe) it fails: pass --yes. */
async function confirm(io: CliIO, question: string): Promise<boolean> {
  if (!isInteractive(io)) {
    throw new TincanError(
      "INVALID_INPUT",
      `${question} Nobody is at a terminal to confirm it: pass --yes to go ahead.`,
    );
  }
  if (io.confirm) return io.confirm(question);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

/** `--access <level>` names, as the help shows them and as the protocol spells them. */
const ACCESS_LEVELS: Record<string, AgentAccess> = {
  off: "off",
  "read-only": "readOnly",
  readOnly: "readOnly",
  assistant: "assistant",
  full: "full",
};

/**
 * Takes `--access <level>` (or `--access=<level>`) out of `settings set`'s arguments. `--preset`,
 * from before access levels, is a hidden alias.
 */
function takeAccess(args: string[]): { access?: AgentAccess; args: string[] } {
  const rest: string[] = [];
  let name: string | undefined;
  let flag = "--access";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const bare = arg === "--access" || arg === "--preset";
    const joined = /^--(access|preset)=/.exec(arg);
    if (bare) {
      flag = arg;
      name = args[++i];
      if (name === undefined) throw new TincanError("INVALID_INPUT", `${flag} needs a level`);
    } else if (joined) {
      flag = `--${joined[1]}`;
      name = arg.slice(joined[0].length);
    } else rest.push(arg);
  }
  if (name === undefined) return { args: rest };
  const access = ACCESS_LEVELS[name];
  if (!access) {
    throw new TincanError(
      "INVALID_INPUT",
      `Unknown access level ${JSON.stringify(name)} for ${flag}: use off, read-only, assistant or full`,
    );
  }
  return { access, args: rest };
}

const SETTINGS_SET_HELP = `
AI agents:
  --access <off|read-only|assistant|full>
      How much agents may do; it caps every other agent setting. Picking a level also sets a
      starting point for what it offers, which other --agents-* options change from there:
      off: only status and settings. read-only: read (your contacts and people you've texted,
      unless --agents-read says otherwise), nothing else. assistant: reading, drafts, inbox
      actions and sends that become drafts for you (by default), within the send limit, with
      numbers and codes always hidden. full: every conversation, sending directly and with no
      limit, drafts and inbox actions, and the privacy options as you set them. A level never
      changes --agents-handles, --agents-hide-codes or the send delays.
  --agents-read <off|contacts|known|all>
      Which conversations agents may read: none (assistant and full only); ones where everyone
      is a saved contact; those plus ones you've sent a message in yourself; or every one you
      haven't hidden.
  --agents-send <approve|replied|always>
      What an agent's send does: every message becomes an agent draft for you to send, edit or
      discard; it goes directly to people you've texted yourself (anyone else gets a draft); or
      it goes directly (with assistant access, hidden conversations and short codes still get a
      draft). Read only never sends. Agents may save drafts whenever they may send.
  --agents-send-limit <1-60|none>
      Messages agents may send per 10 minutes with assistant access (default 10); none for no
      limit. Full access has no limit.
  --agents-send-delay-seconds <0-300>
      How long agents' messages, and agent drafts you send, wait on this computer before going
      to your phone, so you can cancel them (default 10). Once a message reaches the phone it
      can't be unsent.
  --[no-]agents-manage          Whether agents may mark read, mute and pin (default no)
  --agents-handles <hidden|visible>, --[no-]agents-hide-codes
      Privacy protections: whether phone numbers and emails are masked and verification codes
      and short codes hidden. They only turn off with full access.

Changing what agents may do asks you at a terminal first, even with --yes.

Your messages:
  --send-delay-seconds <0-300>
      How long your own messages wait before going to your phone (default 0: off). While one
      waits, \`tincan send\` counts down and Ctrl+C cancels it.`;

/** Commands whose output names conversations or people where it once showed their keys. */
const NAMES_OUTPUT = new Set([
  "thread.list",
  "thread.get",
  "message.list",
  "message.search",
  "message.draft.list",
  "draft.list",
  "draft.get",
  "group.list",
  "contact.list",
  "contact.search",
  "contact.get",
  "status",
  "device.history",
]);

const NAMES_HELP = `
Output names people and conversations by contact or group name (numbers without a contact are
formatted, like +1 (555) 010-0123). Add --verbose to also print each thread key, handle or
Bluetooth address, to copy into other commands; --json prints them all as they are. Commands that
take a conversation accept a contact or group name as well as a key.`;

/** A command's help, with more for the ones whose options or output need explaining. */
function helpFor(descriptor: ContractDescriptor): string {
  const help = commandHelp(descriptor);
  if (descriptor.name === "settings.set") return `${help}\n${SETTINGS_SET_HELP}`;
  return NAMES_OUTPUT.has(descriptor.name) ? `${help}\n${NAMES_HELP}` : help;
}

const MCP_HELP = `tincan mcp [--socket <path>]

Serve Tincan's commands to an AI agent over the Model Context Protocol on stdin and stdout.
MCP clients start this themselves; see \`tincan connect\` to set one up.

The server connects to the running daemon (start it with \`tincan daemon\` or \`tincan service install\`).
What agents may do is set in Tincan's settings (\`tincan settings get\`, and \`tincan settings set --help\`):
\`agents.access\` (\`off\` by default, \`readOnly\`, \`assistant\` or \`full\`) caps everything else,
\`agents.read\` decides which conversations they may read (\`off\`, \`contacts\`, \`known\` or \`all\`),
\`agents.send\` whether their sends go or become agent drafts for you to send, edit or discard in
the Tincan app or with \`tincan drafts\` (\`approve\`, \`replied\` or \`always\`), \`agents.sendDelaySeconds\`
how long their messages wait so you can cancel them, and \`agents.manage\` whether they may mark read,
mute and pin.`;

function connectHelp(): string {
  return `tincan connect [<agent>] [options]

Add Tincan's MCP server to an AI agent's user-level config, so the agent starts \`tincan mcp\`.
Without an agent, list the agents and whether each is connected.

Agents:
${MCP_CLIENTS.map((c) => `  ${c.padEnd(14)} ${installTarget(c)}`).join("\n")}

Options:
  --print         Print the config to add by hand, and change nothing
  --name <name>   MCP server name (default: tincan)
  --force         Replace a different server with the same name
  -h, --help      Show this help

JSON configs are merged: other servers, settings and comments are kept. Connecting asks you at a
terminal first (--yes doesn't skip it) and doesn't run from an AI agent's shell; --print runs
anywhere. \`tincan disconnect <agent>\` removes Tincan again.`;
}

function disconnectHelp(): string {
  return `tincan disconnect <agent> [options]

Remove Tincan's MCP server from an AI agent's user-level config.

Agents: ${MCP_CLIENTS.join(", ")}

Options:
  --name <name>   MCP server name (default: tincan)
  -h, --help      Show this help

It asks you at a terminal first (--yes doesn't skip it) and doesn't run from an AI agent's shell.`;
}

function installTarget(client: McpClient, env: NodeJS.ProcessEnv = { HOME: "~" }): string {
  if (client === "claude") return "runs `claude mcp add --scope user`";
  if (client === "codex") return "runs `codex mcp add`";
  return mcpConfigFile(client, env);
}

/** How MCP clients start `tincan mcp`: works under Node, packaged `.deb` (`ELECTRON_RUN_AS_NODE=1`) and AppImages. */
function mcpLaunch(globals: Globals, io: CliIO): StdioLaunch {
  const extra = globals.socket ? ["--socket", path.resolve(io.cwd, globals.socket)] : [];
  const isElectron = Boolean(process.versions.electron || io.env.ELECTRON_RUN_AS_NODE);
  if (isElectron) {
    if (io.env.APPIMAGE) {
      return {
        command: "/usr/bin/env",
        args: [
          "ELECTRON_RUN_AS_NODE=1",
          realpathOr(io.env.APPIMAGE),
          "-e",
          'const bin = process.env.APPDIR + "/resources/daemon/dist/bin.mjs"; process.argv.splice(1, 0, bin); await import(bin);',
          "--",
          "mcp",
          ...extra,
        ],
      };
    }
    const onPath = findCommand("tincan", io.env);
    if (onPath && !realpathOr(onPath).includes("/tmp/.mount_")) {
      return { command: realpathOr(onPath), args: ["mcp", ...extra] };
    }
    return {
      command: "/usr/bin/env",
      args: [
        "ELECTRON_RUN_AS_NODE=1",
        realpathOr(process.execPath),
        realpathOr(BIN_PATH),
        "mcp",
        ...extra,
      ],
    };
  }
  return { command: realpathOr(process.execPath), args: [realpathOr(BIN_PATH), "mcp", ...extra] };
}

/** How a terminal runs this CLI: plain `tincan` when that's this one, else this Node and script. */
function terminalCli(env: NodeJS.ProcessEnv): string[] {
  const onPath = findCommand("tincan", env);
  if (onPath && realpathOr(onPath) === realpathOr(BIN_PATH)) return ["tincan"];
  const isElectron = Boolean(process.versions.electron || env.ELECTRON_RUN_AS_NODE);
  if (isElectron && onPath) return ["tincan"];
  if (isElectron) {
    return ["env", "ELECTRON_RUN_AS_NODE=1", realpathOr(process.execPath), realpathOr(BIN_PATH)];
  }
  return [realpathOr(process.execPath), realpathOr(BIN_PATH)];
}

/** How agents reach this daemon: `mcpLaunch`, plus the socket when it isn't the default one. */
function daemonMcpLaunch(globals: Globals, io: CliIO): StdioLaunch {
  const launch = mcpLaunch(globals, io);
  if (!globals.socket && io.env.TINCAN_SOCKET) {
    launch.args.push("--socket", path.resolve(io.cwd, io.env.TINCAN_SOCKET));
  }
  return launch;
}

/** `--socket <path>` when this daemon's socket isn't the default, for CLI runs that act for it. */
function socketArgs(globals: Globals, io: CliIO): string[] {
  const socket = globals.socket ?? io.env.TINCAN_SOCKET;
  return socket ? ["--socket", path.resolve(io.cwd, socket)] : [];
}

/** Whether this process is Tincan's systemd user service, whose sandbox keeps $HOME read-only. */
function runningAsService(): boolean {
  try {
    return readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .some((line) => line.endsWith(`/${SERVICE_NAME}`));
  } catch {
    return false;
  }
}

/**
 * Runs this CLI as a one-off unit of the user's systemd, outside the service's sandbox, so it can
 * write the agents' configs (`agents.connect`), and waits for it.
 */
function runOutsideSandbox(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const isElectron = Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE);
  const envFlags = [
    `--setenv=${FROM_SERVICE_ENV}=1`,
    ...(isElectron ? ["--setenv=ELECTRON_RUN_AS_NODE=1"] : []),
  ];
  const command =
    isElectron && process.env.APPIMAGE
      ? [
          realpathOr(process.env.APPIMAGE),
          "-e",
          'const bin = process.env.APPDIR + "/resources/daemon/dist/bin.mjs"; process.argv.splice(1, 0, bin); await import(bin);',
          "--",
          ...args,
        ]
      : [realpathOr(process.execPath), realpathOr(BIN_PATH), ...args];
  return new Promise((resolve) => {
    execFile(
      "systemd-run",
      ["--user", "--wait", "--pipe", "--collect", "--quiet", ...envFlags, "--", ...command],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({
          status,
          stdout,
          stderr: stderr || (error && status === null ? error.message : ""),
        });
      },
    );
  });
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** Nothing but MCP messages may reach stdout here; diagnostics go to stderr. */
async function runMcp(globals: Globals, io: CliIO): Promise<number> {
  const { runStdioServer } = await import("@beyland/tincan-mcp");
  await runStdioServer({
    socketPath: resolvePaths(globals, io).socket,
    version: VERSION,
    ...(io.stdin ? { stdin: io.stdin } : {}),
    ...(io.stdoutStream ? { stdout: io.stdoutStream } : {}),
  });
  return 0;
}

/**
 * Set by the background service when it runs `tincan connect` or `disconnect` outside its sandbox
 * for the desktop app (`agents.connect`), which the user has already confirmed there. It isn't a
 * security boundary (nothing here is: see AGENTS.md); a detected agent shell is still refused.
 */
const FROM_SERVICE_ENV = "TINCAN_AGENT_APPS_FROM_SERVICE";

/** `tincan connect [agent] [--print]` and `tincan disconnect <agent>`. */
async function runConnect(
  command: "connect" | "disconnect",
  args: string[],
  globals: Globals,
  io: CliIO,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: "string" },
      print: { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  const { print, force } = values;
  if (command === "disconnect" && (print || force))
    throw new TincanError("INVALID_INPUT", `Unknown option ${print ? "--print" : "--force"}`);
  if (positionals.length > 1)
    throw new TincanError("INVALID_INPUT", `\`tincan ${command}\` takes one agent name`);
  const app = positionals[0];
  if (app === undefined) {
    if (command === "connect" && !print && !force && values.name === undefined)
      return await listAgentApps(globals, io);
    throw new TincanError(
      "INVALID_INPUT",
      `Name an agent: \`tincan ${command} <agent>\`, one of ${MCP_CLIENTS.join(", ")}`,
    );
  }
  const client = resolveMcpClient(app);
  if (!client)
    throw new TincanError(
      "INVALID_INPUT",
      `Unknown agent ${app}. Choose one of: ${MCP_CLIENTS.join(", ")}`,
    );
  if (print && force) throw new TincanError("INVALID_INPUT", "--force doesn't apply to --print");
  const launch = mcpLaunch(globals, io);
  if (print) {
    io.stdout(
      globals.json
        ? JSON.stringify(
            {
              client,
              file: mcpConfigFile(client, io.env),
              snippet: mcpConfigBody(client, launch, values.name),
              launch,
            },
            null,
            2,
          )
        : mcpConfigSnippet(client, launch, values.name),
    );
    return 0;
  }

  // Adding Tincan to an agent, or removing it, is a policy command.
  const file = mcpConfigFile(client, io.env);
  const fromService = io.env[FROM_SERVICE_ENV] === "1";
  if (fromService) {
    // Confirmed in the app; still never from an agent's shell.
    if (agentEnvironmentMarker(io.env)) assertPersonAtTerminal(`tincan ${command}`, io);
  } else {
    assertPersonAtTerminal(`tincan ${command}`, io);
    const question =
      command === "connect"
        ? `Add Tincan to ${MCP_CLIENT_NAMES[client]}? It can then reach your messages as your agent settings allow.`
        : `Remove Tincan from ${MCP_CLIENT_NAMES[client]} (${file})?`;
    if (!(await confirm(io, question))) {
      io.stderr("Cancelled");
      return 1;
    }
  }
  const exec = io.exec ?? spawnExec;
  if (command === "disconnect") {
    const status = await removeMcpConfig(client, { env: io.env, name: values.name, exec });
    io.stdout(
      globals.json
        ? JSON.stringify({ client, file, status }, null, 2)
        : status === "removed"
          ? `Removed Tincan's MCP server from ${file}`
          : `Tincan's MCP server isn't in ${file}`,
    );
    return 0;
  }
  const result = await installMcpConfig(client, launch, {
    env: io.env,
    name: values.name,
    force,
    exec,
  });
  const server = `MCP server ${JSON.stringify(result.name)}`;
  const via = result.via ? ` (via ${result.via})` : "";
  const human =
    result.status === "created"
      ? `Added ${server} to ${result.file}${via}`
      : result.status === "updated"
        ? `Replaced ${server} in ${result.file}${via}`
        : `${server} is already configured in ${result.file}`;
  io.stdout(globals.json ? JSON.stringify({ ...result, launch }, null, 2) : human);
  return 0;
}

/**
 * `tincan connect` with no agent: each agent and whether Tincan is in it. Asks the daemon, as the
 * desktop app does, so "current" means "starts this daemon"; without one, checks the configs here.
 */
async function listAgentApps(globals: Globals, io: CliIO): Promise<number> {
  let clients: AgentConnection[] | undefined;
  try {
    const daemon = await TincanClient.connect({
      socketPath: resolvePaths(globals, io).socket,
      client: clientFor(io),
      connectTimeoutMs: 2_000,
      timeoutMs: 10_000,
    });
    try {
      ({ clients } = (await daemon.call("agents.connections", {})) as {
        clients: AgentConnection[];
      });
    } finally {
      await daemon.close();
    }
  } catch {
    // No daemon (or one that can't set up agents): look locally.
  }
  clients ??= await agentConnections(mcpLaunch(globals, io), {
    env: io.env,
    exec: io.exec ?? spawnExec,
    cli: terminalCli(io.env),
  }).list();
  if (globals.json) {
    io.stdout(JSON.stringify({ clients }, null, 2));
    return 0;
  }
  const state = (app: AgentConnection) =>
    !app.configured
      ? "not connected"
      : app.current
        ? "connected"
        : `connected to another Tincan (\`tincan connect ${app.client} --force\` updates it)`;
  io.stdout(
    [
      "Agents:",
      ...clients.map((app) => `  ${app.client.padEnd(14)} ${app.name.padEnd(14)} ${state(app)}`),
      "",
      "Run `tincan connect <agent>` to add Tincan to one, or `tincan connect <agent> --print` to see its config.",
    ].join("\n"),
  );
  return 0;
}

const DOCTOR_HELP = `tincan doctor [--report] [--json]

Check Bluetooth, the paired iPhone and Tincan's own setup. Exits 1 when any check fails.

Options:
  --report    Print a redacted diagnostic report suitable for bug reports (masks MAC addresses and device names)`;

const SETUP_HELP = `tincan setup [install|uninstall|status]

Configure BlueZ for Tincan: enables Experimental = true in /etc/bluetooth/main.conf and installs
tincan-btclass@.service + udev rule so Bluetooth adapters keep the hands-free Class of Device
(0x0408) across restarts. Uses sudo for install/uninstall.`;

function locateSetupScript(): string {
  const candidates = [
    path.resolve(path.dirname(BIN_PATH), "system-setup/tincan-system-setup.sh"),
    path.resolve(path.dirname(BIN_PATH), "../../../packaging/system-setup/tincan-system-setup.sh"),
    path.resolve(path.dirname(BIN_PATH), "../../packaging/system-setup/tincan-system-setup.sh"),
    path.resolve(path.dirname(BIN_PATH), "../../system-setup/tincan-system-setup.sh"),
    path.resolve(path.dirname(BIN_PATH), "../system-setup/tincan-system-setup.sh"),
  ];
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      // Try next location.
    }
  }
  throw new TincanError(
    "NOT_FOUND",
    "Could not locate packaging/system-setup/tincan-system-setup.sh",
  );
}

function runSetup(action: string, globals: Globals, io: CliIO): number {
  if (!["install", "uninstall", "status"].includes(action)) {
    throw new TincanError("INVALID_INPUT", `Unknown setup action: ${action}`, {
      expected: ["install", "uninstall", "status"],
    });
  }
  const sourceScript = locateSetupScript();
  const needsRoot = action !== "status" && process.getuid?.() !== 0;
  // Root cannot read scripts inside a user's AppImage FUSE mount (`/tmp/.mount_...`): stage a
  // temporary copy on the real filesystem and clean it up afterwards.
  let stagedDir: string | undefined;
  let script = sourceScript;
  if (needsRoot && sourceScript.includes("/tmp/.mount_")) {
    stagedDir = mkdtempSync(path.join(tmpdir(), "tincan-setup-"));
    cpSync(path.dirname(sourceScript), stagedDir, { recursive: true });
    script = path.join(stagedDir, path.basename(sourceScript));
  }
  try {
    const { command, args, env } = setupInvocation(script, action, {
      needsRoot,
      yes: globals.yes,
      env: io.env,
    });
    if (action !== "status") io.stderr(`tincan: ${BLUETOOTH_RESTART_WARNING}`);
    if (!io.exec) {
      const result = spawnSync(command, args, { stdio: "inherit", env });
      if (result.error) throw new TincanError("INTERNAL", result.error.message);
      return result.status ?? 1;
    }
    const result = io.exec(command, args);
    if (result.stdout) io.stdout(result.stdout.trimEnd());
    if (result.stderr) io.stderr(result.stderr.trimEnd());
    if (result.error) throw new TincanError("INTERNAL", result.error.message);
    return result.status ?? 1;
  } finally {
    if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
  }
}

/** Asks the daemon, or checks from here when it isn't running. Exits 1 when a check fails. */
async function runDoctor(args: string[], globals: Globals, io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: { report: { type: "boolean" } },
  });
  if (positionals.length)
    throw new TincanError("INVALID_INPUT", `Unexpected: ${positionals.join(" ")}`);
  let report: DoctorReport;
  try {
    const client = await TincanClient.connect({
      socketPath: resolvePaths(globals, io).socket,
      client: CLIENT,
    });
    try {
      report = (await client.call("doctor", {})) as DoctorReport;
    } finally {
      await client.close();
    }
  } catch (error) {
    if (!isTincanError(error) || error.code !== "NOT_CONNECTED") throw error;
    report = await offlineDoctor(io.env, io.system);
  }
  const output = values.report ? redactDoctorReport(report, { home: io.env.HOME }) : report;
  printResult(io, globals, "doctor", output);
  return report.checks.some((check) => check.status === "fail") ? 1 : 0;
}

async function runDaemonCommand(globals: Globals, io: CliIO): Promise<number> {
  const paths = resolvePaths(globals, io);
  const log = (message: string) => io.stderr(`tincan: ${message}`);
  // Undefined for a daemon that isn't the user's own (a fake phone, another socket).
  const service = managedService(io.env, globals.socket !== undefined, io.system);
  const loaded = await loadNative();
  const native = loaded.info;
  const phone = await openPhone(loaded, io);
  const { stop, stopped } = await runDaemon({
    version: VERSION,
    paths,
    native,
    store: phone.store,
    port: phone.port,
    legacyPhotosDir: phone.legacyPhotosDir,
    iconDir: runtimeIconDir(io.env),
    probeSystem: io.system?.probe ?? systemProbe(loaded, io.env),
    service,
    agentConnections: agentConnections(daemonMcpLaunch(globals, io), {
      env: io.env,
      exec: io.exec ?? spawnExec,
      cli: terminalCli(io.env),
      launchArgs: socketArgs(globals, io),
      ...(runningAsService() ? { outside: runOutsideSandbox } : {}),
    }),
    handleSignals: !io.interrupted,
    log,
  });
  if (io.interrupted) void io.interrupted().then(stop);
  if (!native.loaded) io.stderr(`tincan: native Bluetooth addon not loaded (${native.error})`);
  await stopped;
  phone.stop();
  return 0;
}

interface DaemonPhone {
  store?: OpenedStore;
  port: LoadedNative["port"];
  /** Where older versions kept contact photos as files. */
  legacyPhotosDir?: string;
  stop(): void;
}

/**
 * The store and phone the daemon runs with: a scripted fake phone and an in-memory store when
 * `TINCAN_FAKE_PHONE` names a scenario, otherwise the encrypted store and the real phone.
 */
async function openPhone(loaded: LoadedNative, io: CliIO): Promise<DaemonPhone> {
  const scenarioPath = io.env.TINCAN_FAKE_PHONE;
  if (scenarioPath) {
    let fake: typeof import("@beyland/tincan-fake-phone");
    try {
      fake = await import("@beyland/tincan-fake-phone");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
      throw new TincanError(
        "NOT_FOUND",
        "TINCAN_FAKE_PHONE needs @beyland/tincan-fake-phone, which isn't part of packaged builds. Run the daemon from a source checkout instead.",
      );
    }
    const scenario = await fake.loadScenario(path.resolve(io.cwd, scenarioPath));
    const phone = fake.phoneFromScenario(scenario);
    const playback = fake.playScenario(phone, scenario);
    io.stderr(`tincan: using a fake phone (${path.basename(scenarioPath)}) and an in-memory store`);
    return { store: openMemoryStore(), port: phone.port, stop: () => playback.stop() };
  }
  if (!loaded.port) return { port: null, stop() {} };
  const { dataDir } = servicePaths(io.env);
  return {
    store: await openVaultStore(loaded, dataDir),
    port: loaded.port,
    legacyPhotosDir: path.join(dataDir, "photos"),
    stop() {},
  };
}

async function runWatch(globals: Globals, io: CliIO): Promise<number> {
  const client = await TincanClient.connect({
    socketPath: resolvePaths(globals, io).socket,
    client: CLIENT,
    timeoutMs: 0,
  });
  const closed = new Promise<"closed">((resolve) => client.onClose(() => resolve("closed")));
  await client.subscribe((event) => {
    io.stdout(
      globals.json
        ? JSON.stringify(event)
        : `${new Date().toISOString()}  ${event.event}  ${JSON.stringify(event.data)}`,
    );
  });
  const reason = await Promise.race([closed, interrupted(io).then(() => "interrupted" as const)]);
  await client.close();
  if (reason === "closed") {
    throw new TincanError("NOT_CONNECTED", "The daemon stopped");
  }
  return 0;
}

const PAIR_HELP = `tincan pair [address] [--yes] [--json]

Pair an iPhone with this computer. Keep the iPhone unlocked on Settings › Bluetooth, near the computer.

Without an address Tincan searches for iPhones and makes this computer visible to them for a while:
pick the iPhone when Tincan finds it, or tap this computer in the iPhone's list (then confirm the code
in your desktop's Bluetooth prompt). With an address Tincan pairs that iPhone straight away.
Both screens show a six-digit code; accept it on both when they match. Ctrl+C stops.

--yes pairs the first iPhone found and accepts the code without asking.`;

/** What to try when pairing keeps failing (iOS caches a broken pairing until it restarts). */
export const PAIR_TIP =
  "If pairing keeps failing, forget this computer on the iPhone (Settings › Bluetooth › ⓘ › Forget This Device), restart the iPhone and try again.";

async function runPair(address: string | undefined, globals: Globals, io: CliIO): Promise<number> {
  const say = globals.json ? io.stderr : io.stdout;
  const ask = (question: string) => (globals.yes ? Promise.resolve(true) : confirm(io, question));
  const client = await TincanClient.connect({
    socketPath: resolvePaths(globals, io).socket,
    client: CLIENT,
  });
  let changed = false;
  let wake = () => {};
  await client.subscribe((event) => {
    if (event.event !== "pairing.changed") return;
    changed = true;
    wake();
  });
  const stop = interrupted(io).then(() => "interrupted" as const);
  const closed = new Promise<"closed">((resolve) => client.onClose(() => resolve("closed")));
  const offered = new Set<string>();
  let shown = "";
  let asked: string | null = null;
  try {
    let status = await client.run("device.pair.start", address ? { address } : {});
    for (;;) {
      if (status.state !== shown) {
        shown = status.state;
        if (status.state === "searching") {
          say(
            "Searching for iPhones. On the iPhone, open Settings › Bluetooth and keep it unlocked.",
          );
          say(
            status.discoverable
              ? `This computer shows there as "${status.adapterName}": tap it to pair from the iPhone, then confirm the code in your desktop's Bluetooth prompt.`
              : "This computer isn't visible to iPhones, so pick the iPhone here when Tincan finds it.",
          );
          if (status.handsFree === false) {
            say(
              "Warning: this computer isn't showing itself as a hands-free device, so the iPhone won't offer to share messages or contacts. Run `sudo btmgmt class 4 8`, then pair again.",
            );
          }
        } else if (status.state === "pairing") {
          say(`Pairing with ${status.name ?? status.address}…`);
        }
      }
      if (status.state === "paired") {
        say(`Paired with ${status.name ?? status.address}. Tincan will connect to it now.`);
        if (globals.json) io.stdout(JSON.stringify(status, null, 2));
        return 0;
      }
      if (status.state === "failed" || status.state === "idle") {
        const message = status.error?.message ?? "Pairing stopped";
        if (globals.json) io.stderr(JSON.stringify({ ok: false, error: status.error }, null, 2));
        else io.stderr(`error: ${message}\n${PAIR_TIP}`);
        return 1;
      }
      if (status.state === "confirm" && status.passkey && asked !== status.passkey) {
        asked = status.passkey;
        const accept = await ask(
          `Does the iPhone show ${status.passkey}? Accept it there too. Pair`,
        );
        status = await client.run("device.pair.confirm", { accept });
        continue;
      }
      if (status.state === "searching") {
        const next = status.candidates.find((c) => !offered.has(c.address));
        if (next) {
          offered.add(next.address);
          say(`Found ${next.name} (${next.address}).`);
          if (await ask(`Pair with ${next.name}?`)) {
            status = await client.run("device.pair.start", { address: next.address });
            continue;
          }
          status = await client.run("device.pair.status");
          continue;
        }
      }
      if (!changed) {
        const woke = new Promise<"changed">((resolve) => (wake = () => resolve("changed")));
        const reason = await Promise.race([woke, stop, closed]);
        if (reason === "interrupted") {
          await client.run("device.pair.cancel");
          io.stderr("Cancelled");
          return 1;
        }
        if (reason === "closed") throw new TincanError("NOT_CONNECTED", "The daemon stopped");
      }
      changed = false;
      status = await client.run("device.pair.status");
    }
  } finally {
    await client.close();
  }
}

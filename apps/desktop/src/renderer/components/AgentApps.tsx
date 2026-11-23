import type { AgentClient, AgentConnection } from "@beyland/tincan-protocol";
import { useEffect, useState } from "preact/hooks";
import { CommandError } from "../api.ts";
import { agentSetup, connectAgentApp, disconnectAgentApp, refreshAgentApps } from "../store.ts";
import { AgentLogo, type AgentLogoName } from "./AgentLogo.tsx";
import { useCopy } from "./CopyRow.tsx";
import { Icon } from "./Icon.tsx";

// Agent connection guide for configuring MCP clients to use Tincan's MCP server.

type AgentId = AgentClient | "other";

const AGENTS: { id: AgentId; label: string; logo?: AgentLogoName }[] = [
  { id: "copilot", label: "Copilot", logo: "copilot" },
  { id: "claude", label: "Claude", logo: "claude" },
  { id: "codex", label: "Codex", logo: "codex" },
  { id: "opencode", label: "OpenCode", logo: "opencode" },
  { id: "pi", label: "Pi", logo: "pi" },
  { id: "cursor", label: "Cursor", logo: "cursor" },
  { id: "antigravity", label: "Antigravity", logo: "antigravity" },
  { id: "muse", label: "Muse Code", logo: "muse" },
  { id: "other", label: "Other" },
];

/** What connecting does, before it's done. */
const INTRO: Record<AgentClient, string> = {
  copilot:
    "Add Tincan for Copilot in VS Code, the Copilot app, and the Copilot CLI (~/.copilot/mcp-config.json).",
  claude: "Register Tincan for all your Claude projects (runs claude mcp add for you).",
  codex: "Add Tincan for the Codex CLI and IDE extension (runs codex mcp add for you).",
  antigravity:
    "Add Tincan to ~/.gemini/config/mcp_config.json, shared by Antigravity 2.0, the IDE, and the CLI.",
  muse: "Add Tincan to ~/.config/muse/settings.json.",
  cursor: "Add Tincan to ~/.cursor/mcp.json.",
  opencode: "Add Tincan to ~/.config/opencode/opencode.json.",
  pi: "Add Tincan to ~/.pi/agent/mcp.json (Pi 0.99 or later).",
};

/** What to do after connecting. */
const AFTER_CONNECT: Record<AgentClient, string> = {
  copilot: "Reload VS Code or start a new Copilot session to use it.",
  claude: "Start a new Claude session to use it.",
  codex: "Start a new Codex session to use it.",
  opencode: "Restart OpenCode to use it.",
  pi: "Run /reload in open Pi sessions to use it.",
  cursor: "Restart Cursor to use it.",
  antigravity: "Refresh Installed MCP Servers in Antigravity to use it.",
  muse: "Start a new Muse Code session to use it.",
};

/** "/home/me/.cursor/mcp.json" → "~/.cursor/mcp.json". */
function tildify(file: string): string {
  return file.replace(/^(\/var\/home\/[^/]+|\/home\/[^/]+|\/Users\/[^/]+)/, "~");
}

const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/** A command or config to copy: click anywhere on it, or its Copy button. */
function CodeBlock({ code }: { code: string }) {
  const [copied, copy] = useCopy();
  return (
    <div
      class={`copyable ${copied ? "copied" : ""}`}
      onClick={() => !window.getSelection()?.toString() && void copy(code)}
    >
      <pre class="code">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        class="copy-hint"
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        onClick={(e) => {
          e.stopPropagation();
          void copy(code);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** One agent's details: its connection state, a Connect button, and the terminal command. */
function AgentPanel({ app }: { app: AgentConnection }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const label = AGENTS.find((a) => a.id === app.client)?.label ?? app.name;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      await work();
    } catch (caught) {
      if (caught instanceof CommandError && caught.code === "CONFLICT") setConflict(true);
      else setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = (force = false) => run(() => connectAgentApp(app.client, force));
  const terminal = (
    <div class="agent-step">
      <CodeBlock code={app.terminal} />
    </div>
  );

  return (
    <div class="agent-panel" id="agent-panel">
      {app.configured ? (
        <>
          <div class={`agent-connected ${app.current ? "" : "stale"}`}>
            <span class="agent-connected-icon" aria-hidden="true">
              <Icon name={app.current ? "check" : "alert"} size={16} />
            </span>
            <div class="agent-connected-text">
              <strong>
                {app.current ? `Connected to ${label}` : `Tincan is set up for ${label}`}
              </strong>
              <span>
                {app.current
                  ? `In ${tildify(app.file)}. ${AFTER_CONNECT[app.client]}`
                  : `In ${tildify(app.file)}, launched by another Tincan install or an older version.`}
              </span>
            </div>
            {app.current ? (
              <button
                type="button"
                class="button small"
                disabled={busy}
                onClick={() => void run(() => disconnectAgentApp(app.client))}
              >
                {busy ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : (
              <button
                type="button"
                class="button small"
                disabled={busy}
                onClick={() => void connect(true)}
              >
                {busy ? "Updating…" : "Use this app"}
              </button>
            )}
          </div>
          <details class="agent-terminal">
            <summary>Set up from a terminal</summary>
            {terminal}
          </details>
        </>
      ) : (
        <>
          <p class="agent-intro">{INTRO[app.client]}</p>
          <div class="agent-connect">
            <button
              type="button"
              class="button primary small"
              disabled={busy}
              onClick={() => void connect()}
            >
              {busy ? "Connecting…" : `Connect ${label}`}
            </button>
            {conflict && (
              <span class="agent-connect-status" role="status">
                Tincan is already set up differently for {label}.{" "}
                <button type="button" class="link" onClick={() => void connect(true)}>
                  Replace it
                </button>
              </span>
            )}
          </div>
          <details class="agent-terminal">
            <summary>Or set it up from a terminal</summary>
            {terminal}
          </details>
        </>
      )}
      {error && (
        <p class="agent-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Any other MCP client: the command that starts Tincan's server over stdio. */
function OtherPanel({ launch }: { launch: { command: string; args: string[] } }) {
  return (
    <div class="agent-panel" id="agent-panel">
      <div class="agent-step">
        <p>Point any MCP client at Tincan's server. It runs over stdio with this command:</p>
        <CodeBlock code={[launch.command, ...launch.args].map(quote).join(" ")} />
      </div>
    </div>
  );
}

/**
 * The agents Tincan can connect to, as a grid of logos; picking one opens its panel. For
 * Settings and the getting-started conversation.
 */
export function AgentConnectionGuide() {
  const [open, setOpen] = useState<AgentId | null>(null);
  useEffect(() => void refreshAgentApps(), []);
  const setup = agentSetup.value;
  if (setup === undefined) return <p class="agent-checking">Checking your agents…</p>;
  if (setup === null) {
    return (
      <p class="agent-checking">
        Run <code>tincan connect</code> in a terminal to see your agents and add Tincan to one.
      </p>
    );
  }
  const byId = new Map(setup.clients.map((app) => [app.client, app]));
  const current = open === "other" ? null : open ? byId.get(open) : undefined;
  return (
    <div class="agent-guide">
      <div class="agent-options" aria-label="Agents">
        {AGENTS.map((option) => {
          const app = option.id === "other" ? undefined : byId.get(option.id);
          const connected = app?.configured ?? false;
          return (
            <button
              type="button"
              key={option.id}
              aria-pressed={open === option.id}
              aria-expanded={open === option.id}
              aria-controls={open === option.id ? "agent-panel" : undefined}
              class={`agent-option ${open === option.id ? "active" : ""}`}
              onClick={() => setOpen(open === option.id ? null : option.id)}
            >
              <span class="agent-logo">
                {option.logo ? (
                  <AgentLogo name={option.logo} size={18} />
                ) : (
                  <Icon name="link" size={18} />
                )}
              </span>
              {option.label}
              {connected && (
                <span
                  class={`agent-option-badge ${app?.current ? "" : "stale"}`}
                  data-tip={app?.current ? "Connected" : "Set up for another Tincan"}
                >
                  <Icon name={app?.current ? "check" : "alert"} size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {open === "other" && <OtherPanel launch={setup.launch} />}
      {current && <AgentPanel key={current.client} app={current} />}
    </div>
  );
}

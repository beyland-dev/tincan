/*
 * Environment variables that AI coding agents set for the shell commands they run. When one is
 * present the CLI connects as an AI agent (an `mcp` client), so the agent policy applies to it, and
 * refuses policy commands (`settings.set`, `draft.send`, `agents.connect`, …) outright, so an agent
 * with a shell can't send its own drafts or loosen the policy by accident.
 *
 * A usability control, not a security boundary: an agent can unset these, and anything running as
 * the user can reach the daemon's socket. Kept in one place so every client checks the same list.
 */

/**
 * Exact names: set (to anything but an empty string, "0" or "false") means an agent runs it. Only
 * variables the tools set at run time: settings people export in their own shell profile (Claude
 * Code's `CLAUDE_CODE_USE_BEDROCK`, Codex's `CODEX_HOME`, …) would refuse the user too.
 */
export const AGENT_ENV_VARS: readonly string[] = [
  // Claude Code sets these for every command it runs.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  // OpenAI Codex CLI: its sandboxed shell and agent sessions.
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  // Cursor's agent terminal.
  "CURSOR_AGENT",
  // Gemini CLI and its forks.
  "GEMINI_CLI",
  "QWEN_CODE",
  // GitHub Copilot's CLI and coding agent.
  "COPILOT_CLI",
  "COPILOT_AGENT",
  // opencode, Goose, Amp, and the generic markers some agents set.
  "OPENCODE",
  "GOOSE_TERMINAL",
  "AMP_AGENT",
  "AI_AGENT",
  "AGENT",
];

/** Prefixes: any variable starting with one of these marks an agent's shell. */
export const AGENT_ENV_PREFIXES: readonly string[] = ["CODEX_SANDBOX", "COPILOT_AGENT_"];

function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/** The first variable in `env` that marks an AI agent's shell, or null. */
export function agentEnvironmentMarker(env: Record<string, string | undefined>): string | null {
  for (const name of AGENT_ENV_VARS) if (isSet(env[name])) return name;
  for (const [name, value] of Object.entries(env)) {
    if (AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) && isSet(value)) return name;
  }
  return null;
}

/** The agent a marker belongs to, by name, as the CLI reports itself when run in its shell. */
export function agentEnvironmentName(marker: string): string {
  if (marker === "CLAUDECODE" || marker.startsWith("CLAUDE_CODE")) return "Claude Code";
  if (marker.startsWith("CODEX_")) return "Codex";
  if (marker === "CURSOR_AGENT") return "Cursor";
  if (marker === "GEMINI_CLI") return "Gemini CLI";
  if (marker === "QWEN_CODE") return "Qwen Code";
  if (marker.startsWith("COPILOT_")) return "GitHub Copilot";
  if (marker === "OPENCODE") return "opencode";
  if (marker === "GOOSE_TERMINAL") return "Goose";
  if (marker === "AMP_AGENT") return "Amp";
  return "AI agent";
}

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { main, type CliIO } from "../src/index.ts";
import {
  installMcpConfig,
  mcpConfigStatus,
  removeMcpConfig,
  resolveMcpClient,
  type Exec,
} from "../src/mcp-config.ts";
import { agentConnections } from "../src/agent-connections.ts";

let home: string;
const homes: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(import.meta.dirname, ".home-"));
  homes.push(home);
});

afterAll(async () => {
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Captured = CliIO & { out: string[]; err: string[]; questions: string[] };

/** Someone at a terminal answering yes, with no daemon running. */
function capture(exec?: Exec): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  return {
    out,
    err,
    questions,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: process.cwd(),
    // A socket nothing listens on, so the list form never reaches a real daemon.
    env: { HOME: home, TINCAN_SOCKET: path.join(home, "run", "tincan.sock") },
    interactive: true,
    confirm: async (question) => (questions.push(question), true),
    ...(exec ? { exec } : {}),
  };
}

async function tincanWith(io: Captured, argv: string[]) {
  const code = await main(argv, io);
  return { code, stdout: io.out.join("\n"), stderr: io.err.join("\n"), questions: io.questions };
}

async function tincan(argv: string[], exec?: Exec) {
  return tincanWith(capture(exec), argv);
}

/** Exec that fails the test if anything runs a client CLI. */
const noExec: Exec = (command) => {
  throw new Error(`ran ${command}`);
};

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

const launch = { command: "/usr/bin/node", args: ["/opt/tincan/bin.mjs", "mcp"] };

describe("tincan connect", () => {
  it("installs by default, after asking", async () => {
    const result = await tincan(["connect", "cursor", "--json"]);
    expect(result.code).toBe(0);
    const file = path.join(home, ".cursor", "mcp.json");
    expect(JSON.parse(result.stdout)).toMatchObject({
      client: "cursor",
      status: "created",
      file,
      name: "tincan",
    });
    expect(result.questions).toEqual([expect.stringContaining("Add Tincan to Cursor")]);
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config.mcpServers.tincan.args.at(-1)).toBe("mcp");

    const again = await tincan(["connect", "cursor"]);
    expect(again.stdout).toBe(`MCP server "tincan" is already configured in ${file}`);
  });

  it("changes nothing when declined", async () => {
    const io = capture(noExec);
    io.confirm = async () => false;
    const declined = await tincanWith(io, ["connect", "cursor", "--yes"]);
    expect(declined).toMatchObject({ code: 1, stderr: "Cancelled" });
    expect(await exists(path.join(home, ".cursor"))).toBe(false);
  });

  it("prints a client's snippet with --print and changes nothing", async () => {
    const claude = await tincan(["connect", "claude", "--print"], noExec);
    expect(claude.code).toBe(0);
    expect(claude.stdout).toContain("Claude Code");
    expect(claude.stdout).toMatch(/claude mcp add --scope user tincan -- \S+ \S+ mcp/);
    expect(claude.questions).toEqual([]);
    expect((await tincan(["connect", "codex", "--print"])).stdout).toContain(
      "[mcp_servers.tincan]",
    );

    const vscode = await tincan(["connect", "vscode", "--print", "--json"]);
    const printed = JSON.parse(vscode.stdout);
    expect(printed).toMatchObject({
      client: "copilot",
      file: path.join(home, ".copilot", "mcp-config.json"),
    });
    expect(printed.launch.args.at(-1)).toBe("mcp");
    expect(printed.launch.command).toMatch(/node/);
    expect(JSON.parse(printed.snippet).mcpServers.tincan.args.at(-1)).toBe("mcp");

    const socket = await tincan(["connect", "cursor", "--print", "--socket", "/run/x.sock"]);
    expect(socket.stdout).toContain('"--socket",\n        "/run/x.sock"');
    expect((await tincan(["connect", "cursor", "--print", "--name", "phone"])).stdout).toContain(
      '"phone"',
    );
    expect(await readdir(home)).toEqual([]);
  });

  it("allows --print anywhere: in an agent's shell and in a script", async () => {
    const io = capture(noExec);
    io.env = { ...io.env, CLAUDECODE: "1" };
    io.interactive = false;
    delete io.confirm;
    const printed = await tincanWith(io, ["connect", "cursor", "--print"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain('"mcpServers"');
    expect(await readdir(home)).toEqual([]);
  });

  it("refuses to install or remove from an agent's shell or a script, even with --yes", async () => {
    for (const argv of [
      ["connect", "cursor"],
      ["connect", "cursor", "--force"],
      ["disconnect", "cursor"],
    ]) {
      const agent = capture(noExec);
      agent.env = { ...agent.env, CLAUDECODE: "1" };
      const refused = await tincanWith(agent, [...argv, "--yes"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/AI agent's shell \(\$CLAUDECODE is set\)/);
      expect(refused.questions).toEqual([]);

      const scripted = capture(noExec);
      scripted.interactive = false;
      delete scripted.confirm;
      const unattended = await tincanWith(scripted, [...argv, "--yes"]);
      expect(unattended.code).toBe(1);
      expect(unattended.stderr).toMatch(/needs you to confirm it at a terminal/);
    }
    expect(await exists(path.join(home, ".cursor"))).toBe(false);
  });

  it("runs unattended for the background service, but never in an agent's shell", async () => {
    const io = capture(noExec);
    io.interactive = false;
    delete io.confirm;
    io.env = { ...io.env, TINCAN_AGENT_APPS_FROM_SERVICE: "1" };
    expect((await tincanWith(io, ["connect", "pi", "--json"])).code).toBe(0);

    const agent = capture(noExec);
    agent.env = { ...agent.env, TINCAN_AGENT_APPS_FROM_SERVICE: "1", CLAUDECODE: "1" };
    const refused = await tincanWith(agent, ["disconnect", "pi"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/AI agent's shell/);
    expect((await mcpConfigStatus("pi", launch, { env: { HOME: home } })).configured).toBe(true);
  });

  it("lists the apps and whether each is connected", async () => {
    await installMcpConfig("pi", { ...launch, command: "/old/node" }, { env: { HOME: home } });
    await tincan(["connect", "cursor"]);
    const listed = await tincan(["connect"], noExec);
    expect(listed.code).toBe(0);
    expect(listed.questions).toEqual([]);
    const lines = listed.stdout.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}cursor +Cursor +connected$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}claude +Claude +not connected$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/^ {2}pi +Pi +connected to another Tincan .*--force/),
    );
    expect(listed.stdout).toContain("tincan connect <agent>");

    const json = JSON.parse((await tincan(["connect", "--json"])).stdout);
    expect(json.clients.map((a: { client: string }) => a.client)).toHaveLength(8);
    expect(json.clients.find((a: { client: string }) => a.client === "cursor")).toMatchObject({
      configured: true,
      current: true,
    });

    // Listing is read-only, so it runs in an agent's shell too.
    const io = capture(noExec);
    io.env = { ...io.env, CLAUDECODE: "1" };
    expect((await tincanWith(io, ["connect"])).code).toBe(0);
  });

  it("requires an agent, except to list them", async () => {
    for (const argv of [
      ["connect", "--print"],
      ["connect", "--force"],
      ["connect", "--name", "phone"],
      ["disconnect"],
    ]) {
      const result = await tincan(argv, noExec);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /Name an agent: `tincan (connect|disconnect) <agent>`, one of copilot/,
      );
    }
    const unknown = await tincan(["connect", "emacs"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown agent emacs. Choose one of: copilot, claude");
    expect((await tincan(["connect", "cursor", "pi"])).code).toBe(1);
    expect((await tincan(["connect", "cursor", "--print", "--force"])).stderr).toContain(
      "--force doesn't apply to --print",
    );
    expect((await tincan(["disconnect", "cursor", "--force"])).code).toBe(1);
    expect((await tincan(["mcp-config", "cursor"])).code).toBe(1);
    expect(await readdir(home)).toEqual([]);
  });

  it("merges into an existing config, keeping its comments, and is idempotent", async () => {
    const file = path.join(home, ".copilot", "mcp-config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `{
  // Mine
  "mcpServers": { "other": { "command": "other" }, },
  "inputs": [],
}
`,
    );

    const first = await installMcpConfig("copilot", launch, { env: { HOME: home } });
    expect(first.status).toBe("updated");
    const text = await readFile(file, "utf8");
    expect(text).toContain("// Mine");
    expect(text).toContain('"tincan"');
    expect(text).toContain('"other"');

    const again = await installMcpConfig("copilot", launch, { env: { HOME: home } });
    expect(again.status).toBe("unchanged");
    expect(resolveMcpClient("vscode")).toBe("copilot");
  });

  it("refuses to replace a different entry without --force", async () => {
    const file = path.join(home, ".copilot", "mcp-config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { tincan: { command: "old" } } }));

    await expect(
      installMcpConfig("copilot", launch, { env: { HOME: home } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const forced = await installMcpConfig("copilot", launch, { env: { HOME: home }, force: true });
    expect(forced.status).toBe("updated");
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config.mcpServers.tincan).toEqual({ ...launch, tools: ["*"] });
  });

  it("honours $COPILOT_HOME and --name", async () => {
    const copilotHome = path.join(home, "copilot");
    const result = await installMcpConfig("copilot", launch, {
      env: { HOME: home, COPILOT_HOME: copilotHome },
      name: "phone",
    });
    expect(result.file).toBe(path.join(copilotHome, "mcp-config.json"));
    const config = JSON.parse(await readFile(result.file, "utf8"));
    expect(Object.keys(config.mcpServers)).toEqual(["phone"]);
  });

  it("refuses a config that isn't JSON", async () => {
    const file = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    await expect(installMcpConfig("cursor", launch, { env: { HOME: home } })).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("uses the client's own CLI for Claude Code and Codex", async () => {
    const calls: string[][] = [];
    const exec: Exec = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const claude = await tincan(["connect", "claude"], exec);
    expect(claude.code).toBe(0);
    expect(claude.stdout).toContain("(via claude)");
    expect(calls[0]!.slice(0, 7)).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "tincan",
      "--",
    ]);
    expect(calls[0]!.at(-1)).toBe("mcp");

    // Already there with the same command: nothing to do.
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { tincan: { type: "stdio", ...launch } } }),
    );
    expect(await installMcpConfig("claude", launch, { env: { HOME: home }, exec })).toMatchObject({
      status: "unchanged",
    });

    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.tincan]\ncommand = "old"\nargs = []\n',
    );
    await expect(
      installMcpConfig("codex", launch, { env: { HOME: home }, exec }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    calls.length = 0;
    await installMcpConfig("codex", launch, { env: { HOME: home }, exec, force: true });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["codex", "mcp", "remove"],
      ["codex", "mcp", "add"],
    ]);
  });

  it("explains how to configure a client whose CLI isn't installed", async () => {
    const missing: Exec = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    });
    const result = await tincan(["connect", "codex"], missing);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Couldn't find the codex command");
    expect(result.stderr).toContain("[mcp_servers.tincan]");
  });
});

describe("agent app setup from the app", () => {
  it("reports, connects, updates and removes Tincan's entry", async () => {
    const env = { HOME: home };
    const status = () => mcpConfigStatus("cursor", launch, { env });
    expect(await status()).toMatchObject({ configured: false, current: false });

    await installMcpConfig("cursor", launch, { env });
    expect(await status()).toMatchObject({ configured: true, current: true });
    const moved = { ...launch, command: "/opt/other/node" };
    expect(await mcpConfigStatus("cursor", moved, { env })).toMatchObject({
      configured: true,
      current: false,
    });

    expect(await removeMcpConfig("cursor", { env })).toBe("removed");
    expect(await removeMcpConfig("cursor", { env })).toBe("absent");
    expect(await status()).toMatchObject({ configured: false });
  });

  it("lists every app, and replaces a different entry only when asked", async () => {
    const env = { HOME: home };
    const calls: string[][] = [];
    const exec: Exec = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const apps = agentConnections(launch, { env, exec, cli: ["tincan"] });
    const listed = await apps.list();
    expect(listed.map((a) => a.client)).toEqual([
      "copilot",
      "claude",
      "codex",
      "antigravity",
      "muse",
      "cursor",
      "opencode",
      "pi",
    ]);
    expect(listed.find((a) => a.client === "claude")).toMatchObject({
      name: "Claude",
      configured: false,
      terminal: "tincan connect claude",
    });
    expect(listed.find((a) => a.client === "opencode")?.snippet).toContain('"mcp"');

    await installMcpConfig("pi", { ...launch, command: "/old/node" }, { env });
    await expect(apps.connect("pi")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await apps.connect("pi", true)).toMatchObject({ configured: true, current: true });
    expect((await apps.disconnect("pi")).configured).toBe(false);
    expect(calls).toEqual([]);
  });

  it("changes configs through a run outside the service's sandbox", async () => {
    const env = { HOME: home };
    const runs: string[][] = [];
    let reply = { status: 0, stdout: "{}", stderr: "" };
    const apps = agentConnections(launch, {
      env,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      cli: ["tincan"],
      outside: async (args) => {
        runs.push(args);
        return reply;
      },
    });
    await apps.connect("claude");
    await apps.connect("claude", true);
    await apps.disconnect("claude");
    expect(runs).toEqual([
      ["connect", "claude", "--json"],
      ["connect", "claude", "--force", "--json"],
      ["disconnect", "claude", "--json"],
    ]);

    reply = {
      status: 1,
      stdout: "",
      stderr: JSON.stringify({ ok: false, error: { code: "CONFLICT", message: "already there" } }),
    };
    await expect(apps.connect("cursor")).rejects.toMatchObject({ code: "CONFLICT" });
    reply = { status: 1, stdout: "", stderr: "Failed to connect to bus" };
    await expect(apps.connect("cursor")).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringContaining("Failed to connect to bus"),
    });
  });

  it("removes Tincan from a client with `tincan disconnect`, after asking", async () => {
    await tincan(["connect", "pi"]);
    const removed = await tincan(["disconnect", "pi", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ client: "pi", status: "removed" });
    expect(removed.questions).toEqual([expect.stringContaining("Remove Tincan from Pi")]);
    expect(await mcpConfigStatus("pi", launch, { env: { HOME: home } })).toMatchObject({
      configured: false,
    });
    const absent = await tincan(["disconnect", "pi"]);
    expect(absent.stdout).toContain("Tincan's MCP server isn't in");

    const io = capture();
    io.confirm = async () => false;
    await tincan(["connect", "pi"]);
    expect(await tincanWith(io, ["disconnect", "pi"])).toMatchObject({
      code: 1,
      stderr: "Cancelled",
    });
    expect((await mcpConfigStatus("pi", launch, { env: { HOME: home } })).configured).toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { unknownFacts, type SystemFacts } from "@beyland/tincan-core";
import type { Systemctl } from "@beyland/tincan-daemon";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Thread } from "@beyland/tincan-protocol";
import { main, type CliIO } from "../src/index.ts";

const facts: SystemFacts = {
  ...unknownFacts({ loaded: true, version: "0.1.0", error: null }),
  bluezVersion: "5.87",
  bluetoothd: { running: true, experimental: true },
};
const systemctlCalls: string[][] = [];
const systemctl: Systemctl = async (args) => {
  systemctlCalls.push(args);
  const stdout = args[0] === "is-enabled" ? "enabled" : args[0] === "is-active" ? "active" : "";
  return { code: 0, stdout, stderr: "" };
};

const SCENARIO = path.resolve(import.meta.dirname, "../../../fixtures/scenarios/busy-group.json");
let root: string;
let socket: string;
let stopDaemon: () => void;
let daemonExit: Promise<number>;

function capture(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: process.cwd(),
    // A scripted phone and an in-memory store: the tests never touch Bluetooth or the keyring.
    env: { HOME: root, TINCAN_FAKE_PHONE: SCENARIO },
    system: {
      probe: async () => facts,
      systemctl,
      execStart: ["/opt/node", "/opt/tincan.mjs", "daemon"],
    },
  };
}

async function tincan(...argv: string[]) {
  return tincanWith(capture(), ...argv);
}

/** An AI agent's shell with a terminal. */
function atTerminalAsAgent() {
  const io = atTerminal();
  io.env = { ...io.env, CLAUDECODE: "1" };
  return io;
}

/** Someone at a terminal answering `answer` to every question. */
function atTerminal(answer = true, questions: string[] = []) {
  const io = capture();
  io.interactive = true;
  io.confirm = async (question) => (questions.push(question), answer);
  return io;
}

async function tincanWith(io: CliIO & { out: string[]; err: string[] }, ...argv: string[]) {
  const code = await main([...argv, "--socket", socket], io);
  return { code, stdout: io.out.join("\n"), stderr: io.err.join("\n") };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-cli-"));
  socket = path.join(root, "run", "tincan.sock");
  const io = capture();
  io.interrupted = () => new Promise<void>((resolve) => (stopDaemon = resolve));
  daemonExit = main(["daemon", "--socket", socket], io);
  for (let i = 0; i < 100; i++) {
    if ((await tincan("version")).code === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`daemon did not start: ${io.err.join("\n")}`);
});

afterAll(async () => {
  stopDaemon?.();
  expect(await daemonExit).toBe(0);
  await rm(root, { recursive: true, force: true });
});

describe("tincan", () => {
  it("prints help and its version without a daemon", async () => {
    const helpIo = capture();
    expect(await main(["--help"], helpIo)).toBe(0);
    expect(helpIo.out.join("")).toContain("service <install|uninstall|status>");
    expect(helpIo.out.join("")).not.toContain("service.install");
    const io = capture();
    await main(["settings", "set", "--help"], io);
    expect(io.out.join("")).toContain("tincan settings.set");
    expect(io.out.join("")).toContain("--agents <json>");
    expect(io.out.join("")).toContain("--agents-read <value> [off|contacts|known|all]");
    expect(io.out.join("")).not.toContain("agents-drafts");
    expect(io.out.join("")).toContain("--agents-send-delay-seconds <0-300>");
    expect(io.out.join("")).toContain("--send-delay-seconds <0-300>");
    expect(io.out.join("")).toContain("--access <off|read-only|assistant|full>");
    expect(io.out.join("")).toContain("--agents-send-limit <1-60|none>");
    expect(io.out.join("")).not.toContain("--preset");
  });

  it("prints the protocol schema without a daemon", async () => {
    const io = capture();
    expect(await main(["schema"], io)).toBe(0);
    const schema = JSON.parse(io.out.join(""));
    expect(schema.commands.map((c: { name: string }) => c.name)).toContain("status");
  });

  it("runs status against the daemon", async () => {
    const human = await tincan("status");
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^Daemon\s+\d+\.\d+\.\d+ \(protocol 2/);
    // The phone's Bluetooth address only with --verbose.
    expect(human.stdout).toMatch(/Phone\s+\w+ — Fake iPhone$/);
    expect(human.stdout).not.toContain("AA:BB");
    expect((await tincan("status", "--verbose")).stdout).toMatch(
      /Phone\s+\w+ — Fake iPhone \(AA:BB:CC:DD:EE:01\)$/,
    );

    const json = JSON.parse((await tincan("status", "--json")).stdout);
    expect(json.daemon.pid).toBe(process.pid);
  });

  it("lists agents as the daemon sees them", async () => {
    // Tincan in the daemon's $HOME only: the list comes from the daemon, not this process's $HOME.
    const file = path.join(root, ".pi", "agent", "mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { tincan: { command: "/old/node" } } }));
    try {
      const io = capture();
      io.env = { ...io.env, HOME: path.join(root, "elsewhere") };
      const listed = await tincanWith(io, "connect");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(/^ {2}pi +Pi +connected to another Tincan/m);
      expect(listed.stdout).toMatch(/^ {2}cursor +Cursor +not connected$/m);
    } finally {
      await rm(path.join(root, ".pi"), { recursive: true, force: true });
    }
  });

  it("lists commands with schemas, including internal ones", async () => {
    const { code, stdout } = await tincan("commands", "--json");
    expect(code).toBe(0);
    const list = JSON.parse(stdout) as { name: string; inputSchema: unknown }[];
    expect(list.map((c) => c.name)).toEqual(
      expect.arrayContaining(["status", "version", "commands", "settings.get", "settings.set"]),
    );
    expect(list[0]!.inputSchema).toMatchObject({ type: "object" });
  });

  it("changes settings with JSON flags", async () => {
    const questions: string[] = [];
    const set = await tincanWith(
      atTerminal(true, questions),
      "settings",
      "set",
      "--agents",
      '{"read":"known"}',
      "--json",
    );
    expect(set.code).toBe(0);
    expect(questions).toEqual(['Change what AI agents may do ({"read":"known"})?']);
    expect(JSON.parse(set.stdout).agents).toEqual({
      access: "off",
      read: "known",
      send: "approve",
      sendLimit: 10,
      sendDelaySeconds: 10,
      manage: false,
      handles: "hidden",
      hideCodes: true,
    });
  });

  it("changes agent settings with an access level and a flag per field", async () => {
    const questions: string[] = [];
    const set = await tincanWith(
      atTerminal(true, questions),
      "settings",
      "set",
      "--access",
      "full",
      "--agents-send-limit",
      "12",
      "--no-agents-manage",
      "--agents-hide-codes",
    );
    expect(set.code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Agents will send messages to anyone without asking you.");
    expect(questions[0]).toContain("Agents will read every conversation");
    expect(questions[0]).toContain("With full access there's no send limit");
    expect(questions[0]).toContain(
      "Warning: An incoming message could trick an agent into replying with sensitive information or take actions using other tools you've given it.",
    );
    expect(questions[0]).not.toContain("Anyone can text your phone");
    expect(set.stdout).toContain("AI agents       Full access (--access full)");
    // Full access has no send limit, whatever is stored.
    expect(set.stdout).toMatch(/Send\s+directly \(always\), no limit/);
    expect(set.stdout).not.toContain("always, below full access");
    const got = JSON.parse((await tincan("settings", "get", "--json")).stdout).agents;
    expect(got).toMatchObject({
      access: "full",
      read: "all",
      send: "always",
      sendLimit: 12,
      manage: false,
      hideCodes: true,
    });

    // Already full: no warning about moving to it.
    const again: string[] = [];
    await tincanWith(atTerminal(true, again), "settings", "set", "--access", "full");
    expect(again[0]).not.toContain("With full access");

    const assistant = await tincanWith(atTerminal(), "settings", "set", "--access=assistant");
    expect(assistant.stdout).toContain("AI agents       Assistant (--access assistant)");
    // Coming from another level, sends ask again.
    expect(assistant.stdout).toMatch(
      /Send\s+every message is a draft for you to review \(approve\), up to 12 per 10/,
    );
    expect(assistant.stdout).toMatch(/Numbers\s+hidden behind opaque IDs \(always, below full/);
    const unlimited = await tincanWith(
      atTerminal(),
      "settings",
      "set",
      "--agents-send-limit",
      "none",
    );
    expect(unlimited.stdout).toMatch(
      /Send\s+every message is a draft for you to review \(approve\), no limit/,
    );
    // A level leaves the privacy options as they were.
    const shown = await tincanWith(
      atTerminal(),
      "settings",
      "set",
      "--agents-handles",
      "visible",
      "--json",
    );
    expect(JSON.parse(shown.stdout).agents).toMatchObject({ read: "all", handles: "visible" });
    await tincanWith(atTerminal(), "settings", "set", "--access", "read-only");
    expect(JSON.parse((await tincan("settings", "get", "--json")).stdout).agents).toMatchObject({
      access: "readOnly",
      handles: "visible",
    });
    // The old --preset still works.
    await tincanWith(atTerminal(), "settings", "set", "--preset", "off");
    expect((await tincan("settings", "get")).stdout).toMatch(
      /^AI agents\s+Off \(--access off\): only status and settings\n/,
    );
    const reset = await tincanWith(atTerminal(), "settings", "set", "--agents-handles", "hidden");
    expect(reset.code).toBe(0);

    const unknown = await tincanWith(atTerminal(), "settings", "set", "--access", "everything");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown access level");
    // A setting that's gone gets a clear error.
    const old = await tincanWith(atTerminal(), "settings", "set", "--agents", '{"enabled":true}');
    expect(old.code).toBe(1);
    expect(old.stderr).toContain("agents.access");
  });

  it("reports errors with codes", async () => {
    const bad = await tincanWith(
      atTerminal(),
      "settings",
      "set",
      "--agents",
      '{"send":"allow"}',
      "--json",
    );
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stderr).error.code).toBe("INVALID_INPUT");

    const unknown = await tincan("frobnicate");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown command");
  });

  it("explains when the daemon is not running", async () => {
    const io = capture();
    const code = await main(["status", "--socket", path.join(root, "none", "x.sock")], io);
    expect(code).toBe(1);
    expect(io.err.join("")).toContain("tincan daemon");
  });

  it("runs doctor through the daemon", async () => {
    const { code, stdout } = await tincan("doctor");
    expect(code).toBe(0);
    expect(stdout).toMatch(/^✓ Tincan daemon +Running /m);
    expect(stdout).toContain("✓ BlueZ");
    const json = JSON.parse((await tincan("doctor", "--json")).stdout);
    expect(json).toMatchObject({ daemon: true });
    expect(json.checks.find((c: { id: string }) => c.id === "daemon").status).toBe("ok");
  });

  it("runs doctor without a daemon", async () => {
    const io = capture();
    const code = await main(
      ["doctor", "--json", "--socket", path.join(root, "none", "x.sock")],
      io,
    );
    expect(code).toBe(1);
    const report = JSON.parse(io.out.join(""));
    expect(report.daemon).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: "daemon", status: "fail" });
    expect(report.checks.find((c: { id: string }) => c.id === "bluez").status).toBe("ok");
  });

  it("installs, reports and removes the service", async () => {
    systemctlCalls.length = 0;
    const install = await tincan("service", "install");
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("Command   /opt/node /opt/tincan.mjs daemon");
    expect(install.stdout).toContain("Running   yes");
    const unit = await readFile(path.join(root, ".config/systemd/user/tincan.service"), "utf8");
    expect(unit).toContain("ExecStart=/opt/node /opt/tincan.mjs daemon");
    expect(systemctlCalls).toContainEqual(["enable", "tincan.service"]);

    const status = JSON.parse((await tincan("service", "status", "--json")).stdout);
    expect(status).toMatchObject({ installed: true, enabled: true, active: true });

    const removed = await tincan("service", "uninstall");
    expect(removed.stdout).toContain("(not installed)");
    expect((await tincan("service", "restart")).code).toBe(1);
  });

  it("lists conversations with the threads shortcut", async () => {
    const shortcut = await tincan("threads", "--json");
    expect(shortcut.code).toBe(0);
    const threads = JSON.parse(shortcut.stdout) as { key: string }[];
    expect(threads.length).toBeGreaterThan(0);
    expect(threads).toEqual(JSON.parse((await tincan("thread", "list", "--json")).stdout));
  });

  it("names people and conversations, with keys only in --verbose and --json", async () => {
    expect((await tincan("send", "+15550100099", "Names, not numbers", "--yes")).code).toBe(0);
    const threads = await tincan("threads");
    expect(threads.code).toBe(0);
    expect(threads.stdout).toMatch(/^Ada Lovelace/m);
    // No contact: a formatted number, never the key.
    expect(threads.stdout).toMatch(/^\+1 \(555\) 010-0099$/m);
    expect(threads.stdout).not.toMatch(/tel:|email:|\+1555/);

    const verbose = await tincan("threads", "--verbose");
    expect(verbose.stdout).toMatch(/^ {2}tel:\+15550100001 {2}/m);
    expect(verbose.stdout).toMatch(/^\+1 \(555\) 010-0099\n {2}tel:\+15550100099 {2}/m);
    expect((await tincan("threads", "--verbose")).stdout).toContain("tel:+15550100099");

    // --json is the result as it came, with or without --verbose.
    const json = JSON.parse((await tincan("threads", "--json")).stdout) as Thread[];
    expect(json.map((t) => t.key)).toEqual(expect.arrayContaining(["tel:+15550100001"]));
    expect(json.find((t) => t.key === "tel:+15550100099")?.title).toBe("+15550100099");
    const verboseJson = JSON.parse(
      (await tincan("threads", "--json", "--verbose")).stdout,
    ) as Thread[];
    expect(verboseJson.map((t) => t.key)).toEqual(json.map((t) => t.key));

    // Senders by contact name, you as "You", the conversation on the next line.
    const search = await tincan("message", "search", "Saturday");
    expect(search.stdout).toMatch(
      / {2}Ada Lovelace: Are we still on for Saturday\?\n {2}Ada Lovelace {2}\S+/,
    );
    expect(search.stdout).not.toMatch(/tel:/);
    const mine = await tincan("message", "search", "Names, not numbers");
    expect(mine.stdout).toMatch(/ {2}You: Names, not numbers\n {2}\+1 \(555\) 010-0099 {2}/);
    const searchVerbose = await tincan("message", "search", "Saturday", "--verbose");
    expect(searchVerbose.stdout).toContain("Ada Lovelace (tel:+15550100001): Are we still on");
    expect(
      JSON.parse((await tincan("message", "search", "Saturday", "--json")).stdout)[0].sender,
    ).toBe("tel:+15550100001");

    // Names work wherever a key did.
    const byName = await tincan("message", "list", "Ada Lovelace");
    expect(byName.stdout).toContain("Ada Lovelace: Are we still on for Saturday?");
    const shown = await tincan("thread", "show", "Ada Lovelace");
    expect(shown.stdout).toMatch(/^Ada Lovelace/);
    expect(shown.stdout).not.toContain("tel:");
    expect((await tincan("thread", "show", "Ada Lovelace", "--verbose")).stdout).toContain(
      "Key      tel:+15550100001",
    );

    // -v is the version (like --version); --verbose has no short form and -V isn't a flag.
    expect((await tincan("-v")).stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect((await tincan("--version")).stdout).toBe((await tincan("-v")).stdout);
    expect((await tincan("threads", "-V")).code).not.toBe(0);
    const help = capture();
    await main(["--help"], help);
    expect(help.out.join("")).toContain("-v, --version");
    expect(help.out.join("")).toMatch(/^ {2}--verbose /m);
    expect(help.out.join("")).not.toContain("-V");
    const threadHelp = capture();
    await main(["threads", "--help"], threadHelp);
    expect(threadHelp.out.join("")).toContain("Add --verbose to also print each thread key");
  });

  it("asks before sending, unless --yes", async () => {
    const questions: string[] = [];
    const declined = capture();
    declined.confirm = async (question) => (questions.push(question), false);
    const no = await tincanWith(declined, "send", "+15550100003", "See you there");
    expect(no.code).toBe(1);
    expect(no.stderr).toBe("Cancelled");
    expect(questions).toEqual(["Send this message to +15550100003?"]);
    expect(
      JSON.parse((await tincan("message", "search", "See you there", "--json")).stdout),
    ).toEqual([]);

    const accepted = capture();
    accepted.confirm = async () => true;
    const yes = await tincanWith(accepted, "send", "+15550100003", "See you there", "--json");
    expect(yes.code).toBe(0);
    expect(JSON.parse(yes.stdout)).toMatchObject({
      outcome: "sent",
      message: { direction: "outgoing", body: "See you there" },
    });
    const sent = JSON.parse((await tincan("message", "search", "See you there", "--json")).stdout);
    expect(sent).toHaveLength(1);

    const unasked = capture();
    unasked.confirm = async () => {
      throw new Error("should not ask");
    };
    expect((await tincanWith(unasked, "message", "send", "+15550100003", "Again", "-y")).code).toBe(
      0,
    );
  });

  it("never changes agent policy or sends agent drafts without a person at a terminal", async () => {
    const before = JSON.parse((await tincan("settings", "get", "--json")).stdout).agents;
    const agentSettings = ["settings", "set", "--agents", '{"access":"full","send":"replied"}'];
    const presetSettings = ["settings", "set", "--access", "full"];
    const fieldSettings = ["settings", "set", "--agents-read", "all"];
    const policy = [
      agentSettings,
      presetSettings,
      fieldSettings,
      ["draft", "send", "drf_some-id"],
      ["draft", "discard", "drf_some-id"],
      ["agents", "connect", "claude"],
      ["agents", "show", "tel:+15550100003"],
    ];
    for (const argv of policy) {
      // A script, even with --yes.
      const scripted = capture();
      scripted.interactive = false;
      const run = await tincanWith(scripted, ...argv, "--yes");
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/needs you to confirm it at a terminal/);

      // An AI agent's shell, even one with a terminal.
      const agent = atTerminal();
      agent.env = { ...agent.env, CLAUDECODE: "1" };
      const refused = await tincanWith(agent, ...argv);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/AI agent's shell \(\$CLAUDECODE is set\)/);
    }
    // Declining at the terminal changes nothing; --yes doesn't skip the question.
    const questions: string[] = [];
    const declined = await tincanWith(atTerminal(false, questions), ...agentSettings, "--yes");
    expect(declined).toMatchObject({ code: 1, stderr: "Cancelled" });
    expect(questions).toHaveLength(1);
    expect(JSON.parse((await tincan("settings", "get", "--json")).stdout).agents).toEqual(before);

    // Settings that aren't about agents are an ordinary change: --yes is enough in a script.
    const notAgents = capture();
    notAgents.interactive = false;
    expect(
      (await tincanWith(notAgents, "settings", "set", "--default-region", "US", "--yes")).code,
    ).toBe(0);
    const unconfirmed = await tincanWith(notAgents, "settings", "set", "--default-region", "US");
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toMatch(/pass --yes/);
  });

  it("refuses to send or change things from a script unless --yes", async () => {
    const scripted = capture();
    scripted.interactive = false;
    const send = await tincanWith(scripted, "send", "+15550100003", "From a script");
    expect(send.code).toBe(1);
    expect(send.stderr).toMatch(/Send this message to \+15550100003\? .*pass --yes/);
    const hide = await tincanWith(scripted, "agents", "hide", "tel:+15550100003");
    expect(hide.code).toBe(1);
    expect(hide.stderr).toMatch(/Hide tel:\+15550100003 from AI agents\? .*pass --yes/);
    expect((await tincanWith(scripted, "send", "+15550100003", "Scripted", "--yes")).code).toBe(0);
    // Queries never ask.
    expect((await tincanWith(scripted, "thread", "list")).code).toBe(0);
  });

  it("hides someone from agents from a script, but shows them again only at a terminal", async () => {
    const [thread] = (
      JSON.parse((await tincan("thread", "list", "--json")).stdout) as Thread[]
    ).filter((t) => t.kind === "direct");
    const key = thread!.key;
    const hiddenFromAgents = async () =>
      JSON.parse((await tincan("thread", "get", key, "--json")).stdout).thread.hiddenFromAgents;

    // Hiding narrows what agents see: an ordinary change, so --yes is enough in a script.
    const scripted = capture();
    scripted.interactive = false;
    const hidden = await tincanWith(scripted, "agents", "hide", key, "--yes");
    expect(hidden.code).toBe(0);
    expect(hidden.stdout).toMatch(/^Hid .* from AI agents, with every group they're in/);
    expect(await hiddenFromAgents()).toBe(true);
    const listed = await tincan("agents", "hidden");
    expect(listed.stdout).toMatch(/^People\n {2}.+ \((\d+ (numbers?|emails?)(, )?)+\) /);
    const [person] = JSON.parse((await tincan("agents", "hidden", "--json")).stdout).people;

    // Showing them again is a policy change: never from a script or an agent's shell.
    const show = ["agents", "show", person.id];
    const refused = await tincanWith(scripted, ...show, "--yes");
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toMatch(/needs you to confirm it at a terminal/);
    const agent = atTerminal();
    agent.env = { ...agent.env, CLAUDECODE: "1" };
    expect((await tincanWith(agent, ...show)).stderr).toMatch(/AI agent's shell/);
    // Nor can an agent's shell list or hide anyone: those are the user's.
    expect((await tincanWith(atTerminalAsAgent(), "agents", "hidden")).stderr).toMatch(
      /PERMISSION_DENIED|can only be used from the Tincan app/,
    );
    expect(await hiddenFromAgents()).toBe(true);

    // At a terminal it asks, whatever --yes says, naming who.
    const questions: string[] = [];
    const declined = await tincanWith(atTerminal(false, questions), ...show, "--yes");
    expect(declined).toMatchObject({ code: 1, stderr: "Cancelled" });
    expect(await hiddenFromAgents()).toBe(true);
    const shown = await tincanWith(atTerminal(true, questions), ...show, "--yes");
    expect(shown).toMatchObject({ code: 0, stdout: "AI agents can see them again" });
    expect(questions).toHaveLength(2);
    expect(questions[0]).toBe(questions[1]);
    expect(questions[0]).toMatch(
      new RegExp(`^Show ${person.label.replace(/[+()]/g, "\\$&")} to AI agents again\\?`),
    );
    expect(await hiddenFromAgents()).toBe(false);
  });

  it("takes values literally; only --<option>-file and --input @file read files", async () => {
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "file contents");
    const literal = await tincan("send", "+15550100004", `@${secret}`, "--yes", "--json");
    expect(literal.code).toBe(0);
    expect(JSON.parse(literal.stdout).message.body).toBe(`@${secret}`);

    const fromFile = await tincan("send", "+15550100004", "--text-file", secret, "--yes", "--json");
    expect(fromFile.code).toBe(0);
    expect(JSON.parse(fromFile.stdout).message.body).toBe("file contents");

    const both = await tincan("send", "+15550100004", "x", "--text-file", secret, "--yes");
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/not both/);

    const input = path.join(root, "input.json");
    await writeFile(input, JSON.stringify({ to: "+15550100004", text: "from json" }));
    const json = await tincan("message", "send", "--input", `@${input}`, "--yes", "--json");
    expect(JSON.parse(json.stdout).message.body).toBe("from json");

    const help = capture();
    await main(["send", "--help"], help);
    expect(help.out.join("\n")).toContain("--<option>-file");
  });

  it("fully redacts addresses, names and home directories in doctor --report", async () => {
    const io = capture();
    io.env = { ...io.env, HOME: "/home/alex" };
    io.system = {
      ...io.system!,
      probe: async () => ({
        ...facts,
        native: { loaded: false, version: null, error: "Cannot open /home/alex/x/tincan.node" },
        bluetooth: {
          adapters: [
            { address: "00:11:22:33:44:55", name: "alex-laptop", powered: true, class: 0x7c0408 },
          ],
          phones: [
            {
              address: "AA:BB:CC:DD:EE:FF",
              name: "Alex's\niPhone",
              paired: true,
              bonded: true,
              connected: false,
            },
          ],
        },
      }),
    };
    await main(["doctor", "--report", "--json", "--socket", path.join(root, "none", "x.sock")], io);
    const text = io.out.join("");
    expect(text).not.toMatch(/AA:BB|00:11|alex|Alex/);
    const report = JSON.parse(text) as { checks: { id: string; detail: string }[] };
    const detail = (id: string) => report.checks.find((c) => c.id === id)?.detail;
    expect(detail("phone")).toBe("iPhone (XX:XX:XX:XX:XX:XX) isn't connected");
    expect(detail("adapter")).toBe("adapter (XX:XX:XX:XX:XX:XX)");
    expect(detail("native")).toBe("Cannot open ~/x/tincan.node");
  });

  it("serves MCP over stdio without writing anything else to stdout", async () => {
    const io = capture();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    io.stdin = stdin;
    io.stdoutStream = stdout;
    const lines: string[] = [];
    let buffer = "";
    const waiters: (() => void)[] = [];
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        waiters.splice(0).forEach((w) => w());
      }
    });
    const request = async (id: number, method: string, params: unknown) => {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      for (;;) {
        const found = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (found) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    };

    const exit = main(["mcp", "--socket", socket], io);
    const init = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result.serverInfo.name).toBe("tincan");
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const tools = await request(2, "tools/list", {});
    const names = tools.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["status", "message_send", "thread_list"]));
    expect(names).not.toContain("settings_set");

    const status = await request(3, "tools/call", { name: "status", arguments: {} });
    expect(status.result.isError).toBeFalsy();
    expect(status.result.structuredContent.daemon.pid).toBe(process.pid);

    stdin.end();
    expect(await exit).toBe(0);
    expect(io.out).toEqual([]);
  });

  it("runs as an agent in an agent's shell, under the agent settings", async () => {
    const agentShell = () => {
      const io = capture();
      io.env = { ...io.env, CLAUDECODE: "1" };
      return io;
    };
    await tincanWith(atTerminal(), "settings", "set", "--access", "off");
    const off = await tincanWith(agentShell(), "threads");
    expect(off.code).toBe(1);
    expect(off.stderr).toContain(
      "tincan: running as Claude Code (agent shell detected); the AI agent settings in Tincan apply. To use your full CLI, run tincan from a normal terminal.",
    );
    expect(off.stderr).toContain("AI agents are turned off");
    // Status still works, as for any agent.
    expect((await tincanWith(agentShell(), "status")).code).toBe(0);

    await tincanWith(
      atTerminal(),
      "settings",
      "set",
      "--access",
      "assistant",
      "--agents-read",
      "all",
      "--agents-send",
      "approve",
    );
    const listed = await tincanWith(agentShell(), "threads", "--json");
    expect(listed.code).toBe(0);
    const threads = JSON.parse(listed.stdout) as { key: string }[];
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.every((t) => !/^(tel|email):/.test(t.key))).toBe(true);
    expect(listed.stdout).not.toMatch(/\+1555|tel:/);
    const human = await tincanWith(agentShell(), "threads");
    expect(human.stdout).toMatch(/^Ada Lovelace/m);
    expect(human.stdout).not.toMatch(/\+1555|\+1 \(555\)|tel:|email:/);
    // A conversation with no contact is its opaque ID, never the number behind it.
    expect(human.stdout).toMatch(/^handle:[\w-]+$/m);
    const humanVerbose = await tincanWith(agentShell(), "threads", "--verbose");
    expect(humanVerbose.stdout).toMatch(/^ {2}handle:[\w-]+ {2}/m);
    expect(humanVerbose.stdout).not.toMatch(/\+1555|\+1 \(555\)|tel:|email:/);
    // Senders by the names the agent may read; their handles stay opaque.
    const search = await tincanWith(agentShell(), "message", "search", "Saturday", "--verbose");
    expect(search.stdout).toMatch(/Ada Lovelace \(handle:[\w-]+\): Are we still on/);
    expect(search.stdout).not.toMatch(/\+1555|\+1 \(555\)|tel:/);
    const stranger = await tincanWith(agentShell(), "message", "search", "Names, not numbers");
    expect(stranger.stdout).toMatch(/You: Names, not numbers\n {2}handle:[\w-]+ {2}/);
    expect(stranger.stdout).not.toMatch(/\+1555|\+1 \(555\)|tel:/);
    // Internal commands stay out of reach, and so do the user's own commands list.
    const internal = await tincanWith(agentShell(), "message", "send-now", "x");
    expect(internal.stderr).toMatch(/can only be used from the Tincan app or the tincan CLI/);

    // A send is an agent send: queued for the user.
    const sent = await tincanWith(
      agentShell(),
      "send",
      "Ada Lovelace",
      "From the agent",
      "--yes",
      "--json",
    );
    expect(sent.code).toBe(0);
    const result = JSON.parse(sent.stdout);
    expect(result).toMatchObject({
      outcome: "queued",
      draft: { agentName: "Claude Code (CLI)", state: "queued" },
    });

    // The user sees it, and sends it from a terminal, which asks with the draft itself.
    const drafts = JSON.parse((await tincan("drafts", "--json")).stdout) as { id: string }[];
    expect(drafts.map((d) => d.id)).toContain(result.draft.id);
    const shown = await tincan("draft", "show", result.draft.id);
    expect(shown.stdout).toContain("Claude Code (CLI) → Ada Lovelace  [queued]");
    expect(shown.stdout).toContain("From the agent");
    expect((await tincan("drafts")).stdout).toContain("Claude Code (CLI) → Ada Lovelace  [queued]");
    expect((await tincan("drafts", "--verbose")).stdout).toContain(
      "Claude Code (CLI) → Ada Lovelace (tel:+15550100001)  [queued]",
    );
    const questions: string[] = [];
    const send = await tincanWith(atTerminal(true, questions), "draft", "send", result.draft.id);
    expect(send.code).toBe(0);
    expect(questions[0]).toMatch(
      /^Send Claude Code \(CLI\)'s draft to Ada Lovelace\? From the agent It waits 10s before going to your phone\.$/,
    );
    expect(send.stdout).toMatch(
      /^Sending in \d+s \((.+)\)\. Cancel with: tincan message cancel \1$/,
    );
    const id = /\((.+)\)/.exec(send.stdout)![1]!;
    const undo = await tincan("message", "cancel", id, "--requeue");
    expect(undo.stdout).toMatch(/^Cancelled; back in the queue as a draft/);
    const discard = await tincanWith(atTerminal(), "draft", "discard", result.draft.id);
    expect(discard.stdout).toBe(`Discarded Claude Code (CLI)'s draft (${result.draft.id})`);
    await tincanWith(atTerminal(), "settings", "set", "--access", "off");
  });

  it("warns before turning the agent send delay off", async () => {
    const questions: string[] = [];
    const io = atTerminal(false, questions);
    await tincanWith(io, "settings", "set", "--agents-send-delay-seconds", "0");
    expect(questions[0]).toContain(
      "With no agent send delay, an agent's message goes to your phone at once and you can't cancel it.",
    );
  });

  it("counts down a delayed send on one line, and Ctrl+C cancels it", async () => {
    await tincanWith(atTerminal(), "settings", "set", "--send-delay-seconds", "1", "--yes");
    const lines: string[] = [];
    const cancelled = atTerminal();
    cancelled.status = (line) => lines.push(line);
    cancelled.interrupted = () => new Promise((resolve) => setTimeout(resolve, 50));
    const stopped = await tincanWith(cancelled, "send", "+15550100005", "Never mind");
    expect(stopped.code).toBe(1);
    expect(lines[0]).toBe("Sending to +15550100005 in 1s… Ctrl+C to cancel");
    expect(stopped.stderr).toBe("Cancelled: it never reached your phone");
    expect(JSON.parse((await tincan("message", "search", "Never mind", "--json")).stdout)).toEqual(
      [],
    );

    const waited = atTerminal();
    waited.status = () => {};
    waited.interrupted = () => new Promise(() => {});
    const went = await tincanWith(waited, "send", "+15550100005", "Counted down");
    expect(went.code).toBe(0);
    expect(went.stdout).toMatch(/^Sent to your phone \(.+\)$/);

    // A script (or --json) returns at once and says how to cancel.
    const scripted = capture();
    scripted.interactive = false;
    const json = await tincanWith(scripted, "send", "+15550100005", "Later", "--yes", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "scheduled" });
    const plain = await tincanWith(scripted, "send", "+15550100005", "Later 2", "--yes");
    expect(plain.stdout).toMatch(/Cancel with: tincan message cancel /);
    await tincanWith(atTerminal(), "settings", "set", "--send-delay-seconds", "0", "--yes");
  });
});

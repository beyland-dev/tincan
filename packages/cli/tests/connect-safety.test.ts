import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { childEnv, installMcpConfig, writeFileAtomic, type Exec } from "../src/mcp-config.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "tincan-mcp-safety-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const launch = { command: "/usr/bin/node", args: ["/opt/tincan/bin.mjs", "mcp"] };
const old = { command: "/old/node", args: ["/old/bin.mjs", "mcp"] };

describe("writeFileAtomic", () => {
  it("keeps the file's mode, leaves no temp files and writes through symlinks", async () => {
    const file = path.join(home, "config.json");
    await writeFile(file, "{}\n");
    await chmod(file, 0o640);
    await writeFileAtomic(file, '{"a":1}\n');
    expect(await readFile(file, "utf8")).toBe('{"a":1}\n');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readdir(home)).toEqual(["config.json"]);

    const link = path.join(home, "link.json");
    await symlink(file, link);
    await writeFileAtomic(link, '{"b":2}\n');
    expect(await readFile(file, "utf8")).toBe('{"b":2}\n');
    expect((await stat(link)).isFile()).toBe(true);
    expect((await import("node:fs")).lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("creates new files privately", async () => {
    const file = path.join(home, "new", "config.json");
    await writeFileAtomic(file, "{}\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves the old contents when the write fails", async () => {
    const dir = path.join(home, "ro");
    await mkdir(dir);
    const file = path.join(dir, "config.json");
    await writeFile(file, "old\n");
    await chmod(dir, 0o500);
    try {
      await expect(writeFileAtomic(file, "new\n")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("old\n");
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe("--force through a client CLI", () => {
  async function claudeWith(entry: typeof old) {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { tincan: entry } }),
    );
  }

  it("puts the old entry back when adding the new one fails", async () => {
    await claudeWith(old);
    const calls: string[][] = [];
    const exec: Exec = (_command, args) => {
      calls.push(args);
      const failing = args[1] === "add" && args.includes(launch.command);
      return { status: failing ? 1 : 0, stdout: "", stderr: failing ? "boom" : "" };
    };
    await expect(
      installMcpConfig("claude", launch, { env: { HOME: home }, exec, force: true }),
    ).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("boom") });
    expect(calls.map((a) => a.slice(0, 2).join(" "))).toEqual(["mcp remove", "mcp add", "mcp add"]);
    expect(calls[2]).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "tincan",
      "--",
      old.command,
      ...old.args,
    ]);
  });

  it("says how to restore the old entry when that fails too", async () => {
    await claudeWith(old);
    const exec: Exec = (_command, args) => ({
      status: args[1] === "add" ? 1 : 0,
      stdout: "",
      stderr: "boom",
    });
    await expect(
      installMcpConfig("claude", launch, { env: { HOME: home }, exec, force: true }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("claude mcp add --scope user tincan -- /old/node"),
    });
  });
});

describe("childEnv", () => {
  it("drops ELECTRON_RUN_AS_NODE and keeps the rest", () => {
    expect(childEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});

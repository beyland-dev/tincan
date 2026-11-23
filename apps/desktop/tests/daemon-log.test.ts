import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { daemonLogPath, openDaemonLog, rotateDaemonLog } from "../src/main/daemon-log.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tincan-log-"));
  dirs.push(dir);
  return dir;
}

describe("daemon log", () => {
  it("lives under XDG_STATE_HOME, or ~/.local/state", () => {
    expect(daemonLogPath({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe(
      "/x/state/tincan/daemon.log",
    );
    expect(daemonLogPath({}, "/home/u")).toBe("/home/u/.local/state/tincan/daemon.log");
    expect(daemonLogPath({ XDG_STATE_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/state/tincan/daemon.log",
    );
  });

  it("is private, and moves an oversized log aside when opened", () => {
    const file = path.join(tempDir(), "state", "tincan", "daemon.log");
    let fd = openDaemonLog(file, 10);
    writeSync(fd, "0123456789abc\n");
    closeSync(fd);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    fd = openDaemonLog(file, 10);
    closeSync(fd);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("0123456789abc\n");
    expect(statSync(file).size).toBe(0);
  });

  it("rotates a log still being written by copying and emptying it", () => {
    const file = path.join(tempDir(), "daemon.log");
    writeFileSync(file, "x".repeat(20), { mode: 0o600 });
    expect(rotateDaemonLog(file, 100)).toBe(false);
    expect(rotateDaemonLog(file, 10)).toBe(true);
    expect(statSync(file).size).toBe(0);
    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(20);
    expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { main, type CliIO } from "../src/index.ts";

const SCENARIO = path.resolve(import.meta.dirname, "../../../fixtures/scenarios/unpaired.json");
let root: string;
let socket: string;
let stopDaemon: () => void;
let daemonExit: Promise<number>;

function capture(confirm?: (question: string) => Promise<boolean>) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const io: CliIO = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: process.cwd(),
    env: { HOME: root, TINCAN_FAKE_PHONE: SCENARIO },
    confirm: async (question) => {
      questions.push(question);
      return confirm ? confirm(question) : true;
    },
  };
  return { io, out, err, questions };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-pair-"));
  socket = path.join(root, "run", "tincan.sock");
  const { io } = capture();
  io.interrupted = () => new Promise<void>((resolve) => (stopDaemon = resolve));
  daemonExit = main(["daemon", "--socket", socket], io);
  for (let i = 0; i < 100; i++) {
    if ((await main(["version", "--socket", socket], capture().io)) === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("daemon did not start");
});

afterAll(async () => {
  stopDaemon?.();
  expect(await daemonExit).toBe(0);
  await rm(root, { recursive: true, force: true });
});

describe("tincan pair", () => {
  it("explains itself", async () => {
    const { io, out } = capture();
    expect(await main(["pair", "--help"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/Settings › Bluetooth/);
  });

  it("stops when the code is rejected, with what to try next", async () => {
    const { io, err, questions } = capture(async (q) => !q.startsWith("Does the iPhone show"));
    expect(await main(["pair", "--socket", socket], io)).toBe(1);
    expect(questions).toEqual(["Pair with Fake iPhone?", expect.stringMatching(/show 123456/)]);
    expect(err.join("\n")).toMatch(/declined[\s\S]*restart the iPhone/);
  });

  it("finds the iPhone, checks the code and pairs it", async () => {
    const { io, out, questions } = capture();
    expect(await main(["pair", "--socket", socket], io)).toBe(0);
    expect(questions).toEqual(["Pair with Fake iPhone?", expect.stringMatching(/show 123456/)]);
    const text = out.join("\n");
    expect(text).toMatch(/Searching for iPhones/);
    expect(text).toMatch(/Found Fake iPhone \(AA:BB:CC:DD:EE:02\)/);
    expect(text).not.toMatch(/hands-free/);
    expect(text).toMatch(/Paired with Fake iPhone/);

    const status = capture();
    for (let i = 0; i < 100; i++) {
      status.out.length = 0;
      await main(["status", "--json", "--socket", socket], status.io);
      if (JSON.parse(status.out.join("")).phone.state === "connected") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(status.out.join("")).phone).toMatchObject({ state: "connected" });
  });
});

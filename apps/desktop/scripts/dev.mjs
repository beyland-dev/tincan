// Run the app from source against a scripted fake phone: an isolated daemon on its own socket, the
// renderer's dev server (hot reload) and Electron. Nothing touches the real phone or store.
//
//   pnpm --filter @beyland/tincan-desktop dev [scenario.json] [-- electron flags…]
//   TINCAN_DEV_REAL=1 pnpm --filter @beyland/tincan-desktop dev   # use the user's daemon instead
//     (started from this checkout when none is running and `tincan` isn't on PATH)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");
const vp = path.join(desktopRoot, "node_modules/.bin/vp");
const real = process.env.TINCAN_DEV_REAL === "1";
const args = process.argv.slice(2).filter((a) => a !== "--");
const scenarioArg = args[0]?.startsWith("-") ? undefined : args.shift();
const electronArgs = args;
const scenario = path.resolve(
  scenarioArg ?? path.join(repoRoot, "fixtures/scenarios/busy-group.json"),
);

const children = [];
let stopping = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
  return child;
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) child.kill("SIGTERM");
  if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

function waitFor(check, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      if (await check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(attempt, 150);
    };
    void attempt();
  });
}

const canConnect = (target) =>
  new Promise((resolve) => {
    const socket = createConnection(target);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

let runtimeDir;
const env = { ...process.env };
if (!real) {
  if (!existsSync(scenario)) throw new Error(`No scenario at ${scenario}`);
  runtimeDir = await mkdtemp(path.join(tmpdir(), "tincan-desktop-dev-"));
  env.TINCAN_SOCKET = path.join(runtimeDir, "tincan.sock");
  run(process.execPath, [path.join(repoRoot, "packages/cli/src/bin.ts"), "daemon"], {
    cwd: repoRoot,
    env: { ...env, TINCAN_FAKE_PHONE: scenario },
  });
  await waitFor(() => canConnect(env.TINCAN_SOCKET), "the daemon");
  env.TINCAN_DESKTOP_NO_SPAWN = "1";
} else if (!process.env.TINCAN_DAEMON_COMMAND && !onPath("tincan")) {
  // With no `tincan` on PATH, start this checkout's daemon when none is running.
  env.TINCAN_DAEMON_COMMAND = process.execPath;
  env.TINCAN_DAEMON_ARGS = JSON.stringify([
    path.join(repoRoot, "packages/cli/src/bin.ts"),
    "daemon",
  ]);
}

function freePort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(freePort(port + 1)));
    server.listen({ port, host: "localhost" }, () => server.close(() => resolve(port)));
  });
}

function onPath(name) {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, name)));
}

await new Promise((resolve, reject) => {
  const pack = spawn(vp, ["pack"], { cwd: desktopRoot, stdio: "inherit" });
  pack.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("vp pack failed"))));
});
// 5174, or the next free port when another dev app (say a TINCAN_DEV_REAL one) already has it.
const port = await freePort(5174);
const devUrl = `http://localhost:${port}/`;
run(vp, ["dev", "--port", String(port)], { cwd: desktopRoot });
await waitFor(() => canConnect({ port, host: "localhost" }), "the dev server");
run(electron, [path.join(desktopRoot, "dist/main.mjs"), ...electronArgs], {
  cwd: desktopRoot,
  env: { ...env, TINCAN_DESKTOP_DEV_URL: devUrl },
});

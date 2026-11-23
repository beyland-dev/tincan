// Run the built app (`pnpm build` first). It connects to the user's daemon, starting
// `tincan daemon` (or $TINCAN_DAEMON_COMMAND) when none is running.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(electron, [path.join(desktopRoot, "dist/main.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

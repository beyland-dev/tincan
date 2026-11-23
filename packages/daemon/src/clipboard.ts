import { spawn } from "node:child_process";
import { TincanError } from "@beyland/tincan-protocol";
import { childEnv } from "./env.ts";

/**
 * Puts `text` on the desktop clipboard without a window: `wl-copy` under Wayland, else `xclip` or
 * `xsel` under X11. (A Wayland compositor without a data-control protocol, like GNOME's, gets a
 * brief invisible surface from `wl-copy`; it still works from the sandboxed service.) The text is
 * written to the tool's stdin, never its arguments, so it doesn't show in the process list.
 * `NOT_FOUND` when no tool is installed.
 */
export async function copyToClipboard(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const tools: Array<[string, ...string[][]]> = [];
  // Each tool's argument lists, most capable first: older wl-copy lacks --sensitive, which keeps
  // the code out of clipboard managers' history.
  if (env.WAYLAND_DISPLAY) tools.push(["wl-copy", ["--sensitive"], []]);
  if (env.DISPLAY) {
    tools.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
  }
  let missing = 0;
  for (const [command, ...variants] of tools) {
    for (const args of variants) {
      const result = await pipeTo(command, args, text, env);
      if (result === "ok") return;
      if (result === "missing") {
        missing++;
        break;
      }
    }
  }
  throw new TincanError(
    missing === tools.length ? "NOT_FOUND" : "INTERNAL",
    missing === tools.length
      ? "No clipboard tool found: install wl-clipboard (Wayland) or xclip (X11)"
      : "The clipboard tool failed",
  );
}

/** Runs `command` with `text` on stdin. These tools fork to serve the clipboard, so only the exit counts. */
function pipeTo(
  command: string,
  args: string[],
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<"ok" | "failed" | "missing"> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: childEnv(env), stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === "ENOENT" ? "missing" : "failed");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "ok" : "failed");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

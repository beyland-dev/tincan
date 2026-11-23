import { getContract, TincanError, type WireError } from "@beyland/tincan-protocol";
import { APP_HOST, APP_SCHEME } from "./protocol.ts";

export type Checked = { ok: true; input: unknown } | { ok: false; error: WireError };

/**
 * The daemon commands the app's own pages use, and nothing else: the window can't reach commands
 * it has no use for (agent-only or future ones) even if something in it misbehaves. Add a command
 * here when the renderer starts calling it.
 */
export const RENDERER_COMMANDS: ReadonlySet<string> = new Set([
  "agents.connect",
  "agents.connections",
  "agents.disconnect",
  "agents.hidden",
  "agents.hide",
  "agents.show",
  "contact.list",
  "contact.photo",
  "contact.sync",
  "device.connect",
  "device.disconnect",
  "device.forget",
  "device.history",
  "device.info",
  "device.pair.cancel",
  "device.pair.confirm",
  "device.pair.start",
  "device.pair.status",
  "doctor",
  "draft.discard",
  "draft.list",
  "draft.restore",
  "draft.send",
  "draft.update",
  "group.assignMessage",
  "group.save",
  "message.cancel",
  "message.delete",
  "message.draft.list",
  "message.draft.save",
  "message.list",
  "message.retry",
  "message.search",
  "message.send",
  "message.sendNow",
  "service.disable",
  "service.install",
  "service.status",
  "settings.get",
  "settings.set",
  "status",
  "sync.now",
  "thread.delete",
  "thread.get",
  "thread.list",
  "thread.markRead",
  "thread.mute",
  "thread.pin",
]);

/**
 * Checks a renderer request before it reaches the daemon: the command must be one the app's pages
 * use (`RENDERER_COMMANDS`) and its input must match the contract. `isTrustedUrl` keeps other
 * pages from getting here at all.
 */
export function checkRequest(name: unknown, input: unknown): Checked {
  if (typeof name !== "string") return fail("INVALID_INPUT", "Expected a command name");
  if (!RENDERER_COMMANDS.has(name)) {
    return getContract(name)
      ? fail("PERMISSION_DENIED", `The app doesn't use ${name}`)
      : fail("NOT_FOUND", `Unknown command ${name}`);
  }
  const contract = getContract(name);
  if (!contract) return fail("NOT_FOUND", `Unknown command ${name}`);
  const parsed = contract.input.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return fail("INVALID_INPUT", `${where}${issue?.message ?? "Invalid input"}`);
  }
  return { ok: true, input: parsed.data };
}

/** Whether a frame URL is one of Tincan's pages (`app://tincan/`, or the dev server when set). */
export function isTrustedUrl(url: string, devUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    if (devUrl) {
      const dev = new URL(devUrl);
      if (parsed.origin === dev.origin) return true;
    }
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.host === APP_HOST &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    );
  } catch {
    return false;
  }
}

/** `--thread=<key>` from a command line, if present. */
export function threadArg(argv: ReadonlyArray<string>): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--thread=")) return arg.slice("--thread=".length) || undefined;
  }
  return undefined;
}

export function toWireError(error: unknown): WireError {
  if (error instanceof TincanError) return error.toWire();
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

function fail(code: WireError["code"], message: string): Checked {
  return { ok: false, error: { code, message } };
}

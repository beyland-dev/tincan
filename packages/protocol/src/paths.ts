import { tmpdir, userInfo } from "node:os";
import path from "node:path";

export interface RuntimePaths {
  /** Directory holding the socket and lock; must be 0700 and owned by the user. */
  dir: string;
  socket: string;
  lock: string;
}

/**
 * `$TINCAN_SOCKET` if set (its directory holds the lock), else
 * `$XDG_RUNTIME_DIR/tincan/tincan.sock`, else a per-user directory in the temp dir.
 *
 * The temp-dir fallback is shared with other users, who could create `tincan-<uid>/` first. The
 * daemon refuses a directory it doesn't own or that others can reach (`ensureRuntimeDir`), and
 * clients check the directory and socket before connecting (`verifySocket` in the client).
 */
export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  if (env.TINCAN_SOCKET) {
    const socket = path.resolve(env.TINCAN_SOCKET);
    const dir = path.dirname(socket);
    return { dir, socket, lock: path.join(dir, "tincan.lock") };
  }
  const base = env.XDG_RUNTIME_DIR || path.join(tmpdir(), `tincan-${userInfo().uid}`);
  const dir = env.XDG_RUNTIME_DIR ? path.join(base, "tincan") : base;
  return { dir, socket: path.join(dir, "tincan.sock"), lock: path.join(dir, "tincan.lock") };
}

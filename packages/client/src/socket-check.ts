import { stat } from "node:fs/promises";
import path from "node:path";
import { TincanError } from "@beyland/tincan-protocol";

/**
 * Refuses a daemon socket that another user could have planted or can reach, before anything (like
 * message text) is sent to it. Without `$XDG_RUNTIME_DIR` the socket lives under the shared temp
 * dir, where another local user could pre-create `tincan-<uid>/` and listen on it.
 *
 * The socket's directory must be ours with no group/other permissions (the daemon creates it that
 * way, and refuses any other), and the socket must be a socket we own. These hold for an explicit
 * `$TINCAN_SOCKET` too: the daemon enforces the same rules there, so a socket that fails them was
 * not made by a Tincan daemon running as us. Symlinks are followed: whatever they point at must
 * pass the same checks, and only we can write into a private directory.
 *
 * A missing directory or socket is `NOT_CONNECTED` (nothing is running); anything else that fails
 * is `PERMISSION_DENIED`.
 */
export async function verifySocket(socketPath: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const dir = path.dirname(socketPath);
  const dirStat = await statOrMissing(dir, socketPath);
  if (!dirStat.isDirectory()) {
    throw new TincanError("PERMISSION_DENIED", `${dir} is not a directory`);
  }
  if (dirStat.uid !== uid) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Refusing the Tincan socket in ${dir}: the directory is owned by another user (uid ${dirStat.uid}). Someone else may have created it; remove it, or set XDG_RUNTIME_DIR or TINCAN_SOCKET.`,
    );
  }
  if ((dirStat.mode & 0o077) !== 0) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Refusing the Tincan socket in ${dir}: the directory must only be accessible by you (mode is ${(dirStat.mode & 0o777).toString(8)}; run chmod 700 ${dir}).`,
    );
  }
  const socketStat = await statOrMissing(socketPath, socketPath);
  if (!socketStat.isSocket()) {
    throw new TincanError("PERMISSION_DENIED", `${socketPath} is not a socket`);
  }
  if (socketStat.uid !== uid) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `Refusing ${socketPath}: the socket is owned by another user (uid ${socketStat.uid}).`,
    );
  }
}

async function statOrMissing(file: string, socketPath: string) {
  try {
    return await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notRunning(socketPath);
    throw new TincanError("PERMISSION_DENIED", `Can't check ${file}: ${(error as Error).message}`);
  }
}

export function notRunning(socketPath: string): TincanError {
  return new TincanError(
    "NOT_CONNECTED",
    `The Tincan daemon is not running (no socket at ${socketPath}). Start it with \`tincan daemon\`.`,
  );
}

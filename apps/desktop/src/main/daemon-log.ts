import {
  chmodSync,
  closeSync,
  copyFileSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Past this size the log moves aside to `daemon.log.1` (one old copy is kept). */
export const DAEMON_LOG_MAX_BYTES = 5_000_000;

/**
 * Where a daemon the app starts writes its output: `$XDG_STATE_HOME/tincan/daemon.log`, by default
 * `~/.local/state/tincan/daemon.log`. The daemon logs ids and counts, never message text, numbers
 * or names, so the file holds no personal data; it is still private to the user.
 */
export function daemonLogPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const state = env.XDG_STATE_HOME;
  const base = state && path.isAbsolute(state) ? state : path.join(home, ".local", "state");
  return path.join(base, "tincan", "daemon.log");
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Opens the log for appending (creating its folder 0700 and the file 0600), moving an oversized
 * one aside first. Returns the descriptor to hand the daemon as stdout and stderr.
 */
export function openDaemonLog(file: string, maxBytes = DAEMON_LOG_MAX_BYTES): number {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (sizeOf(file) > maxBytes) renameSync(file, `${file}.1`);
  const fd = openSync(file, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Keeps a log that a running daemon is still writing under the cap: copies it to `daemon.log.1`
 * and empties it in place. The daemon opened it for appending, so its next line lands at the
 * start of the emptied file. Returns whether it rotated.
 */
export function rotateDaemonLog(file: string, maxBytes = DAEMON_LOG_MAX_BYTES): boolean {
  if (sizeOf(file) <= maxBytes) return false;
  try {
    copyFileSync(file, `${file}.1`);
    chmodSync(`${file}.1`, 0o600);
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

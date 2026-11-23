import { randomBytes } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import net from "node:net";
import { TincanError } from "@beyland/tincan-protocol";

/** Create the runtime directory (0700) and refuse to use one that others can reach. */
export async function ensureRuntimeDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory()) {
    throw new TincanError("PERMISSION_DENIED", `${dir} is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new TincanError("PERMISSION_DENIED", `${dir} is owned by another user (uid ${stat.uid})`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new TincanError(
      "PERMISSION_DENIED",
      `${dir} must only be accessible by you (mode is ${(stat.mode & 0o777).toString(8)}; run chmod 700 ${dir})`,
    );
  }
}

/** Reads `/proc/<pid>/cmdline` as argv; null when it can't be read. */
export type ReadCmdline = (pid: number) => Promise<string[] | null>;

const procCmdline: ReadCmdline = async (pid) => {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return null;
  }
};

/**
 * Whether `pid` may be a running Tincan daemon. The lock lives in a directory only we can write, so
 * its owner ran as us: a pid that belongs to another user (EPERM) was reused. A live pid of ours
 * counts unless its command line clearly isn't Tincan's (`tincan`, the AppImage or `.deb` bundle, or
 * a `daemon` argument); one we can't read counts, to be safe.
 */
async function mayBeDaemon(pid: number, readCmdline: ReadCmdline): Promise<boolean> {
  if (pid === process.pid) return false; // Held locks in this process are tracked in `heldLocks`.
  try {
    process.kill(pid, 0);
  } catch {
    return false; // ESRCH: gone. EPERM: another user's process.
  }
  const argv = await readCmdline(pid);
  if (argv === null) return true;
  return argv.some((arg) => /tincan/i.test(arg) || arg === "daemon");
}

/** Whether something answers on `socketPath`. Only a refused or missing socket counts as dead. */
export function socketAnswers(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    // A daemon that accepts but is too busy to answer still holds the socket.
    const timer = setTimeout(() => done(true), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
    );
  });
}

export interface LockOptions {
  /** The daemon's socket: a lock is only stale while nothing answers on it. */
  socket?: string;
  /** Replaces `/proc/<pid>/cmdline` (tests). */
  readCmdline?: ReadCmdline;
}

const heldLocks = new Set<string>();

/**
 * A lock file held open. While it's open its inode can't be freed, so no other file can have its
 * `(dev, ino)`: a path with that identity is this very file.
 */
interface OpenLock {
  pid: number;
  ino: number;
  dev: number;
  handle: FileHandle;
}

function notAFile(lockPath: string): TincanError {
  return new TincanError("CONFLICT", `${lockPath} exists and is not a regular file`);
}

/** Opens the lock file and reads its pid and identity from the same open file; null when absent. */
async function openLock(lockPath: string): Promise<OpenLock | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw notAFile(lockPath);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notAFile(lockPath);
    const text = await handle.readFile("utf8");
    return { pid: Number.parseInt(text, 10), ino: stat.ino, dev: stat.dev, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Whether `lockPath` currently names the file `lock` holds open. */
async function stillAt(lockPath: string, lock: OpenLock): Promise<boolean> {
  const stat = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return stat !== null && stat.ino === lock.ino && stat.dev === lock.dev;
}

/** Writes our pid in full under a fresh temporary name next to the lock. */
async function writeTemp(lockPath: string): Promise<string> {
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}`;
  await writeFile(temp, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  return temp;
}

/**
 * Take the single-instance lock. The lock file is written in full under a temporary name and then
 * hard-linked into place, so it never exists half-written and only one of several racing daemons
 * can create it. A lock is stale when its pid isn't a live Tincan daemon of ours *and* nothing
 * answers on the socket; a stale lock is replaced only under the takeover token (see `takeToken`),
 * so of several daemons that judged the same lock stale exactly one replaces it.
 */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  if (heldLocks.has(lockPath)) {
    throw new TincanError("BUSY", `A Tincan daemon is already running in this process`, {
      pid: process.pid,
    });
  }
  heldLocks.add(lockPath);
  const readCmdline = options.readCmdline ?? procCmdline;
  try {
    const mine = await createLock(lockPath, options.socket, readCmdline);
    return async () => {
      heldLocks.delete(lockPath);
      try {
        await releaseLock(lockPath, mine, readCmdline).catch(() => {});
      } finally {
        await mine.handle.close().catch(() => {});
      }
    };
  } catch (error) {
    heldLocks.delete(lockPath);
    throw error;
  }
}

async function createLock(
  lockPath: string,
  socket: string | undefined,
  readCmdline: ReadCmdline,
): Promise<OpenLock> {
  const temp = await writeTemp(lockPath);
  try {
    const own = await lstat(temp);
    for (let attempt = 0; attempt < 3; attempt++) {
      let taken = false;
      try {
        await link(temp, lockPath);
        taken = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!taken) {
        const existing = await openLock(lockPath);
        if (!existing) continue; // Removed meanwhile: try again.
        try {
          const pid = existing.pid;
          const valid = Number.isInteger(pid) && pid > 0;
          if (valid && (await mayBeDaemon(pid, readCmdline))) {
            throw new TincanError("BUSY", `Another Tincan daemon is already running (pid ${pid})`, {
              pid,
            });
          }
          if (socket && (await socketAnswers(socket))) {
            throw new TincanError(
              "BUSY",
              `Another Tincan daemon is already running (it answers on ${socket})`,
              valid ? { pid } : undefined,
            );
          }
          taken = await takeOver(lockPath, temp, existing, readCmdline);
        } finally {
          await existing.handle.close();
        }
        if (!taken) continue; // Replaced meanwhile: look at the new one.
      }
      const created = await openLock(lockPath);
      if (created && created.ino === own.ino && created.dev === own.dev) return created;
      await created?.handle.close();
      throw new TincanError("BUSY", `Could not take the daemon lock ${lockPath}`);
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
  throw new TincanError("BUSY", `Could not take the daemon lock ${lockPath}`);
}

/** How many takeover tokens left behind by dead holders are skipped before giving up. */
const TOKEN_GENERATIONS = 16;

interface Token {
  path: string;
  /** Tokens below this one whose holders were dead, removed once the lock has been replaced. */
  dead: string[];
}

async function readPid(file: string): Promise<number | null> {
  try {
    return Number.parseInt(await readFile(file, "utf8"), 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Take the takeover token, `<lock>.takeover.<n>`: only its holder may replace or remove the lock
 * file. It's created by hard-linking `temp` (our pid, written in full), so only one process gets
 * it and it's never seen half-written. A live holder makes us BUSY: it's taking over or releasing
 * the lock. A token whose holder died is left alone (removing it by name could remove a newer one
 * instead) and the next `<n>` is tried; dead ones are cleaned up after the next takeover.
 */
async function takeToken(lockPath: string, temp: string, readCmdline: ReadCmdline): Promise<Token> {
  const dead: string[] = [];
  for (let gen = 0; gen < TOKEN_GENERATIONS; gen++) {
    const token = `${lockPath}.takeover.${gen}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await link(temp, token);
        return { path: token, dead };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readPid(token);
      if (holder === null && attempt < 2) continue; // Released meanwhile: try again.
      const valid = holder !== null && Number.isInteger(holder) && holder > 0;
      if (
        holder === null ||
        (valid && (holder === process.pid || (await mayBeDaemon(holder, readCmdline))))
      ) {
        throw new TincanError(
          "BUSY",
          `Another Tincan daemon is taking over the lock${valid ? ` (pid ${holder})` : ""}`,
          valid ? { pid: holder } : undefined,
        );
      }
      dead.push(token);
      break;
    }
  }
  throw new TincanError("BUSY", `Could not take the daemon lock ${lockPath}`);
}

/**
 * Replaces the stale lock (held open as `stale`) with `temp`; false when it was replaced or removed
 * in the meantime. Under the token nothing else replaces or removes the lock, and `stale` being
 * open means no other file can have its inode, so if the path still has it the path still is the
 * stale lock until our `rename` atomically puts ours in its place: the lock path is never empty.
 */
async function takeOver(
  lockPath: string,
  temp: string,
  stale: OpenLock,
  readCmdline: ReadCmdline,
): Promise<boolean> {
  const token = await takeToken(lockPath, temp, readCmdline);
  try {
    if (!(await stillAt(lockPath, stale))) return false;
    await rename(temp, lockPath);
    // The lock they guarded is gone, so a holder that comes along now can't mistake it for live.
    for (const dead of token.dead) await unlink(dead).catch(() => {});
    return true;
  } finally {
    await unlink(token.path).catch(() => {});
  }
}

/** Removes our lock, under the token so it can't race a takeover; leaves a successor's alone. */
async function releaseLock(
  lockPath: string,
  mine: OpenLock,
  readCmdline: ReadCmdline,
): Promise<void> {
  const temp = await writeTemp(lockPath);
  try {
    const token = await takeToken(lockPath, temp, readCmdline);
    try {
      if (await stillAt(lockPath, mine)) await unlink(lockPath);
    } finally {
      await unlink(token.path).catch(() => {});
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Identifies the socket file this daemon created, so shutdown removes only its own. */
export interface SocketIdentity {
  ino: number;
  dev: number;
}

/**
 * Remove a socket left behind by a previous daemon. Call only while holding the lock. Refuses one
 * that still answers, in case a daemon is running without its lock file.
 */
export async function removeStaleSocket(socketPath: string): Promise<void> {
  const stat = await lstat(socketPath).catch(() => undefined);
  if (!stat) return;
  if (!stat.isSocket()) {
    throw new TincanError("CONFLICT", `${socketPath} exists and is not a socket`);
  }
  if (await socketAnswers(socketPath)) {
    throw new TincanError(
      "BUSY",
      `Another Tincan daemon is already running (it answers on ${socketPath})`,
    );
  }
  await unlink(socketPath);
}

export async function socketIdentity(socketPath: string): Promise<SocketIdentity | null> {
  const stat = await lstat(socketPath).catch(() => null);
  return stat ? { ino: stat.ino, dev: stat.dev } : null;
}

/** Unlink `socketPath` only if it is still the socket this daemon created. */
export async function removeOwnSocket(
  socketPath: string,
  own: SocketIdentity | null,
): Promise<void> {
  if (!own) return;
  const current = await socketIdentity(socketPath);
  if (current && current.ino === own.ino && current.dev === own.dev) {
    await unlink(socketPath).catch(() => {});
  }
}

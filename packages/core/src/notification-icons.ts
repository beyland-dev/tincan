import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TincanError } from "@beyland/tincan-protocol";

/** Icon files start with this, so leftovers can be told from the folder's other files. */
const PREFIX = "notify-icon-";
const LEFTOVER = /^notify-icon-[0-9a-f]+\.(jpg|png|gif|webp)$/;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Servers read the icon when they show the notification; this is long enough to cover that. */
const DEFAULT_LIFETIME_MS = 5 * 60_000;

/**
 * `$XDG_RUNTIME_DIR/tincan`: Tincan's private runtime folder, in RAM, which also holds its socket
 * and Bluetooth transfers. Null without `XDG_RUNTIME_DIR`: there's no folder in RAM to use, and
 * a temp folder may be on disk.
 */
export function runtimeIconDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "tincan") : null;
}

export interface NotificationIconsOptions {
  /** How long an icon file stays at most (default 5 min). */
  lifetimeMs?: number;
  /** Failures it recovered from. Never photo data or paths. */
  onError?: (context: string, error: unknown) => void;
}

/**
 * Contact photos as short-lived files, since notification servers take an icon as a path. Each
 * is written `0600` into Tincan's private runtime folder (in RAM, `0700`, the user's own, checked
 * before each write as for Bluetooth transfers) and removed by `release` (its notification closed
 * or was replaced), after `lifetimeMs`, or by `clear` at shutdown. Leftovers from a run that
 * didn't clean up are removed on `open`. Without a usable folder there are no icons: photos are
 * never written to disk.
 */
export class NotificationIcons {
  readonly #dir: string | null;
  readonly #lifetimeMs: number;
  readonly #onError: (context: string, error: unknown) => void;
  /** Files written and not yet removed, with the timer that removes them. */
  readonly #files = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(dir: string | null, options: NotificationIconsOptions) {
    this.#dir = dir;
    this.#lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.#onError = options.onError ?? (() => {});
  }

  /** Icons in `dir` (see `runtimeIconDir`), after removing leftovers there. Null: no icons. */
  static open(dir: string | null, options: NotificationIconsOptions = {}): NotificationIcons {
    const icons = new NotificationIcons(dir, options);
    if (dir) {
      try {
        ensurePrivateDir(dir);
        for (const name of readdirSync(dir)) {
          if (LEFTOVER.test(name)) rmSync(join(dir, name), { force: true });
        }
      } catch (error) {
        icons.#onError("notify.icons", error);
      }
    }
    return icons;
  }

  /** Writes `photo` and returns its `file://` URI; null when it can't be written in RAM. */
  write(photo: { mediaType: string; data: Uint8Array }): string | null {
    const dir = this.#dir;
    const extension = EXTENSIONS[photo.mediaType];
    if (!dir || !extension) return null;
    let path: string | null = null;
    try {
      ensurePrivateDir(dir);
      path = join(dir, `${PREFIX}${randomBytes(12).toString("hex")}.${extension}`);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, photo.data);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (path) rmSync(path, { force: true });
      this.#onError("notify.icon", error);
      return null;
    }
    const timer = setTimeout(() => this.#remove(path), this.#lifetimeMs);
    timer.unref?.();
    this.#files.set(path, timer);
    return pathToFileURL(path).href;
  }

  /** Removes the file behind a URI `write` returned. */
  release(uri: string): void {
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      return;
    }
    if (this.#files.has(path)) this.#remove(path);
  }

  /** Removes every file still there. */
  clear(): void {
    for (const path of this.#files.keys()) this.#remove(path);
  }

  #remove(path: string): void {
    const timer = this.#files.get(path);
    if (timer) clearTimeout(timer);
    this.#files.delete(path);
    try {
      rmSync(path, { force: true });
    } catch (error) {
      this.#onError("notify.icon", error);
    }
  }
}

/** Creates `dir` (0700) and refuses one that isn't a directory of the user's own only they reach. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new TincanError("PERMISSION_DENIED", "Not a directory");
  const uid = process.geteuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new TincanError("PERMISSION_DENIED", "Owned by another user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new TincanError("PERMISSION_DENIED", "Must have mode 0700");
  }
}

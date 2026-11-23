import path from "node:path";

/**
 * The renderer is served from `app://tincan/` rather than `file://`, so the page has an origin of
 * its own: CSP's 'self' and the IPC sender checks match only Tincan's files, not every file on
 * disk. Registered as standard and secure before the app is ready (see main/index.ts).
 */
export const APP_SCHEME = "app";
export const APP_HOST = "tincan";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** The Content-Type for a renderer file; null for a kind of file the renderer never ships. */
export function mimeType(file: string): string | null {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? null;
}

/**
 * The file under `root` an `app://tincan/...` URL names, or null when it names anything else:
 * another scheme or host, a path that climbs out of `root` (`..`, encoded or not), an encoded
 * slash, backslash or NUL, or a file type the renderer doesn't ship.
 */
export function resolveAppPath(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const raw = parsed.pathname;
  // Encoded separators and NUL would let a "segment" smuggle a path of its own.
  if (/%(?:2f|5c|00)/i.test(raw) || raw.includes("\\")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return null;
  const relative = segments.length === 0 ? "index.html" : segments.join("/");
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return null;
  if (!mimeType(file)) return null;
  return file;
}

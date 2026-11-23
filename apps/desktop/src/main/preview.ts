import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { LinkPreview, SocialPost } from "../shared/bridge.ts";
import { SizedLru } from "../shared/lru.ts";

/** How long a connection may sit idle. */
const IDLE_TIMEOUT_MS = 5_000;
/** How long one fetch may take altogether, redirects and body included. */
const FETCH_DEADLINE_MS = 8_000;
/** How long one preview may take altogether (a Bluesky post fetches several things). */
const PREVIEW_DEADLINE_MS = 15_000;
/** Previews fetched at once; the rest wait their turn. */
const MAX_CONCURRENT = 4;
const MAX_HTML = 1_000_000;
const MAX_IMAGE = 2_000_000;
const MAX_GIF = 5_000_000;
const MAX_JSON = 1_000_000;
const MAX_REDIRECTS = 3;
/** Images bigger than this (in pixels) aren't decoded at all: a small file can unpack to gigabytes. */
const MAX_PIXELS = 16_000_000;
/** Still images wider or taller than this are scaled down before they reach the renderer. */
const MAX_DIMENSION = 960;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/**
 * An ordinary browser's User-Agent, so a site can't tell (or log) that the visitor is Tincan
 * reading a message.
 */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Addresses a preview must never reach: this machine, the local network and other non-public ranges. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  // The 6to4 relay anycast block (deprecated).
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible block (::a.b.c.d).
  ["::", 96],
  // IPv4-translated (::ffff:0:a.b.c.d).
  ["::ffff:0:0:0", 96],
  // NAT64 (they embed an IPv4 address, which may be a private one).
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  // IETF protocol assignments: Teredo (2001::/32), benchmarking, ORCHID and the like.
  ["2001::", 23],
  ["2001:db8::", 32],
  // 6to4 (embeds an IPv4 address).
  ["2002::", 16],
  // Documentation (RFC 9637) and SRv6 SIDs (RFC 9602).
  ["3fff::", 20],
  ["5f00::", 16],
  // Unique local, link-local, site-local (deprecated) and multicast.
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) would dodge the IPv4 rules.
  if (family === 6 && new URL(`http://[${address}]/`).hostname.startsWith("[::ffff:")) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Resolves a host and refuses non-public answers, so a DNS answer can't point a fetch inward. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    const usable = addresses.filter((a) => isPublicAddress(a.address));
    if (usable.length === 0 || usable.length !== addresses.length) {
      return callback(new Error("Refusing a non-public address"), "", 0);
    }
    if (options.all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
    const first = usable[0]!;
    callback(null, first.address, first.family);
  });
};

/** An http(s) link the user may open in their browser. */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A link a card may show (never fetched): http(s), without credentials, and a literal IP host only
 * when it's public.
 */
function linkUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicAddress(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  return url;
}

/**
 * What previews may fetch: https URLs only, so neither the link nor what's fetched for it can be
 * read or changed on the way, and a literal IP host only when it's public. A plain http link gets
 * no preview; it stays clickable.
 */
export function allowedUrl(raw: string): URL | null {
  const url = linkUrl(raw);
  return url?.protocol === "https:" ? url : null;
}

interface Fetched {
  url: URL;
  type: string;
  body: Buffer;
}

function get(
  url: URL,
  accept: string,
  limit: number,
  signal: AbortSignal,
): Promise<Fetched | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const request = https.get(
      url,
      {
        lookup: publicLookup,
        timeout: IDLE_TIMEOUT_MS,
        signal,
        headers: {
          accept,
          "user-agent": USER_AGENT,
          "accept-language": "en",
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          let next: URL;
          try {
            next = new URL(response.headers.location, url);
          } catch {
            resolve(null);
            return;
          }
          resolve({
            url: next,
            type: "redirect",
            body: Buffer.alloc(0),
          });
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        const type = (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            // HTML past the cap is cut off (the head is what matters); an image is dropped.
            if (type.startsWith("image/")) {
              request.destroy();
              resolve(null);
              return;
            }
            chunks.push(chunk.subarray(0, chunk.length - (size - limit)));
            request.destroy();
            resolve({ url, type, body: Buffer.concat(chunks) });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ url, type, body: Buffer.concat(chunks) }));
        response.on("error", () => resolve(null));
        // Cut off part way (the deadline passed): whatever arrived isn't the whole thing.
        response.on("close", () => resolve(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/**
 * Follows up to a few redirects, checking every hop and refusing to drop from https to http. The
 * whole chain shares one deadline, as well as the preview's own.
 */
async function fetchFollowing(
  raw: string,
  accept: string,
  limit: number,
  signal: AbortSignal,
): Promise<Fetched | null> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(FETCH_DEADLINE_MS)]);
  let url = allowedUrl(raw);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    const fetched = await get(url, accept, limit, deadline);
    if (!fetched || fetched.type !== "redirect") return fetched;
    url = allowedRedirect(url, fetched.url.href);
  }
  return null;
}

/** Where a redirect may go: anywhere `allowedUrl` allows, so never from https down to http. */
export function allowedRedirect(from: URL, to: string): URL | null {
  const next = allowedUrl(to);
  if (!next) return null;
  if (from.protocol === "https:" && next.protocol !== "https:") return null;
  return next;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const value = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** The preview a page describes in its Open Graph tags (or its title), without the image fetched. */
export function parsePreview(
  html: string,
  pageUrl: string,
): (LinkPreview & { imageUrl?: string }) | null {
  const head = html.slice(0, MAX_HTML);
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name"))?.toLowerCase();
    const content = attribute(tag, "content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag, 200);
  if (!title) return null;
  const preview: LinkPreview & { imageUrl?: string } = { url: pageUrl, title };
  const description = clean(
    meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"),
    300,
  );
  if (description) preview.description = description;
  const siteName = clean(meta.get("og:site_name"), 80);
  if (siteName) preview.siteName = siteName;
  const image = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image");
  if (image) {
    try {
      const resolved = new URL(decodeEntities(image.trim()), pageUrl);
      // Only https images: an http one is dropped, and the card shows without it.
      if (resolved.protocol === "https:") preview.imageUrl = resolved.href;
    } catch {
      // A malformed image URL: show the card without one.
    }
    const width = Number(meta.get("og:image:width"));
    const height = Number(meta.get("og:image:height"));
    if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
      preview.imageWidth = Math.round(width);
      preview.imageHeight = Math.round(height);
    }
  }
  return preview;
}

/** Previews by URL, capped by count and by the size of what they hold (mostly image data). */
const cache = new SizedLru<Promise<LinkPreview | null>>({
  maxEntries: 200,
  maxSize: 48_000_000,
});

async function load(raw: string, signal: AbortSignal): Promise<LinkPreview | null> {
  const special = await loadSpecial(raw, signal).catch(() => null);
  if (special) return special;
  if (signal.aborted) return null;
  const page = await fetchFollowing(raw, "text/html,application/xhtml+xml", MAX_HTML, signal);
  if (!page || !(page.type === "text/html" || page.type === "application/xhtml+xml")) return null;
  const parsed = parsePreview(page.body.toString("utf8"), page.url.href);
  if (!parsed) return null;
  const { imageUrl, ...preview } = parsed;
  preview.url = raw;
  if (imageUrl) {
    const image = await imageData(imageUrl, signal);
    if (image) preview.image = image;
  }
  return preview;
}

/**
 * Scales a still image down (Electron's `nativeImage` in the app; tests run without one). Returns
 * null to keep the original.
 */
export type ImageResizer = (
  body: Buffer,
  type: string,
  maxDimension: number,
) => { body: Buffer; type: string } | null;

let resizer: ImageResizer | null = null;

export function setImageResizer(resize: ImageResizer | null): void {
  resizer = resize;
}

async function imageData(
  url: string,
  signal: AbortSignal,
  limit = MAX_IMAGE,
): Promise<string | undefined> {
  const image = await fetchFollowing(url, "image/*", limit, signal);
  if (!image || !IMAGE_TYPES.has(image.type) || image.body.length === 0) return undefined;
  const fitted = fitImage(image.body, image.type);
  if (!fitted) return undefined;
  return `data:${fitted.type};base64,${fitted.body.toString("base64")}`;
}

/**
 * An image ready for a card: refused when its header doesn't give a sane size (or it's a pixel
 * bomb), and scaled down when it's a large still image.
 */
export function fitImage(body: Buffer, type: string): { body: Buffer; type: string } | null {
  const size = imageSize(body, type);
  if (!size || size.width * size.height > MAX_PIXELS) return null;
  if (type === "image/gif" || Math.max(size.width, size.height) <= MAX_DIMENSION) {
    return { body, type };
  }
  try {
    const scaled = resizer?.(body, type, MAX_DIMENSION);
    if (scaled && scaled.body.length > 0 && scaled.body.length < body.length) return scaled;
  } catch {
    // Couldn't decode it: keep the original, which is within the byte cap.
  }
  return { body, type };
}

/** An image's pixel size from its header, without decoding it. Null when it can't be read. */
export function imageSize(body: Buffer, type: string): { width: number; height: number } | null {
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  try {
    switch (type) {
      case "image/png":
        if (body.length < 24 || body.toString("latin1", 12, 16) !== "IHDR") return null;
        return ok(body.readUInt32BE(16), body.readUInt32BE(20));
      case "image/gif":
        if (body.length < 10 || body.toString("latin1", 0, 3) !== "GIF") return null;
        return ok(body.readUInt16LE(6), body.readUInt16LE(8));
      case "image/webp": {
        if (body.length < 30 || body.toString("latin1", 8, 12) !== "WEBP") return null;
        const chunk = body.toString("latin1", 12, 16);
        if (chunk === "VP8 ") {
          return ok(body.readUInt16LE(26) & 0x3fff, body.readUInt16LE(28) & 0x3fff);
        }
        if (chunk === "VP8L") {
          const bits = body.readUInt32LE(21);
          return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        if (chunk === "VP8X") return ok(body.readUIntLE(24, 3) + 1, body.readUIntLE(27, 3) + 1);
        return null;
      }
      case "image/jpeg": {
        if (body[0] !== 0xff || body[1] !== 0xd8) return null;
        let at = 2;
        while (at + 9 < body.length) {
          if (body[at] !== 0xff) return null;
          const marker = body[at + 1]!;
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return ok(body.readUInt16BE(at + 7), body.readUInt16BE(at + 5));
          }
          at += 2 + body.readUInt16BE(at + 2);
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const fetched = await fetchFollowing(url, "application/json", MAX_JSON, signal);
  if (!fetched || !fetched.type.includes("json")) return null;
  try {
    return JSON.parse(fetched.body.toString("utf8"));
  } catch {
    return null;
  }
}

/** Sites with their own card; null falls back to the page's Open Graph tags. */
function loadSpecial(raw: string, signal: AbortSignal): Promise<LinkPreview | null> {
  const url = allowedUrl(raw);
  if (!url) return Promise.resolve(null);
  const special = specialLink(url);
  if (!special) return Promise.resolve(null);
  switch (special.kind) {
    case "giphy":
      return loadGiphy(raw, special.id, signal);
    case "youtube":
      return loadYouTube(raw, special.id, signal, special.start);
    case "bluesky":
      return loadBluesky(raw, special.actor, special.rkey, signal);
  }
}

export type SpecialLink =
  | { kind: "giphy"; id: string }
  | { kind: "youtube"; id: string; start?: number }
  | { kind: "bluesky"; actor: string; rkey: string };

/** Recognises the links Tincan draws its own cards for. */
export function specialLink(url: URL): SpecialLink | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "giphy.com" && (parts[0] === "gifs" || parts[0] === "embed") && parts[1]) {
    const id = /(?:^|-)([A-Za-z0-9]{6,})$/.exec(parts[1])?.[1];
    return id ? { kind: "giphy", id } : null;
  }
  if (/^media\d*\.giphy\.com$/.test(host) && parts[0] === "media") {
    // media.giphy.com/media/<id>/giphy.gif, or /media/v1.<token>/<id>/giphy.gif
    const id = parts.find((p, i) => i > 0 && /^[A-Za-z0-9]{6,}$/.test(p) && !p.includes("."));
    return id ? { kind: "giphy", id } : null;
  }
  const youtubeId = (value: string | undefined) =>
    value && /^[\w-]{11}$/.test(value) ? value : undefined;
  let videoId: string | undefined;
  if (host === "youtu.be") videoId = youtubeId(parts[0]);
  else if (
    host === "youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com"
  ) {
    if (parts[0] === "watch") videoId = youtubeId(url.searchParams.get("v") ?? undefined);
    else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? ""))
      videoId = youtubeId(parts[1]);
  }
  if (videoId) {
    const start = youtubeStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
    return start ? { kind: "youtube", id: videoId, start } : { kind: "youtube", id: videoId };
  }
  if (
    host === "bsky.app" &&
    parts[0] === "profile" &&
    parts[2] === "post" &&
    parts[1] &&
    parts[3]
  ) {
    const actor = decodeURIComponent(parts[1]);
    const rkey = parts[3];
    if (/^[A-Za-z0-9._:%-]+$/.test(actor) && /^[A-Za-z0-9]+$/.test(rkey))
      return { kind: "bluesky", actor, rkey };
  }
  return null;
}

/** A YouTube start time: `90`, `90s` or `1h2m3s`. */
export function youtubeStart(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+s?$/.test(value)) return Number.parseInt(value, 10) || undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !match[0]) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds || undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? clean(value, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function loadGiphy(
  raw: string,
  id: string,
  signal: AbortSignal,
): Promise<LinkPreview | null> {
  const oembed = record(
    await fetchJson(
      `https://giphy.com/services/oembed?url=${encodeURIComponent(`https://giphy.com/gifs/${id}`)}`,
      signal,
    ),
  );
  let image: string | undefined;
  // The full GIF when it's small enough, else smaller renditions of the same one.
  for (const [name, limit] of [
    ["giphy.gif", MAX_GIF],
    ["giphy-downsized-medium.gif", MAX_GIF],
    ["200w.gif", MAX_IMAGE],
  ] as const) {
    image = await imageData(`https://media.giphy.com/media/${id}/${name}`, signal, limit);
    if (image) break;
  }
  if (!image) return null;
  const title = text(oembed?.title, 200)
    ?.replace(/\s*-\s*Find & Share on GIPHY$/i, "")
    .replace(/\s+GIF$/i, "");
  const preview: LinkPreview = {
    url: raw,
    kind: "giphy",
    title: title || "GIF",
    siteName: "GIPHY",
    image,
  };
  const width = count(oembed?.width);
  const height = count(oembed?.height);
  if (width && height) {
    preview.imageWidth = width;
    preview.imageHeight = height;
  }
  return preview;
}

async function loadYouTube(
  raw: string,
  id: string,
  signal: AbortSignal,
  start?: number,
): Promise<LinkPreview | null> {
  const [oembed, image] = await Promise.all([
    fetchJson(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
      signal,
    ).then(record),
    imageData(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, signal),
  ]);
  // No oEmbed: the video is private, removed or can't be embedded.
  if (!oembed) return null;
  const preview: LinkPreview = {
    url: raw,
    kind: "youtube",
    title: text(oembed.title, 200) ?? "YouTube video",
    siteName: text(oembed.author_name, 80) ?? "YouTube",
    videoId: id,
  };
  if (image) preview.image = image;
  if (start) preview.videoStart = start;
  return preview;
}

/** Bluesky's public AppView: the post itself, not the page's summary of it. */
async function loadBluesky(
  raw: string,
  actor: string,
  rkey: string,
  signal: AbortSignal,
): Promise<LinkPreview | null> {
  const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
  const thread = record(
    record(
      await fetchJson(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri=${encodeURIComponent(uri)}`,
        signal,
      ),
    )?.thread,
  );
  const post = record(thread?.post);
  const author = record(post?.author);
  const value = record(post?.record);
  const handle = text(author?.handle, 100);
  if (!post || !author || !value || !handle) return null;
  const name = text(author.displayName, 100) ?? handle;
  const social: SocialPost = {
    author: name,
    handle,
    text: postText(value.text),
    images: [],
  };
  const createdAt = text(value.createdAt, 40);
  if (createdAt && !Number.isNaN(Date.parse(createdAt))) social.createdAt = createdAt;
  const replies = count(post.replyCount);
  const reposts = count(post.repostCount);
  const likes = count(post.likeCount);
  if (replies !== undefined) social.replies = replies;
  if (reposts !== undefined) social.reposts = reposts;
  if (likes !== undefined) social.likes = likes;

  const pending: Promise<unknown>[] = [];
  const avatar = text(author.avatar, 1000);
  if (avatar)
    pending.push(
      imageData(avatar.replace("/img/avatar/", "/img/avatar_thumbnail/"), signal).then((src) => {
        if (src) social.avatar = src;
      }),
    );
  let embed = record(post.embed);
  let quoted: Record<string, unknown> | null = null;
  if (embed?.$type === "app.bsky.embed.recordWithMedia#view") {
    quoted = record(record(embed.record)?.record);
    embed = record(embed.media);
  } else if (embed?.$type === "app.bsky.embed.record#view") {
    quoted = record(embed.record);
    embed = null;
  }
  const media: { url: string; alt: string; ratio: Record<string, unknown> | null }[] = [];
  if (embed?.$type === "app.bsky.embed.images#view" && Array.isArray(embed.images)) {
    for (const item of embed.images.slice(0, 4)) {
      const image = record(item);
      const thumb = text(image?.thumb, 1000);
      if (thumb)
        media.push({
          url: thumb,
          alt: text(image?.alt, 300) ?? "",
          ratio: record(image?.aspectRatio),
        });
    }
  } else if (embed?.$type === "app.bsky.embed.video#view") {
    const thumb = text(embed.thumbnail, 1000);
    if (thumb) {
      media.push({ url: thumb, alt: text(embed.alt, 300) ?? "", ratio: record(embed.aspectRatio) });
      social.video = true;
    }
  } else if (embed?.$type === "app.bsky.embed.external#view") {
    const external = record(embed.external);
    const link = text(external?.uri, 2000);
    if (link && linkUrl(link)) {
      social.external = {
        url: link,
        title: text(external?.title, 200) ?? link,
        host: new URL(link).hostname.replace(/^www\./, ""),
      };
      const thumb = text(external?.thumb, 1000);
      if (thumb) media.push({ url: thumb, alt: "", ratio: null });
    }
  }
  const images = media.map(() => undefined as SocialPost["images"][number] | undefined);
  media.forEach((item, i) => {
    pending.push(
      imageData(item.url, signal).then((src) => {
        if (!src) return;
        const entry: SocialPost["images"][number] = { src, alt: item.alt };
        const width = count(item.ratio?.width);
        const height = count(item.ratio?.height);
        if (width && height) {
          entry.width = width;
          entry.height = height;
        }
        images[i] = entry;
      }),
    );
  });
  if (quoted && (quoted.$type === "app.bsky.embed.record#viewRecord" || quoted.value)) {
    const quoteAuthor = record(quoted.author);
    const quoteHandle = text(quoteAuthor?.handle, 100);
    if (quoteHandle) {
      social.quote = {
        author: text(quoteAuthor?.displayName, 100) ?? quoteHandle,
        handle: quoteHandle,
        text: postText(record(quoted.value)?.text, 300),
      };
    }
  }
  await Promise.all(pending);
  social.images = images.filter((image) => image !== undefined);
  return {
    url: raw,
    kind: "bluesky",
    title: `${name} (@${handle})`,
    siteName: "Bluesky",
    ...(social.text ? { description: clean(social.text, 300) } : {}),
    post: social,
  };
}

/** Post text keeps its line breaks, unlike a page title. */
function postText(value: unknown, max = 1000): string {
  if (typeof value !== "string") return "";
  const trimmed = value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

let active = 0;
const waiting: Array<() => void> = [];

/** Runs `work` once fewer than `MAX_CONCURRENT` previews are loading. */
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) active++;
  // A finishing preview hands its slot straight to the next one waiting.
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

/** Roughly how much memory a preview holds: its images are data URLs, so its JSON length. */
function previewSize(preview: LinkPreview | null): number {
  return preview ? JSON.stringify(preview).length : 0;
}

/**
 * A link's preview, fetched once per run of the app (while it stays in the cache), a few at a time
 * and within a deadline. Never logs the URL or the page.
 */
export function fetchPreview(raw: string): Promise<LinkPreview | null> {
  if (!allowedUrl(raw)) return Promise.resolve(null);
  const cached = cache.get(raw);
  if (cached) return cached;
  const pending = limited(() => load(raw, AbortSignal.timeout(PREVIEW_DEADLINE_MS))).catch(
    () => null,
  );
  cache.set(raw, pending);
  void pending.then((preview) => cache.resize(raw, previewSize(preview)));
  return pending;
}

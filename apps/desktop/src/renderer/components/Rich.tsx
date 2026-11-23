import "../youtube.ts";
import type { AttachmentHint } from "@beyland/tincan-protocol";
import type { HTMLAttributes } from "preact";
import { useState } from "preact/hooks";
import type { LinkPreview, SocialPost } from "../../shared/bridge.ts";
import { asciiUrl, type AttachmentKind, type AttachmentPart } from "../format.ts";
import { linkPreviews, previewFor, videoSize } from "../store.ts";
import { Icon } from "./Icon.tsx";

declare module "preact" {
  namespace JSX {
    interface IntrinsicElements {
      "lite-youtube": HTMLAttributes<HTMLElement> & {
        videoid: string;
        playlabel?: string;
        params?: string;
      };
    }
  }
}

const KIND_NOUN: Record<AttachmentKind, [string, string]> = {
  image: ["Photo", "Photos"],
  video: ["Video", "Videos"],
  audio: ["Audio message", "Audio messages"],
  file: ["File", "Files"],
  sticker: ["Sticker", "Stickers"],
  contact: ["Contact", "Contacts"],
};

/** What a message's attachments are, from MAP's placeholders and any hint the phone gave. */
export function attachmentParts(count: number, hint?: AttachmentHint): AttachmentPart[] {
  const total = Math.max(count, hint?.count ?? 0, 1);
  const kind = hint?.kinds?.length === 1 ? hint.kinds[0]! : "file";
  return [{ count: total, kind }];
}

function partLabel({ count, kind }: AttachmentPart): string {
  const [one, many] = KIND_NOUN[kind];
  return count === 1 ? one : `${count} ${many}`;
}

const ATTACHMENT_TIP =
  "Bluetooth only carries text. Open the conversation on your iPhone to see attachments.";

function ViewOnPhone() {
  return (
    <span class="item-sub">
      <Icon name="phone" size={11} /> View on your iPhone
    </span>
  );
}

/** Attachments Tincan can't fetch over MAP: what they are and where to see them. */
export function AttachmentCard({
  parts,
  known = true,
}: {
  parts: AttachmentPart[];
  known?: boolean;
}) {
  if (!known) return <GenericAttachment parts={parts} />;
  return (
    <div class="attachments" data-tip={ATTACHMENT_TIP}>
      {parts.map((part, i) => (
        <AttachmentPartCard key={i} part={part} />
      ))}
    </div>
  );
}

function AttachmentPartCard({ part }: { part: AttachmentPart }) {
  switch (part.kind) {
    case "image":
      return <PhotoCard count={part.count} />;
    case "video":
      return <VideoCard count={part.count} />;
    case "audio":
      return <AudioCard count={part.count} />;
    case "sticker":
      return <StickerCard count={part.count} />;
    case "contact":
      return <ContactCard count={part.count} />;
    default:
      return <FileCard count={part.count} />;
  }
}

/**
 * Photos: a stack of the same stand-in tile, fanned out as Messages stacks a batch, with the
 * count and where to see them in small type underneath.
 */
function PhotoCard({ count }: { count: number }) {
  const tiles = Math.min(count, 3);
  return (
    <div class="att-stack-card">
      <div class={`att-stack n${tiles}`} aria-hidden="true">
        {Array.from({ length: tiles }, (_, i) => (
          <span key={i} class="att-photo att-tile">
            {i === tiles - 1 && <Icon name="image" size={24} />}
          </span>
        ))}
      </div>
      <span class="att-stack-caption">
        <span class="att-stack-count">{partLabel({ count, kind: "image" })}</span>
        <span class="att-stack-where">
          <Icon name="phone" size={10} /> View on your iPhone
        </span>
      </span>
    </div>
  );
}

function VideoCard({ count }: { count: number }) {
  return (
    <div class="att-media">
      <div class="att-video" aria-hidden="true">
        <span class="att-play">
          <Icon name="play" size={18} />
        </span>
        {count > 1 && <span class="att-badge">{count}</span>}
      </div>
      <span class="att-caption">
        <span class="item-title">{partLabel({ count, kind: "video" })}</span>
        <ViewOnPhone />
      </span>
    </div>
  );
}

/**
 * An audio message: a microphone with soft rings around it, and where to listen. Nothing here
 * looks playable, because Tincan can't play it.
 */
function AudioCard({ count }: { count: number }) {
  return (
    <div class="att-audio">
      <span class="att-audio-mic" aria-hidden="true">
        <Icon name="mic" size={18} />
        {count > 1 && <span class="item-count">{count}</span>}
      </span>
      <span class="item-text">
        <span class="item-title">{partLabel({ count, kind: "audio" })}</span>
        <span class="item-sub">
          <Icon name="phone" size={11} /> Listen on your iPhone
        </span>
      </span>
    </div>
  );
}

/** A document: a page with a folded corner and its name. */
function FileCard({ count }: { count: number }) {
  return (
    <div class="att-file">
      <span class="att-doc" aria-hidden="true">
        <Icon name="file" size={20} />
        {count > 1 && <span class="item-count">{count}</span>}
      </span>
      <span class="item-text">
        <span class="item-title">{partLabel({ count, kind: "file" })}</span>
        <ViewOnPhone />
      </span>
    </div>
  );
}

/** A sticker: a die-cut blank with its corner peeling, where the sticker would sit. */
function StickerCard({ count }: { count: number }) {
  return (
    <div class="att-sticker">
      <span class="att-sticker-tile" aria-hidden="true">
        <span class="att-sticker-chip">
          <Icon name="sticker" size={18} />
        </span>
        {count > 1 && <span class="item-count">{count}</span>}
      </span>
      <span class="item-text">
        <span class="item-title">{partLabel({ count, kind: "sticker" })}</span>
        <span class="item-sub">
          <Icon name="phone" size={11} /> See it on your iPhone
        </span>
      </span>
    </div>
  );
}

/** A shared contact card, laid out like the one in Messages. */
function ContactCard({ count }: { count: number }) {
  return (
    <div class="att-contact">
      <span class="att-contact-head">
        <span class="att-contact-avatar" aria-hidden="true">
          <Icon name="contactCard" size={20} />
          {count > 1 && <span class="item-count">{count}</span>}
        </span>
        <span class="item-text">
          <span class="item-title">{partLabel({ count, kind: "contact" })}</span>
          <span class="item-sub">Name and details are on your iPhone</span>
        </span>
      </span>
      <span class="att-contact-foot">
        <Icon name="phone" size={11} /> View on your iPhone
      </span>
    </div>
  );
}

/** Attachments of a kind the phone didn't say. */
function GenericAttachment({ parts }: { parts: AttachmentPart[] }) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  return (
    <div class="item-card" data-tip={ATTACHMENT_TIP}>
      <span class="item-tile">
        <Icon name="attach" size={18} />
        {total > 1 && <span class="item-count">{total}</span>}
      </span>
      <span class="item-text">
        <span class="item-title">{total === 1 ? "Attachment" : `${total} Attachments`}</span>
        <ViewOnPhone />
      </span>
    </div>
  );
}

/**
 * An iMessage app item: almost always a shared location, but Apple Pay, games and other iMessage
 * apps arrive the same way, as U+FFFD with nothing else.
 */
export function LocationCard() {
  return (
    <div
      class="location-card"
      data-tip="Shared locations and app items reach Tincan over Bluetooth without their content."
    >
      <span class="location-map" aria-hidden="true">
        <span class="location-pin">
          <Icon name="mapPin" size={20} />
        </span>
      </span>
      <span class="item-text">
        <span class="item-title">Shared location</span>
        <span class="item-sub">Or another Messages app item · view it on your iPhone</span>
      </span>
    </div>
  );
}

/**
 * The summary iOS sends when it previewed a link itself: a title and a domain, with the link left
 * on the phone.
 */
export function SummaryCard({ title, host }: { title: string; host: string }) {
  const handle = host === "bsky.app" ? /\(@([a-z0-9.-]+\.[a-z]{2,})\)\s*$/i.exec(title)?.[1] : null;
  const body = (
    <>
      <span class="summary-icon">
        <Icon name="globe" size={16} />
      </span>
      <span class="item-text">
        <span class="item-title">{title}</span>
        <span class="item-sub">{host} · link stayed on the iPhone</span>
      </span>
    </>
  );
  return handle ? (
    <a
      class="summary-card"
      href={`https://bsky.app/profile/${handle}`}
      target="_blank"
      rel="noreferrer noopener"
      data-tip="iOS sent a summary instead of the link. Open the profile on Bluesky."
    >
      {body}
    </a>
  ) : (
    <div
      class="summary-card"
      data-tip="iOS sent a summary of this link instead of the link itself."
    >
      {body}
    </div>
  );
}

/**
 * The host a link really goes to, as ASCII: an international name shows as punycode (`xn--…`), so
 * look-alike letters can't pass for another site.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Whether a link has a preview card to show. `auto`: fetch its preview the first time (in a
 * conversation that loads previews on its own); otherwise only one already loaded counts.
 */
export function hasPreviewCard(url: string, auto = true): boolean {
  const preview = previewFor(url, { load: auto });
  if (!preview) return false;
  switch (preview.kind) {
    case "giphy":
      return !!preview.image;
    case "youtube":
      return !!preview.videoId;
    case "bluesky":
      return !!preview.post;
    default:
      return true;
  }
}

/** A card for the first link in a message, shaped by the kind of link. */
export function PreviewCard({ url, auto = true }: { url: string; auto?: boolean }) {
  const preview = previewFor(url, { load: auto });
  if (preview === undefined && !auto && linkPreviews.value) return <LoadPreview url={url} />;
  if (!preview) return null;
  switch (preview.kind) {
    case "giphy":
      return <GifCard url={url} preview={preview} />;
    case "youtube":
      return <YouTubeCard url={url} preview={preview} />;
    case "bluesky":
      return preview.post ? <PostCard url={url} post={preview.post} /> : null;
    default:
      return <GenericCard url={url} preview={preview} />;
  }
}

/**
 * An ordinary page's card. The page writes its own title and site name, so the real host leads
 * the card and the site's name only follows it: a page can call itself "Apple", but not change
 * where the link goes.
 */
function GenericCard({ url, preview }: { url: string; preview: LinkPreview }) {
  const host = hostOf(url);
  const name = preview.siteName?.trim();
  const showName = name && name.toLowerCase() !== host.toLowerCase();
  return (
    <a
      class="link-card"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-tip={asciiUrl(url)}
    >
      {preview.image && <img src={preview.image} alt="" draggable={false} />}
      <span class="link-card-text">
        <span class="link-card-host">
          <Icon name="globe" size={11} />
          {host}
        </span>
        <span class="link-card-title">{preview.title}</span>
        {showName && <span class="link-card-site">{name}</span>}
      </span>
    </a>
  );
}

/**
 * In a conversation that doesn't load previews on its own: the link's host, and a button that
 * loads its preview when asked.
 */
function LoadPreview({ url }: { url: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      class="load-preview"
      disabled={loading}
      data-tip="Loading a preview visits the link, which tells the site your IP address and when you loaded it."
      data-tip-delay="long"
      onClick={() => {
        setLoading(true);
        previewFor(url, { load: true });
      }}
    >
      <Icon name="globe" size={13} />
      <span class="load-preview-host">{hostOf(url)}</span>
      <span class="load-preview-action">{loading ? "Loading…" : "Load preview"}</span>
    </button>
  );
}

function ratio(preview: { imageWidth?: number; imageHeight?: number }): string | undefined {
  const { imageWidth: w, imageHeight: h } = preview;
  return w && h ? `${w} / ${h}` : undefined;
}

/** The whole GIF, uncropped, with a light caption. */
function GifCard({ url, preview }: { url: string; preview: LinkPreview }) {
  if (!preview.image) return null;
  return (
    <a
      class="gif-card"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-tip={asciiUrl(url)}
    >
      <img
        src={preview.image}
        alt={preview.title}
        draggable={false}
        style={{ aspectRatio: ratio(preview) }}
      />
      <span class="media-caption">
        <span class="media-caption-site">GIPHY</span>
        {preview.title && <span class="media-caption-title">{preview.title}</span>}
      </span>
    </a>
  );
}

/**
 * The quietest player YouTube allows: no annotations, captions only when asked, and related videos
 * from the same channel. The title and logo overlays can't be turned off.
 */
function playerParams(start: number | undefined): string {
  const params = new URLSearchParams({
    rel: "0",
    iv_load_policy: "3",
    cc_load_policy: "0",
    modestbranding: "1",
    playsinline: "1",
    fs: "0",
  });
  if (start) params.set("start", String(start));
  return params.toString();
}

/** A YouTube player that loads only when played (lite-youtube-embed). */
function YouTubeCard({ url, preview }: { url: string; preview: LinkPreview }) {
  if (!preview.videoId) return null;
  return (
    <div class={`video-card ${videoSize.value}`}>
      <lite-youtube
        videoid={preview.videoId}
        title={preview.title}
        playlabel={`Play: ${preview.title}`}
        params={playerParams(preview.videoStart)}
        // "none" rather than nothing, so the player doesn't fetch its own poster from ytimg.
        style={{ backgroundImage: preview.image ? `url("${preview.image}")` : "none" }}
      />
      <a
        class="media-caption"
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        data-tip="Open on YouTube"
      >
        <span class="media-caption-site">YouTube</span>
        <span class="media-caption-title">{preview.siteName ?? hostOf(url)}</span>
      </a>
    </div>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

/** A Bluesky post as Bluesky shows it: author, text, media, quote and counts. */
function PostCard({ url, post }: { url: string; post: SocialPost }) {
  const date = post.createdAt ? new Date(post.createdAt) : null;
  const images = post.images.slice(0, 4);
  return (
    <a
      class="post-card"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-tip={asciiUrl(url)}
    >
      <span class="post-head">
        {post.avatar ? (
          <img class="post-avatar" src={post.avatar} alt="" draggable={false} />
        ) : (
          <span class="post-avatar" />
        )}
        <span class="post-who">
          <span class="post-author">{post.author}</span>
          <span class="post-handle">@{post.handle}</span>
        </span>
        <span class="post-brand" aria-label="Bluesky">
          <svg width="16" height="16" viewBox="0 0 600 530" aria-hidden="true">
            <path
              fill="currentColor"
              d="M135.7 44C204.5 95.7 278.5 200.4 305.6 256.5c27.1-56.1 101.1-160.8 169.9-212.5C525.2 6.7 605.6-22 605.6 69.8c0 18.3-10.5 154-16.7 176-21.4 76.6-99.4 96.1-168.8 84.3 121.3 20.6 152.2 89 85.5 157.4-126.6 129.9-182-32.6-196.1-74.3-2.6-7.6-3.8-11.2-3.8-8.2 0-3-1.2.6-3.8 8.2-14.2 41.7-69.5 204.2-196.1 74.3-66.7-68.4-35.8-136.8 85.5-157.4-69.4 11.8-147.4-7.7-168.8-84.3C16.4 223.8 5.9 88.1 5.9 69.8 5.9-22 86.3 6.7 135.7 44z"
            />
          </svg>
        </span>
      </span>
      {post.text && <span class="post-text">{post.text}</span>}
      {images.length > 0 && (
        <span class={`post-media n${images.length}`}>
          {images.map((image, i) => (
            <span key={i} class="post-image">
              <img
                src={image.src}
                alt={image.alt}
                draggable={false}
                style={
                  images.length === 1 && image.width && image.height
                    ? { aspectRatio: `${image.width} / ${image.height}` }
                    : undefined
                }
              />
              {post.video && i === 0 && (
                <span class="post-play">
                  <Icon name="play" size={18} />
                </span>
              )}
            </span>
          ))}
        </span>
      )}
      {post.external && (
        <span class="post-external">
          <span class="post-external-title">{post.external.title}</span>
          <span class="post-external-host">{post.external.host}</span>
        </span>
      )}
      {post.quote && (
        <span class="post-quote">
          <span class="post-who">
            <span class="post-author">{post.quote.author}</span>
            <span class="post-handle">@{post.quote.handle}</span>
          </span>
          {post.quote.text && <span class="post-quote-text">{post.quote.text}</span>}
        </span>
      )}
      <span class="post-foot">
        <span class="post-stat">
          <Icon name="reply" size={13} /> {compact(post.replies ?? 0)}
        </span>
        <span class="post-stat">
          <Icon name="repost" size={13} /> {compact(post.reposts ?? 0)}
        </span>
        <span class="post-stat">
          <Icon name="heart" size={13} /> {compact(post.likes ?? 0)}
        </span>
        {date && (
          <span class="post-date">
            {date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
          </span>
        )}
      </span>
    </a>
  );
}

import type { TincanEvent, WireError } from "@beyland/tincan-protocol";

/** What the main process tells the renderer about the daemon connection. */
export type BridgeState =
  | { state: "connecting"; attempt: number; error?: string }
  | { state: "connected"; version: string }
  | { state: "closed" };

export { THEMES, type Theme } from "./themes.ts";
import type { Theme } from "./themes.ts";

/** What a web page says about itself, for a card under a message that links to it. */
export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  /** A data URL: the renderer can't load remote images. */
  image?: string;
  /** The image's size in pixels, when the page says: cards keep its shape instead of cropping. */
  imageWidth?: number;
  imageHeight?: number;
  /** A site Tincan draws its own card for; absent for an ordinary page. */
  kind?: "giphy" | "youtube" | "bluesky";
  /** YouTube: the video to play in place, and where to start (seconds). */
  videoId?: string;
  videoStart?: number;
  /** Bluesky: the post itself. */
  post?: SocialPost;
}

export interface SocialPost {
  author: string;
  handle: string;
  /** Data URL. */
  avatar?: string;
  text: string;
  /** ISO time. */
  createdAt?: string;
  /** Data URLs, at most four; a video's thumbnail is one image with `video` set. */
  images: { src: string; alt: string; width?: number; height?: number }[];
  video?: boolean;
  /** A link card inside the post. */
  external?: { url: string; title: string; host: string };
  /** A quoted post. */
  quote?: { author: string; handle: string; text: string };
  replies?: number;
  reposts?: number;
  likes?: number;
}

export type RunResult = { ok: true; result: unknown } | { ok: false; error: WireError };

/** `window.tincan`, exposed by the preload. The only way the renderer reaches the daemon. */
export interface TincanBridge {
  run(name: string, input?: unknown): Promise<RunResult>;
  state(): Promise<BridgeState>;
  onEvent(handler: (event: TincanEvent) => void): () => void;
  onState(handler: (state: BridgeState) => void): () => void;
  /** The app was asked to show a conversation (`--thread=` or a notification). */
  onOpenThread(handler: (key: string) => void): () => void;
  /** Report the unread count for the launcher badge and tray. */
  setUnread(count: number): void;
  /** The app's colour scheme preference, kept by the desktop app (not the daemon). */
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<Theme>;
  /** Show a theme without saving it (the palette's live preview); null goes back to the saved one. */
  previewTheme(theme: Theme | null): void;
  /** Fetch a link's preview in the main process; null when there is none or previews are off. */
  linkPreview(url: string): Promise<LinkPreview | null>;
  getLinkPreviews(): Promise<boolean>;
  setLinkPreviews(on: boolean): Promise<boolean>;
  /** Chromium's spell checker; turning it on downloads a dictionary from Google once. */
  getSpellcheck(): Promise<boolean>;
  setSpellcheck(on: boolean): Promise<boolean>;
  /** Put text on the system clipboard (works whether or not the window has focus). */
  copyText(text: string): Promise<boolean>;
  platform: string;
}

export const CHANNELS = {
  run: "tincan:run",
  state: "tincan:state",
  event: "tincan:event",
  stateChanged: "tincan:state-changed",
  openThread: "tincan:open-thread",
  unread: "tincan:unread",
  getTheme: "tincan:get-theme",
  setTheme: "tincan:set-theme",
  previewTheme: "tincan:preview-theme",
  linkPreview: "tincan:link-preview",
  getLinkPreviews: "tincan:get-link-previews",
  setLinkPreviews: "tincan:set-link-previews",
  getSpellcheck: "tincan:get-spellcheck",
  setSpellcheck: "tincan:set-spellcheck",
  copyText: "tincan:copy-text",
} as const;

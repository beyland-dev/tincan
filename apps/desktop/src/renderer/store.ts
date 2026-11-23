import { batch, computed, signal } from "@preact/signals";
import { groupNameKey } from "@beyland/tincan-protocol";
import type {
  AgentConnection,
  AgentDraft,
  Contact,
  Group,
  TincanEvent,
  Message,
  OutputOf,
  Settings,
  Thread,
} from "@beyland/tincan-protocol";
import type { BridgeState, LinkPreview, Theme } from "../shared/bridge.ts";
import { SizedLru } from "../shared/lru.ts";
import { namedTheme } from "../shared/themes.ts";
import { call, CommandError } from "./api.ts";
import {
  draftKey,
  listRows,
  nextWithDrafts,
  pendingRecipients,
  type ListRow,
  type OwnNewDraft,
  type PendingRecipient,
} from "./draft-rows.ts";
import { formatHandle, mergeMessages, messageTime, replaceLatest, wroteIn } from "./format.ts";
import { DEFAULT_SECTION, type SettingsSection } from "./settings-sections.ts";
import { hiddenHandles, type HideTarget, type ShowTarget } from "./agent-hiding.ts";

const PAGE = 50;

export interface Conversation {
  /** Oldest first. */
  messages: Message[];
  /** The phone has nothing older (a page came back short). */
  complete: boolean;
  loading: boolean;
}

export type Dialog =
  | "settings"
  | "moveToGroup"
  | "palette"
  | "confirmDeleteMessages"
  | "forgetPhone"
  | "pair"
  | "fixConnection"
  | null;

export const connection = signal<BridgeState>({ state: "connecting", attempt: 0 });
export const status = signal<OutputOf<"status"> | null>(null);
/** Details about the phone and adapter, for Settings; loaded while Settings is open. */
export const phoneInfo = signal<OutputOf<"device.info"> | null>(null);
/** The systemd user service: undefined until asked, null when this daemon can't manage it. */
export const backgroundService = signal<OutputOf<"service.status"> | undefined>(undefined);
export const notifications = signal<string | null>(null);
export const threads = signal<Thread[]>([]);
export const threadsLoaded = signal(false);
export const selectedKey = signal<string | null>(null);
/** A new conversation is being written in the main pane. */
export const composing = signal(false);
/** Whether the getting-started conversation with Tincan has been finished once. */
export const welcomed = signal(!!localStorage.getItem("tincan.welcomed"));
/** The getting-started conversation is in the main pane: on first run, or reopened later. */
export const welcomeOpen = signal(!welcomed.value);
/** Messages picked in the open conversation, while choosing ones to move or delete; null otherwise. */
export const picked = signal<ReadonlySet<string> | null>(null);
/** What the picked messages are for. */
export const pickMode = signal<"group" | "delete">("group");
export const theme = signal<Theme>("system");
export const detail = signal<{
  thread: Thread;
  group: Group | null;
  /** The user's own saved draft (agents' are in `agentDrafts`). */
  draft: string | null;
} | null>(null);
export const conversations = signal<Record<string, Conversation>>({});
export const contacts = signal<Contact[]>([]);
export const settings = signal<Settings | null>(null);
/** Queued agent drafts in every conversation (and to new recipients), oldest first. */
export const agentDrafts = signal<AgentDraft[]>([]);
/** The user's own saved drafts to people with no conversation yet, newest first. */
export const ownNewDrafts = signal<OwnNewDraft[]>([]);
export const draftsLoaded = signal(false);
/**
 * The new recipient whose view was last opened, and its row's time then: while it's still open
 * its row stays, even once its last draft has gone (the user cleared their text, say).
 */
const openedPending = signal<{ to: string; at: number } | null>(null);
export const searchQuery = signal("");
export const searchResults = signal<Message[] | null>(null);
export const dialog = signal<Dialog>(null);
/** The Settings section showing; kept for the session, so Settings reopens where it was. */
export const settingsSection = signal<SettingsSection>(DEFAULT_SECTION);

/** Opens Settings, at `section` if given (else where it was last). */
export function openSettings(section?: SettingsSection): void {
  if (section) settingsSection.value = section;
  dialog.value = "settings";
}
export type ToastTone = "info" | "success" | "error";
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}
export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  action?: ToastAction;
  /** Runs when it goes away without its action being used: timed out, closed or crowded out. */
  onDismiss?: () => void;
  /** Milliseconds before it dismisses itself; Infinity keeps it until dismissed. */
  duration: number;
  /** Set while it animates out. */
  leaving?: boolean;
  /** Bumped by `refreshToast` to restart its countdown. */
  round?: number;
}
/** In-app notifications, oldest first. */
export const toasts = signal<Toast[]>([]);
export const TOAST_PLACEMENTS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type ToastPlacement = (typeof TOAST_PLACEMENTS)[number];
function storedPlacement(): ToastPlacement {
  const stored = localStorage.getItem("tincan.toastPlacement");
  return TOAST_PLACEMENTS.find((p) => p === stored) ?? "top-right";
}
/** Where in-app notifications appear (a renderer preference). */
export const toastPlacement = signal<ToastPlacement>(storedPlacement());
/** The thread list's context menu: which conversation, and where. */
export const threadMenu = signal<{ key: string; x: number; y: number } | null>(null);
/** The right-click menu on a message in the open conversation. */
export const messageMenu = signal<{ id: string; x: number; y: number } | null>(null);
/** Contact photos as data URLs by contact id; null once a contact turned out to have none. */
export const photos = signal<Record<string, string | null>>({});
/** The contact or group info panel beside the open conversation. */
export const infoOpen = signal(false);
/** The phone's recent connects and disconnects, oldest first, for the connection dock. */
export const linkLog = signal<OutputOf<"device.history">>([]);
/** The connection dock is expanded into its timeline. */
export const dockOpen = signal(false);

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 440;
const SIDEBAR_DEFAULT = 300;

function storedWidth(): number {
  const stored = Number(localStorage.getItem("tincan.sidebarWidth"));
  return Number.isFinite(stored) && stored > 0 ? clampSidebar(stored) : SIDEBAR_DEFAULT;
}

export function clampSidebar(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

export const sidebarWidth = signal(storedWidth());
export const sidebarCollapsed = signal(localStorage.getItem("tincan.sidebarCollapsed") === "1");

export function setSidebarWidth(width: number): void {
  sidebarWidth.value = clampSidebar(width);
  localStorage.setItem("tincan.sidebarWidth", String(sidebarWidth.value));
}

export function toggleSidebar(): void {
  // The toggle is a different button in each state, so carry focus across to the new one.
  const hadFocus = document.activeElement?.classList.contains("sidebar-toggle") ?? false;
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem("tincan.sidebarCollapsed", sidebarCollapsed.value ? "1" : "0");
  if (hadFocus) {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".sidebar-toggle")?.focus());
  }
}

/** Puts the cursor in the search box, showing the sidebar first if it's hidden. */
export function focusSearch(): void {
  dialog.value = null;
  if (sidebarCollapsed.value) toggleSidebar();
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".sidebar .search input");
    input?.focus();
    input?.select();
  });
}

/**
 * Whether to fetch previews of links in messages (a desktop app preference, off by default).
 * Even when on, only conversations the user trusts fetch them on their own; see `autoPreviews`.
 */
export const linkPreviews = signal(false);
/** Chromium's spell checker (a desktop app preference, off by default). */
export const spellcheck = signal(false);
/** With previews on, whether a message that is only a link shows just its preview card. */
export const linkCardsOnly = signal(localStorage.getItem("tincan.linkCardsOnly") === "1");

export function changeLinkCardsOnly(on: boolean): void {
  linkCardsOnly.value = on;
  localStorage.setItem("tincan.linkCardsOnly", on ? "1" : "0");
}

export type VideoSize = "small" | "medium" | "large";
const VIDEO_SIZES: readonly VideoSize[] = ["small", "medium", "large"];
const storedVideoSize = localStorage.getItem("tincan.videoSize") as VideoSize | null;
/** How wide YouTube players in conversations are. */
export const videoSize = signal<VideoSize>(
  storedVideoSize && VIDEO_SIZES.includes(storedVideoSize) ? storedVideoSize : "medium",
);

export function changeVideoSize(size: VideoSize): void {
  videoSize.value = size;
  localStorage.setItem("tincan.videoSize", size);
}
/** Link previews by URL: null when there is none, absent until asked for. */
export const previews = signal<Record<string, LinkPreview | null>>({});
const previewRequests = new Set<string>();
/**
 * Which previews to keep, least recently shown first: capped by count and by the size of their
 * images (data URLs), so a long scroll through links doesn't hold every image in memory.
 */
const previewOrder = new SizedLru<true>({ maxEntries: 300, maxSize: 64_000_000 });

/**
 * A link's preview: cached, or fetched the first time when `load` is set; undefined until then,
 * when not loaded, or when previews are off. Previews are only fetched over https, so a plain
 * http link has none (and no button to load one).
 */
export function previewFor(
  url: string,
  { load = true }: { load?: boolean } = {},
): LinkPreview | null | undefined {
  if (!linkPreviews.value) return undefined;
  if (!/^https:\/\//i.test(url)) return null;
  const cached = previews.value[url];
  if (cached !== undefined) previewOrder.get(url);
  if (cached !== undefined || previewRequests.has(url) || !load) return cached;
  previewRequests.add(url);
  void window.tincan
    .linkPreview(url)
    .catch(() => null)
    .then((preview) => {
      previewRequests.delete(url);
      previewOrder.set(url, true, preview ? JSON.stringify(preview).length : 0);
      const kept: Record<string, LinkPreview | null> = {};
      for (const key of previewOrder.keys()) {
        if (key === url) kept[key] = preview;
        else if (previews.value[key] !== undefined) kept[key] = previews.value[key]!;
      }
      previews.value = kept;
    });
  return undefined;
}

/**
 * Whether a conversation fetches link previews on its own (once they're on): one with a saved
 * contact, or one the user has written in. Anywhere else a sender could learn the computer's IP
 * address and when the message was read just by sending a link, so previews wait for a click.
 */
export function autoPreviews(thread: Thread, messages: readonly Message[]): boolean {
  if (wroteIn(thread, messages)) return true;
  const byHandle = contactsByHandle.value;
  return thread.members.length > 0 && thread.members.every((h) => byHandle.has(h));
}

export async function loadLinkPreviews(): Promise<void> {
  linkPreviews.value = await window.tincan.getLinkPreviews();
}

export async function changeLinkPreviews(on: boolean): Promise<void> {
  linkPreviews.value = await window.tincan.setLinkPreviews(on);
  if (linkPreviews.value) rememberLinkPreviewsExplained();
}

/**
 * Whether the user has been told what link previews reveal, by the confirmation (from Settings,
 * the command palette or onboarding). Per computer.
 */
const LINK_PREVIEWS_EXPLAINED = "tincan.linkPreviewsExplained";

function linkPreviewsExplained(): boolean {
  try {
    return localStorage.getItem(LINK_PREVIEWS_EXPLAINED) === "1";
  } catch {
    return false;
  }
}

function rememberLinkPreviewsExplained(): void {
  try {
    localStorage.setItem(LINK_PREVIEWS_EXPLAINED, "1");
  } catch {
    // Without storage, the confirmation shows again next time.
  }
}

/** Whether to ask before turning link previews on: shown by `Dialogs` over whatever is open. */
export const linkPreviewsConfirm = signal(false);

/**
 * Turns link previews on or off. The very first time they're turned on it asks first, and only
 * that once: the dialog counts as seen as soon as it opens, whether the user confirms or cancels.
 */
export function requestLinkPreviews(on: boolean): void {
  if (on && !linkPreviewsExplained()) {
    rememberLinkPreviewsExplained();
    linkPreviewsConfirm.value = true;
  } else void changeLinkPreviews(on);
}

export async function loadSpellcheck(): Promise<void> {
  spellcheck.value = await window.tincan.getSpellcheck();
}

export async function changeSpellcheck(on: boolean): Promise<void> {
  spellcheck.value = await window.tincan.setSpellcheck(on);
}

/** Contact names by handle. */
export const names = computed(() => {
  const map = new Map<string, string>();
  for (const contact of contacts.value) {
    for (const handle of contact.handles) map.set(handle, contact.name);
  }
  return map;
});

/** Contacts by handle. */
export const contactsByHandle = computed(() => {
  const map = new Map<string, Contact>();
  for (const contact of contacts.value) {
    for (const handle of contact.handles) map.set(handle, contact);
  }
  return map;
});

const photoRequests = new Set<string>();
/** Cached photos that may have changed on the phone: refetched, but shown until the new one lands. */
const stalePhotos = new Set<string>();

/** Marks every cached photo for refetching, keeping each on screen until its replacement arrives. */
function refreshPhotos(): void {
  for (const id of Object.keys(photos.value)) stalePhotos.add(id);
}

/** A handle's contact photo as a data URL, fetching it the first time; undefined until then. */
export function photoFor(handle: string | null | undefined): string | undefined {
  const contact = handle ? contactsByHandle.value.get(handle) : undefined;
  if (!contact?.hasPhoto) return undefined;
  const cached = photos.value[contact.id];
  if (cached !== undefined && !stalePhotos.has(contact.id)) return cached ?? undefined;
  if (!photoRequests.has(contact.id)) {
    photoRequests.add(contact.id);
    const id = contact.id;
    void attempt(() => call("contact.photo", { id }), true).then((photo) => {
      photoRequests.delete(id);
      stalePhotos.delete(id);
      const url = photo ? `data:${photo.mediaType};base64,${photo.data}` : null;
      if (photos.value[id] !== url) photos.value = { ...photos.value, [id]: url };
    });
  }
  return cached ?? undefined;
}

/** Queued agent drafts by the row they belong to: a conversation's key, or a new recipient. */
export const draftsByKey = computed(() => {
  const map = new Map<string, AgentDraft[]>();
  for (const draft of agentDrafts.value) {
    const key = draftKey(draft);
    map.set(key, [...(map.get(key) ?? []), draft]);
  }
  return map;
});

/** People with drafts waiting (agents' or the user's own) and no conversation yet, newest first. */
export const pendingList = computed(() => {
  const opened = openedPending.value;
  return pendingRecipients(
    agentDrafts.value,
    ownNewDrafts.value,
    new Set(threads.value.map((t) => t.key)),
    opened && selectedKey.value === opened.to ? opened : null,
  );
});

/** The conversation list's rows below the pinned ones: conversations and new recipients. */
export const listedRows = computed((): ListRow[] =>
  listRows(
    threads.value.filter((t) => !t.pinned),
    pendingList.value,
    (t) => (t.lastMessage ? messageTime(t.lastMessage) : 0),
  ),
);

/** The list's keys in order (pinned first), for Ctrl+Shift+D. */
export const listOrder = computed(() => [
  ...threads.value.filter((t) => t.pinned).map((t) => t.key),
  ...listedRows.value.map((r) => r.key),
]);

/** A new recipient with drafts waiting, shown as a conversation with no messages yet. */
export function pendingThread(pending: PendingRecipient): Thread {
  const to = pending.to;
  return {
    key: to,
    kind: "direct",
    title: names.value.get(to) ?? formatHandle(to),
    members: [to],
    lastMessage: null,
    unread: 0,
    muted: false,
    pinned: false,
  };
}

/** Opens the next conversation (or new recipient) with agent drafts waiting (Ctrl+Shift+D). */
export function openNextDrafts(): boolean {
  const key = nextWithDrafts(
    listOrder.value,
    new Set(draftsByKey.value.keys()),
    composing.value ? null : selectedKey.value,
  );
  if (!key) return false;
  dialog.value = null;
  void select(key);
  return true;
}

/** Whether a key is a new recipient (drafts waiting, no conversation yet). */
export function isPending(key: string | null | undefined): boolean {
  return !!key && pendingList.value.some((p) => p.to === key);
}

/** The user's own saved draft to a new recipient ("" when there's none). */
export function pendingOwnDraft(key: string): string {
  return pendingList.value.find((p) => p.to === key)?.own?.text ?? "";
}

export const selectedThread = computed(() => {
  const key = selectedKey.value;
  const listed = threads.value.find((t) => t.key === key) ?? detail.value?.thread;
  if (listed) return listed;
  const pending = pendingList.value.find((p) => p.to === key);
  return pending ? pendingThread(pending) : null;
});

export const totalUnread = computed(() =>
  threads.value.reduce((sum, t) => sum + (t.muted ? 0 : t.unread), 0),
);

export const connected = computed(() => connection.value.state === "connected");

const TOAST_LIMIT = 5;
const TOAST_EXIT_MS = 220;
let toastSeq = 0;

/**
 * Shows an in-app notification and returns its id. Errors stay longer; one with an action stays
 * long enough to use it.
 */
export function notify(
  title: string,
  options: ToastTone | Partial<Omit<Toast, "id" | "title" | "leaving">> = {},
): number {
  const opts = typeof options === "string" ? { tone: options } : options;
  const tone = opts.tone ?? "info";
  const toast: Toast = {
    id: ++toastSeq,
    title,
    body: opts.body,
    tone,
    action: opts.action,
    onDismiss: opts.onDismiss,
    duration: opts.duration ?? (tone === "error" ? 7000 : opts.action ? 6000 : 4000),
  };
  const live = toasts.value.filter((t) => !t.leaving);
  const overflow = live.length + 1 - TOAST_LIMIT;
  const crowded = live.slice(0, Math.max(0, overflow));
  const dropped = new Set(crowded.map((t) => t.id));
  toasts.value = [...toasts.value.filter((t) => !dropped.has(t.id)), toast];
  for (const t of crowded) t.onDismiss?.();
  return toast.id;
}

/**
 * Changes a notification that's still showing and restarts its countdown, instead of stacking a
 * new one. Returns false when it's already gone.
 */
export function refreshToast(id: number, patch: Partial<Pick<Toast, "title" | "body">>): boolean {
  if (!toasts.value.some((t) => t.id === id && !t.leaving)) return false;
  toasts.value = toasts.value.map((t) =>
    t.id === id ? { ...t, ...patch, round: (t.round ?? 0) + 1 } : t,
  );
  return true;
}

/** Animates a notification out, then removes it; `acted` when its action was used. */
export function dismissToast(id: number, { acted = false }: { acted?: boolean } = {}): void {
  const toast = toasts.value.find((t) => t.id === id && !t.leaving);
  if (!toast) return;
  if (!acted) toast.onDismiss?.();
  toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), TOAST_EXIT_MS);
}

export function setToastPlacement(placement: ToastPlacement): void {
  toastPlacement.value = placement;
  localStorage.setItem("tincan.toastPlacement", placement);
}

export function errorText(error: unknown): string {
  if (error instanceof CommandError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function attempt<T>(work: () => Promise<T>, quiet = false): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (!quiet && !(error instanceof CommandError && error.code === "NOT_CONNECTED")) {
      notify(errorText(error), "error");
    }
    return undefined;
  }
}

export async function refreshThreads(): Promise<void> {
  const list = await attempt(() => call("thread.list", { limit: 500 }), true);
  if (!list) return;
  batch(() => {
    threads.value = list.filter((t) => !pendingDeletes.has(t.key));
    threadsLoaded.value = true;
  });
}

export async function refreshStatus(): Promise<void> {
  const result = await attempt(() => call("status", {}), true);
  if (result) status.value = result;
}

export async function refreshLinkLog(): Promise<void> {
  const result = await attempt(() => call("device.history", { limit: 500 }), true);
  if (result) linkLog.value = result;
}

export async function refreshContacts(): Promise<void> {
  const all: Contact[] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await attempt(() => call("contact.list", { limit: 500, offset }), true);
    if (!page) return;
    all.push(...page);
    if (page.length < 500) break;
  }
  contacts.value = all;
}

/**
 * The app is the user, so the daemon sends it every setting; agents get only the agent policy
 * (`AgentVisibleSettings`), which the app never expects but doesn't mistake for the full set.
 */
function allSettings(value: Settings | Pick<Settings, "agents">): value is Settings {
  return "notifications" in value;
}

export async function refreshSettings(): Promise<void> {
  const result = await attempt(() => call("settings.get", {}), true);
  if (result && allSettings(result)) settings.value = result;
}

export async function refreshDrafts(): Promise<void> {
  const [list, own] = await Promise.all([
    attempt(() => call("draft.list", { states: ["queued"], limit: 500 }), true),
    attempt(() => call("message.draft.list", { limit: 500 }), true),
  ]);
  if (!list) return;
  batch(() => {
    agentDrafts.value = list;
    if (own) ownNewDrafts.value = own;
    draftsLoaded.value = true;
  });
}

function setConversation(key: string, update: Partial<Conversation>): void {
  const current = conversations.value[key] ?? { messages: [], complete: false, loading: false };
  conversations.value = { ...conversations.value, [key]: { ...current, ...update } };
}

async function loadLatest(key: string): Promise<void> {
  const page = await attempt(() => call("message.list", { threadKey: key, limit: PAGE }));
  if (!page) return;
  const existing = conversations.value[key];
  setConversation(key, {
    messages: replaceLatest(existing?.messages ?? [], page, page.length < PAGE),
    complete: existing?.complete || page.length < PAGE,
  });
}

export async function loadOlder(key: string): Promise<void> {
  const current = conversations.value[key];
  if (!current || current.complete || current.loading) return;
  const oldest = current.messages[0];
  setConversation(key, { loading: true });
  const page = await attempt(() =>
    call("message.list", {
      threadKey: key,
      limit: PAGE,
      before: oldest ? messageTime(oldest) : undefined,
    }),
  );
  const latest = conversations.value[key]!;
  setConversation(key, {
    loading: false,
    messages: page ? mergeMessages(latest.messages, page) : latest.messages,
    complete: page ? page.length < PAGE : latest.complete,
  });
}

async function loadDetail(key: string): Promise<void> {
  const result = await attempt(() => call("thread.get", { key }), true);
  if (result && selectedKey.value === key) detail.value = result;
}

export async function select(key: string | null, { reload = false } = {}): Promise<void> {
  if (selectedKey.value === key && !composing.value && !reload) return;
  // Opening a conversation that's about to be deleted (from a notification, say) keeps it.
  if (key && pendingDeletes.delete(key)) void refreshThreads();
  batch(() => {
    selectedKey.value = key;
    detail.value = null;
    composing.value = false;
    picked.value = null;
    renamingThread.value = null;
    if (key) welcomeOpen.value = false;
  });
  if (!key) return;
  // Opened from a notification before the list loaded: it may be a new recipient's drafts.
  if (!threads.value.some((t) => t.key === key) && !draftsLoaded.value) await refreshDrafts();
  if (!threads.value.some((t) => t.key === key) && isPending(key)) {
    const row = pendingList.value.find((p) => p.to === key)!;
    openedPending.value = { to: key, at: row.at };
    setConversation(key, { messages: [], complete: true, loading: false });
    return;
  }
  await Promise.all([loadDetail(key), loadLatest(key)]);
  markReadIfVisible();
}

/**
 * After the first message to a new recipient, the real conversation takes the place of their
 * pending row (its key may differ from the recipient's).
 */
async function followNewConversation(from: string, to: string): Promise<void> {
  await Promise.all([refreshThreads(), refreshDrafts()]);
  if (selectedKey.value !== from) return;
  await select(to, { reload: true });
}

export function startCompose(): void {
  batch(() => {
    selectedKey.value = null;
    detail.value = null;
    picked.value = null;
    composing.value = true;
    dialog.value = null;
    welcomeOpen.value = false;
  });
}

/** Show the getting-started conversation with Tincan in the main pane. */
export function openWelcome(): void {
  batch(() => {
    selectedKey.value = null;
    detail.value = null;
    picked.value = null;
    composing.value = false;
    infoOpen.value = false;
    dialog.value = null;
    welcomeOpen.value = true;
  });
}

/** Close the getting-started conversation; once finished, it no longer opens at startup. */
export function finishWelcome(): void {
  localStorage.setItem("tincan.welcomed", "1");
  batch(() => {
    welcomed.value = true;
    welcomeOpen.value = false;
  });
}

export function cancelCompose(): void {
  composing.value = false;
}

/** Load a conversation's latest messages without opening it (the new-message preview). */
export async function peek(key: string): Promise<void> {
  if (!conversations.value[key]) await loadLatest(key);
}

/** Starts picking messages for `mode`, or stops when already picking for it. */
export function startPicking(mode: "group" | "delete"): void {
  if (picked.value && pickMode.value === mode) {
    picked.value = null;
    return;
  }
  pickMode.value = mode;
  picked.value = new Set();
}

/** Starts picking for `mode` with one message already picked, from its hover button or menu. */
export function pickFrom(mode: "group" | "delete", id: string): void {
  pickMode.value = mode;
  picked.value = new Set([id]);
}

export function togglePicked(id: string): void {
  const current = picked.value;
  if (!current) return;
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
}

/**
 * Moves the picked messages into a group conversation: an existing one (`key`) or a new one
 * named `name`. Opens the group afterwards.
 */
export async function movePickedToGroup(target: { key: string } | { name: string }) {
  const ids = [...(picked.value ?? [])];
  const from = selectedKey.value;
  if (ids.length === 0 || !from) return;
  let key: string;
  if ("key" in target) {
    key = target.key;
  } else {
    const name = target.name.trim();
    const named = groupNameKey(name);
    if (!named) return;
    key = named;
    const saved = await attempt(() => call("group.save", { threadKey: key, title: name }));
    if (!saved) return;
  }
  const moved = new Set<string>();
  for (const id of ids) {
    const message = await attempt(() => call("group.assignMessage", { id, threadKey: key }));
    if (message) moved.add(id);
  }
  // Loading a conversation only ever adds messages, so drop the moved ones by hand.
  const source = conversations.value[from];
  if (source) {
    setConversation(from, { messages: source.messages.filter((m) => !moved.has(m.id)) });
  }
  dialog.value = null;
  if (moved.size === 0) return;
  notify(`Moved ${moved.size} message${moved.size === 1 ? "" : "s"}`, { tone: "success" });
  await refreshThreads();
  await select(key);
}

/** Deletes the picked messages from Tincan (the phone keeps them). */
export async function deletePicked(): Promise<void> {
  const ids = [...(picked.value ?? [])];
  const from = selectedKey.value;
  if (ids.length === 0 || !from) return;
  const result = await attempt(() => call("message.delete", { ids }));
  dialog.value = null;
  if (!result) return;
  const deleted = new Set(result.deleted);
  const source = conversations.value[from];
  if (source) {
    setConversation(from, { messages: source.messages.filter((m) => !deleted.has(m.id)) });
  }
  picked.value = null;
  notify(`Deleted ${deleted.size} message${deleted.size === 1 ? "" : "s"}`, { tone: "success" });
  await refreshThreads();
}

export async function loadTheme(): Promise<void> {
  applyTheme(await window.tincan.getTheme());
}

export async function changeTheme(next: Theme): Promise<void> {
  applyTheme(await window.tincan.setTheme(next));
}

/** Show a theme without saving it; null goes back to the saved theme. */
export function previewTheme(next: Theme | null): void {
  window.tincan.previewTheme(next);
  paintTheme(next ?? theme.value);
}

/** Named themes recolour the page; the main process picks light or dark underneath. */
function applyTheme(next: Theme): void {
  theme.value = next;
  paintTheme(next);
}

function paintTheme(next: Theme): void {
  const root = document.documentElement;
  if (namedTheme(next)) root.dataset.theme = next;
  else delete root.dataset.theme;
}

/** Mark the open conversation read while the window has focus. */
export function markReadIfVisible(): void {
  const thread = selectedThread.value;
  if (!thread || thread.unread === 0 || !document.hasFocus()) return;
  void attempt(() => call("thread.markRead", { key: thread.key }), true);
}

/** Adds a message (one just sent or changed) to its conversation, if it's loaded. */
function showMessage(message: Message): void {
  const conversation = conversations.value[message.threadKey];
  if (conversation) {
    setConversation(message.threadKey, {
      messages: mergeMessages(conversation.messages, [message]),
    });
  }
}

function dropMessage(threadKey: string, id: string): void {
  const conversation = conversations.value[threadKey];
  if (conversation) {
    setConversation(threadKey, { messages: conversation.messages.filter((m) => m.id !== id) });
  }
}

/**
 * Sends the user's message. `fromNewRecipientDraft`: it's the user's own draft to someone with no
 * conversation yet, which goes once it's sent, before the new conversation opens (where it would
 * otherwise show again).
 */
export async function send(
  to: string,
  text: string,
  { fromNewRecipientDraft = false }: { fromNewRecipientDraft?: boolean } = {},
): Promise<Message | undefined> {
  const result = await attempt(() => call("message.send", { to, text }));
  const message = result?.message;
  if (!message) return undefined;
  showMessage(message);
  if (fromNewRecipientDraft) {
    void (async () => {
      await clearNewRecipientDraft(to);
      await followNewConversation(to, message.threadKey);
    })();
  } else if (message.threadKey !== to || isPending(to)) {
    void followNewConversation(to, message.threadKey);
  }
  return message;
}

export async function retry(id: string): Promise<void> {
  await attempt(() => call("message.retry", { id }));
}

export async function saveDraft(threadKey: string, text: string): Promise<void> {
  await attempt(() => call("message.draft.save", { threadKey, text }), true);
}

/** Saves the user's own draft to someone with no conversation yet; empty text deletes it. */
export async function saveNewRecipientDraft(to: string, text: string): Promise<void> {
  await attempt(() => call("message.draft.save", { to, text }), true);
}

/** Deletes the user's own draft to a new recipient, here at once and then in the daemon. */
async function clearNewRecipientDraft(to: string): Promise<void> {
  ownNewDrafts.value = ownNewDrafts.value.filter((d) => d.to !== to);
  await saveNewRecipientDraft(to, "");
}

/**
 * Throw away the user's saved draft in the open conversation. The details are updated straight
 * away, so the composer doesn't wait for the daemon's event.
 */
export async function discardDraft(threadKey: string): Promise<void> {
  const open = detail.value;
  if (open?.thread.key === threadKey) detail.value = { ...open, draft: null };
  await saveDraft(threadKey, "");
}

/** An agent draft the composer should show next (restored by Undo, or put back by Edit). */
export const focusDraft = signal<string | null>(null);

function replaceDraft(next: AgentDraft): void {
  agentDrafts.value = agentDrafts.value.map((d) => (d.id === next.id ? next : d));
}

function dropDraft(id: string): void {
  agentDrafts.value = agentDrafts.value.filter((d) => d.id !== id);
}

/** Each agent draft's saves, in order, so a send always carries the latest revision. */
const draftSaves = new Map<string, Promise<void>>();

function afterSaves(id: string): Promise<void> {
  return draftSaves.get(id) ?? Promise.resolve();
}

/** Saves the user's edit to an agent draft (the composer debounces these). */
export function saveAgentDraft(id: string, text: string): Promise<void> {
  const next = afterSaves(id).then(async () => {
    const current = agentDrafts.value.find((d) => d.id === id);
    if (!current || (current.text ?? current.body) === text) return;
    try {
      replaceDraft(await call("draft.update", { id, text, revision: current.revision }));
    } catch (error) {
      // Changed meanwhile (or no longer queued): the next refresh shows where it stands.
      if (!(error instanceof CommandError && error.code === "CONFLICT")) {
        notify(errorText(error), "error");
      }
      void refreshDrafts();
    }
  });
  draftSaves.set(id, next);
  void next.finally(() => {
    if (draftSaves.get(id) === next) draftSaves.delete(id);
  });
  return next;
}

/** Sends an agent draft with the text shown. Resolves true once it's on its way. */
export async function sendAgentDraft(draft: AgentDraft, text: string): Promise<boolean> {
  await afterSaves(draft.id);
  const current = agentDrafts.value.find((d) => d.id === draft.id) ?? draft;
  try {
    const result = await call("draft.send", { id: draft.id, text, revision: current.revision });
    dropDraft(draft.id);
    showMessage(result.message);
    if (draft.threadKey === null) void followNewConversation(draft.to, result.message.threadKey);
    return true;
  } catch (error) {
    if (error instanceof CommandError && error.code === "CONFLICT") {
      notify("This draft just changed", {
        tone: "error",
        body: "Check what it says now, then send it again.",
      });
    } else if (!(error instanceof CommandError && error.code === "NOT_CONNECTED")) {
      notify(errorText(error), "error");
    }
    void refreshDrafts();
    return false;
  }
}

/** Throws an agent draft away at once, with a moment to undo it. */
export async function discardAgentDraft(draft: AgentDraft): Promise<void> {
  await afterSaves(draft.id);
  dropDraft(draft.id);
  const done = await attempt(() => call("draft.discard", { id: draft.id }));
  if (!done) {
    void refreshDrafts();
    return;
  }
  notify(`Discarded ${draft.agentName}'s draft`, {
    duration: 5000,
    action: {
      label: "Undo",
      run: async () => {
        const restored = await attempt(() => call("draft.restore", { id: draft.id }));
        if (!restored) return;
        await refreshDrafts();
        focusDraft.value = restored.id;
      },
    },
  });
}

/**
 * Where a cancelled message's text goes: the open composer takes it when the user's own draft is
 * empty (returning true); otherwise it's offered to copy.
 */
let ownTextSink: ((threadKey: string, text: string) => boolean) | null = null;

/** Registers the open composer's sink; returns a function that unregisters it. */
export function setOwnTextSink(sink: NonNullable<typeof ownTextSink>): () => void {
  ownTextSink = sink;
  return () => {
    if (ownTextSink === sink) ownTextSink = null;
  };
}

/**
 * Stops a message held for its send delay. Agent messages go back in the composer's queue with
 * `requeue` (Undo of an agent draft you sent, or Edit of an agent's own send); the user's own text
 * comes back into the composer, or to copy.
 */
export async function cancelScheduled(message: Message, requeue = false): Promise<void> {
  const result = await attempt(() => call("message.cancel", { id: message.id, requeue }));
  if (!result) {
    showLatest(message.threadKey);
    return;
  }
  dropMessage(result.threadKey, message.id);
  void refreshThreads();
  if (result.draft?.state === "queued") {
    await refreshDrafts();
    focusDraft.value = result.draft.id;
    return;
  }
  if (message.agent) {
    notify(`Cancelled ${message.agent.name ?? "the agent"}'s message`);
    return;
  }
  if (ownTextSink?.(result.threadKey, result.text)) return;
  const text = result.text;
  notify("Message not sent", {
    body: "Your message box already has text in it, so the message wasn't put back there.",
    duration: 8000,
    action: {
      label: "Copy",
      run: async () => {
        const ok = await window.tincan.copyText(text);
        notify(ok ? "Copied message" : "Couldn't copy", ok ? "success" : "error");
      },
    },
  });
}

/** Sends a message held for its send delay at once. */
export async function sendNow(message: Message): Promise<void> {
  const sent = await attempt(() => call("message.sendNow", { id: message.id }));
  if (sent) showMessage(sent);
  else showLatest(message.threadKey);
}

function showLatest(key: string): void {
  if (conversations.value[key]) void loadLatest(key);
}

/**
 * The newest message still held for its send delay in a conversation, for Ctrl+Shift+Z (and
 * Ctrl+Z in an empty composer).
 */
export function latestScheduled(key: string): Message | undefined {
  const messages = conversations.value[key]?.messages ?? [];
  return messages.findLast((m) => m.status === "scheduled");
}

/**
 * Undoes the newest held send in a conversation: your message comes back; an agent draft you sent
 * goes back in the queue; an agent's own send becomes a draft to edit (nothing is lost). False when
 * there's nothing to undo.
 */
export function undoLatestScheduled(key: string): boolean {
  const message = latestScheduled(key);
  if (!message) return false;
  void cancelScheduled(message, !!message.agent);
  return true;
}

const FLAG_DONE: Record<"pinned" | "muted", [string, string]> = {
  pinned: ["Pinned", "Unpinned"],
  muted: ["Muted", "Unmuted"],
};

/** Pins or mutes a conversation, offering to undo it. */
export async function setFlag(
  key: string,
  flag: "pinned" | "muted",
  value: boolean,
  { undoable = true }: { undoable?: boolean } = {},
): Promise<void> {
  const title = threads.value.find((t) => t.key === key)?.title;
  const done =
    flag === "pinned"
      ? await attempt(() => call("thread.pin", { key, pinned: value }))
      : await attempt(() => call("thread.mute", { key, muted: value }));
  if (!done || !undoable) return;
  notify(`${FLAG_DONE[flag][value ? 0 : 1]} ${title ?? "conversation"}`, {
    tone: "success",
    action: { label: "Undo", run: () => setFlag(key, flag, !value, { undoable: false }) },
  });
}

/** The people and groups hidden from AI agents (`agents.hidden`), for Settings and group info. */
export const agentHidden = signal<OutputOf<"agents.hidden">>({ people: [], groups: [] });
/** Which hidden person each hidden number and address belongs to. */
export const hiddenHandleMap = computed(() => hiddenHandles(agentHidden.value.people));

export async function refreshAgentHidden(): Promise<void> {
  const result = await attempt(() => call("agents.hidden", {}), true);
  if (result) agentHidden.value = result;
}
const agentHiddenSoon = debounced(refreshAgentHidden, 300);

/**
 * Hides a person (a contact with all their numbers and emails, or a raw number or address) or a
 * group from AI agents, or shows them again. Conversations stay in the list either way. No
 * notification: the action's label and the Settings list show the change, and the same action
 * changes it back.
 */
export async function hideFromAgents(target: HideTarget): Promise<boolean> {
  const done = await attempt(() => call("agents.hide", target));
  if (done) afterHidingChange();
  return !!done;
}

export async function showToAgents(target: ShowTarget): Promise<boolean> {
  const done = await attempt(() => call("agents.show", target));
  if (done) afterHidingChange();
  return !!done;
}

function afterHidingChange(): void {
  void refreshAgentHidden();
  threadsSoon();
  contactsSoon();
}

/**
 * Conversations deleted but not yet gone: hidden at once, and deleted for real once the Undo
 * notification goes away (or the window closes). Deleting wipes message text, so it can't be
 * undone afterwards.
 */
const pendingDeletes = new Set<string>();

/** Deletes a conversation from Tincan (the phone keeps it), with a moment to undo it. */
export async function deleteThread(key: string): Promise<void> {
  if (pendingDeletes.has(key)) return;
  const title = threads.value.find((t) => t.key === key)?.title;
  const wasOpen = selectedKey.value === key;
  pendingDeletes.add(key);
  threadMenu.value = null;
  if (wasOpen) await select(null);
  threads.value = threads.value.filter((t) => t.key !== key);
  notify(`Deleted ${title ?? "conversation"}`, {
    tone: "success",
    body: "Your iPhone still has it. Tincan brings it back if a new message arrives.",
    action: {
      label: "Undo",
      run: async () => {
        if (!pendingDeletes.delete(key)) return;
        await refreshThreads();
        if (wasOpen && !composing.value && selectedKey.value === null) await select(key);
      },
    },
    onDismiss: () => void commitDelete(key),
  });
}

async function commitDelete(key: string): Promise<void> {
  if (!pendingDeletes.has(key)) return;
  const result = await attempt(() => call("thread.delete", { key }));
  pendingDeletes.delete(key);
  if (!result) {
    await refreshThreads();
    return;
  }
  const { [key]: _gone, ...rest } = conversations.value;
  conversations.value = rest;
}

/** Finishes pending deletes when the window goes, rather than leaving them half done. */
export function commitPendingDeletes(): void {
  for (const key of pendingDeletes) void commitDelete(key);
}

/** The group whose name is being edited in its info panel. */
export const renamingThread = signal<string | null>(null);

/** Opens a group's info panel with its name ready to edit. */
export async function startRename(key: string): Promise<void> {
  await openInfo(key);
  renamingThread.value = key;
}

/** Names a group conversation in Tincan; an empty name goes back to calling it by its members. */
export async function renameGroup(key: string, title: string): Promise<void> {
  renamingThread.value = null;
  const name = title.trim() || null;
  const current = threads.value.find((t) => t.key === key)?.title;
  if (name !== null && name === current) return;
  const saved = await attempt(() => call("group.save", { threadKey: key, title: name }));
  if (saved) await refreshThreads();
}

/** Opens a conversation with its contact or group info panel beside it. */
export async function openInfo(key: string): Promise<void> {
  threadMenu.value = null;
  infoOpen.value = true;
  await select(key);
}

export async function markRead(key: string): Promise<void> {
  await attempt(() => call("thread.markRead", { key }));
}

export async function changeSettings(change: Parameters<typeof call<"settings.set">>[1]) {
  const result = await attempt(() => call("settings.set", change));
  if (result) settings.value = result;
}

export async function refreshPhoneInfo(): Promise<void> {
  const result = await attempt(() => call("device.info", {}), true);
  if (result) phoneInfo.value = result;
}

export async function refreshBackgroundService(): Promise<void> {
  backgroundService.value = await call("service.status", {}).catch(() => null);
}

/**
 * Installs the service and enables it at login. A daemon the app started then stops so the service
 * can take its place; the app reconnects to it on its own.
 */
export async function installBackgroundService(): Promise<void> {
  const result = await attempt(() => call("service.install", {}));
  if (!result) return;
  const { handover, ...facts } = result;
  backgroundService.value = facts;
  notify(handover ? "Tincan is restarting in the background" : "Tincan will start when you login", {
    body: handover
      ? "It reconnects in a moment, then keeps running after you close this window."
      : undefined,
  });
}

/**
 * Turns the service off. When the app was connected to it, it stops and the app starts its own
 * daemon in its place.
 */
export async function disableBackgroundService(): Promise<void> {
  const result = await attempt(() => call("service.disable", {}));
  if (!result) return;
  const { handover, ...facts } = result;
  backgroundService.value = facts;
  notify("Tincan won't start when you login", {
    body: handover
      ? "It reconnects in a moment, and stops checking for messages when you quit it."
      : "It stops checking for messages when you quit it.",
  });
}

/**
 * The agents Tincan can add its MCP server to, and how any MCP client starts it: undefined until
 * loaded, null when the daemon can't set them up.
 */
export const agentSetup = signal<OutputOf<"agents.connections"> | null | undefined>(undefined);

export async function refreshAgentApps(): Promise<void> {
  agentSetup.value = (await attempt(() => call("agents.connections", {}), true)) ?? null;
}

function replaceAgentApp(app: AgentConnection): void {
  const setup = agentSetup.value;
  if (!setup) return;
  agentSetup.value = {
    ...setup,
    clients: setup.clients.map((a) => (a.client === app.client ? app : a)),
  };
}

/**
 * Adds Tincan's MCP server to an agent. Throws for the panel to show: `CONFLICT` when the app
 * has a different Tincan entry, unless `force` replaces it.
 */
export async function connectAgentApp(
  client: AgentConnection["client"],
  force = false,
): Promise<AgentConnection> {
  const app = await call("agents.connect", { client, force });
  replaceAgentApp(app);
  return app;
}

export async function disconnectAgentApp(client: AgentConnection["client"]): Promise<void> {
  replaceAgentApp(await call("agents.disconnect", { client }));
}

/** Connect, disconnect or forget the phone, then refresh what Settings shows. */
export async function phoneAction(action: "connect" | "disconnect" | "forget"): Promise<boolean> {
  const done = await attempt(() => call(`device.${action}`, {}));
  await Promise.all([refreshStatus(), refreshPhoneInfo()]);
  if (!done) return false;
  // Plain "iPhone", not its name: a notification can't be blurred, and may be on a shared screen.
  notify(
    action === "connect"
      ? "Connecting to iPhone…"
      : action === "disconnect"
        ? "iPhone disconnected"
        : "Forgot iPhone",
  );
  return true;
}

export type PairingStatus = OutputOf<"device.pair.status">;
/** The pairing under way in the daemon, while the Pair dialog is open. */
export const pairing = signal<PairingStatus | null>(null);
/** Why starting or answering a pairing failed (Bluetooth off, no adapter…), shown in the dialog. */
export const pairingError = signal<string | null>(null);

const PAIRING_ACTIVE = new Set(["searching", "pairing", "confirm"]);

/** Opens the Pair dialog and starts looking for iPhones (or pairs `address`). */
export async function startPairing(address?: string): Promise<void> {
  dialog.value = "pair";
  pairingError.value = null;
  try {
    pairing.value = await call("device.pair.start", address ? { address } : {});
  } catch (error) {
    pairingError.value = errorText(error);
  }
}

export async function confirmPairing(accept: boolean): Promise<void> {
  try {
    pairing.value = await call("device.pair.confirm", { accept });
  } catch (error) {
    pairingError.value = errorText(error);
  }
}

/** Stops a search or pairing still under way (the dialog closed). */
export async function cancelPairing(): Promise<void> {
  if (pairing.value && PAIRING_ACTIVE.has(pairing.value.state)) {
    await attempt(() => call("device.pair.cancel", {}), true);
  }
  pairing.value = null;
  pairingError.value = null;
}

const pairingSoon = debounced(async () => {
  const before = pairing.value?.state;
  const result = await attempt(() => call("device.pair.status", {}), true);
  if (!result || dialog.value !== "pair") return;
  pairing.value = result;
  if (result.state === "paired" && before !== "paired") {
    notify("iPhone paired", "success");
    await refreshStatus();
  }
}, 50);

export async function syncNow(): Promise<void> {
  const result = await attempt(() => call("sync.now", {}));
  if (!result) return;
  if (!result.synced) {
    notify("The phone isn't connected", { body: "Tincan checks for new messages when it is." });
  } else {
    notify(
      result.added === 0
        ? "Up to date"
        : `${result.added} new message${result.added === 1 ? "" : "s"}`,
      "success",
    );
  }
}

/** Contacts being re-read from the phone, so buttons can show it. */
export const contactsSyncing = signal(false);

/** Re-reads every contact from the phone (PBAP), whether or not the phone says they changed. */
export async function syncContacts(): Promise<void> {
  if (contactsSyncing.value) return;
  contactsSyncing.value = true;
  const started = notify("Refreshing contacts…", {
    tone: "info",
    body: "Reading names, numbers and photos from your iPhone.",
    duration: 60_000,
  });
  try {
    const result = await attempt(() => call("contact.sync", { force: true }));
    if (!result) return;
    refreshPhotos();
    await refreshContacts();
    const changes = result.changed + result.removed;
    notify(
      changes === 0
        ? "Contacts are up to date"
        : `${changes} contact${changes === 1 ? "" : "s"} updated`,
      {
        tone: "success",
        body: `${result.contacts} contacts from your iPhone${result.photos ? `, ${result.photos} new photo${result.photos === 1 ? "" : "s"}` : ""}.`,
      },
    );
    if (dialog.value === "settings") await refreshPhoneInfo();
  } finally {
    dismissToast(started);
    contactsSyncing.value = false;
  }
}

let searchSeq = 0;
export async function runSearch(query: string): Promise<void> {
  searchQuery.value = query;
  const seq = ++searchSeq;
  if (!query.trim()) {
    searchResults.value = null;
    return;
  }
  const results = await attempt(() => call("message.search", { query, limit: 100 }), true);
  if (seq === searchSeq) searchResults.value = results ?? [];
}

export async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshThreads(),
    refreshStatus(),
    refreshLinkLog(),
    refreshContacts(),
    refreshSettings(),
    refreshDrafts(),
    refreshAgentHidden(),
  ]);
  // Someone who already set Tincan up but has no "welcomed" flag (it lives in browser storage,
  // which starts fresh when the app's origin changes) shouldn't be sent back through onboarding.
  if (!welcomed.value && (status.value?.phone.device || threads.value.length > 0)) finishWelcome();
  const key = selectedKey.value;
  if (key) await Promise.all([loadDetail(key), loadLatest(key)]);
}

/** Coalesce bursts of events into one refresh per kind. */
function debounced(work: () => Promise<void>, ms = 120): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => void work(), ms);
  };
}

const threadsSoon = debounced(refreshThreads);
const draftsSoon = debounced(refreshDrafts);
const statusSoon = debounced(async () => {
  await Promise.all([refreshStatus(), refreshLinkLog()]);
  if (dialog.value === "settings") await refreshPhoneInfo();
}, 250);
const contactsSoon = debounced(refreshContacts, 500);
const pending = new Set<string>();
const messagesSoon = debounced(async () => {
  const keys = [...pending];
  pending.clear();
  await Promise.all(keys.filter((key) => conversations.value[key]).map((key) => loadLatest(key)));
  markReadIfVisible();
});

export function handleEvent(event: TincanEvent): void {
  switch (event.event) {
    case "thread.changed":
      threadsSoon();
      draftsSoon();
      agentHiddenSoon();
      if (selectedKey.value && event.data.keys.includes(selectedKey.value)) {
        void loadDetail(selectedKey.value);
      }
      break;
    case "message.changed":
      threadsSoon();
      if (conversations.value[event.data.threadKey]) {
        pending.add(event.data.threadKey);
        messagesSoon();
      }
      break;
    case "message.sendStatus":
      for (const [key, conversation] of Object.entries(conversations.value)) {
        if (conversation.messages.some((m) => m.id === event.data.id)) {
          pending.add(key);
          messagesSoon();
        }
      }
      break;
    case "contact.changed":
      refreshPhotos();
      contactsSoon();
      threadsSoon();
      agentHiddenSoon();
      break;
    case "device.changed":
    case "sync.changed":
      statusSoon();
      break;
    case "pairing.changed":
      if (dialog.value === "pair") pairingSoon();
      break;
    case "notifications.changed":
      notifications.value = event.data.state;
      break;
    case "draft.changed":
      draftsSoon();
      if (event.data.threadKey && conversations.value[event.data.threadKey]) {
        pending.add(event.data.threadKey);
        messagesSoon();
      }
      break;
    case "settings.changed":
      if (allSettings(event.data)) settings.value = event.data;
      break;
    case "daemon.stopping":
      break;
  }
}

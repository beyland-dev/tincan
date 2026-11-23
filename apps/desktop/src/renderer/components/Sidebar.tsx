import type { Message, Thread } from "@beyland/tincan-protocol";
import { useRef } from "preact/hooks";
import { threadHideAction } from "../agent-hiding.ts";
import { ownDraftOf, rowDraft, type PendingRecipient, type RowDraft } from "../draft-rows.ts";
import { formatHandle, listTime, messageTime, preview } from "../format.ts";
import {
  composing,
  deleteThread,
  openSettings,
  draftsByKey,
  listedRows,
  names,
  openInfo,
  openWelcome,
  pendingThread,
  runSearch,
  searchQuery,
  searchResults,
  select,
  selectedKey,
  setFlag,
  contactsByHandle,
  hideFromAgents,
  showToAgents,
  settings,
  startRename,
  setSidebarWidth,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  sidebarCollapsed,
  sidebarWidth,
  startCompose,
  threadMenu,
  threads,
  threadsLoaded,
  toggleSidebar,
  welcomed,
  welcomeOpen,
} from "../store.ts";
import { Avatar, ThreadAvatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { ConnectionDock } from "./ConnectionDock.tsx";
import { TincanAvatar } from "./Welcome.tsx";

export function Sidebar() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onInput = (value: string) => {
    searchQuery.value = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(value), 150);
  };
  const pinned = threads.value.filter((t) => t.pinned);

  return (
    <aside class="sidebar">
      <header class="sidebar-header">
        <SidebarToggle />
        <h1>Tincan</h1>
        <div class="toolbar">
          <button
            class="icon-button"
            data-tip="Settings"
            aria-label="Settings"
            onClick={() => openSettings()}
          >
            <Icon name="settings" />
          </button>
          <button
            class="icon-button"
            data-tip="New message (Ctrl+N)"
            aria-label="New message"
            onClick={startCompose}
          >
            <Icon name="compose" />
          </button>
        </div>
      </header>
      <label class="search">
        <Icon name="search" size={15} />
        <input
          type="search"
          placeholder="Search"
          value={searchQuery.value}
          onInput={(e) => onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onInput("");
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <div class="thread-list" role="listbox" aria-label="Conversations">
        {searchResults.value ? (
          <SearchResults results={searchResults.value} />
        ) : (
          <>
            {pinned.length > 0 && (
              <div class="pinned-grid">
                {pinned.map((t) => (
                  <PinnedThread key={t.key} thread={t} />
                ))}
              </div>
            )}
            {composing.value && (
              <div class="thread-row active new-row" role="option" aria-selected="true">
                <span class="avatar new-avatar">
                  <Icon name="compose" size={18} />
                </span>
                <span class="thread-text">
                  <span class="thread-title">New Message</span>
                </span>
              </div>
            )}
            {(welcomeOpen.value || !welcomed.value) && (
              <button
                role="option"
                aria-selected={welcomeOpen.value}
                class={`thread-row ${welcomeOpen.value ? "active" : ""}`}
                onClick={openWelcome}
              >
                <span class="row-avatar">
                  <TincanAvatar />
                </span>
                <span class="thread-text">
                  <span class="thread-top">
                    <span class="thread-title">Tincan</span>
                  </span>
                  <span class="thread-preview">Getting started</span>
                </span>
              </button>
            )}
            {listedRows.value.map((row) =>
              row.kind === "thread" ? (
                <ThreadRow key={row.key} thread={row.thread} />
              ) : (
                <PendingRow key={row.key} pending={row.pending} />
              ),
            )}
            {threadsLoaded.value && threads.value.length === 0 && (
              <p class="empty">
                No conversations yet. New messages from your iPhone will show up here.
              </p>
            )}
          </>
        )}
      </div>
      <ConnectionDock />
      <ThreadMenu />
      <Resizer />
    </aside>
  );
}

/** Shows or hides the sidebar (Ctrl+B); outside the sidebar while it's hidden. */
export function SidebarToggle({ floating = false }: { floating?: boolean }) {
  const open = !sidebarCollapsed.value;
  return (
    <button
      class={`icon-button sidebar-toggle ${floating ? "floating" : ""}`}
      data-tip={open ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
      aria-label="Sidebar"
      aria-pressed={open}
      onClick={toggleSidebar}
    >
      <Icon name={open ? "sidebarFilled" : "sidebar"} />
    </button>
  );
}

/** The sidebar's right edge: drag (or use the arrow keys) to resize it. */
function Resizer() {
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = sidebarWidth.value;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-resizing");
    const move = (e: PointerEvent) => setSidebarWidth(startWidth + e.clientX - startX);
    const end = () => {
      document.body.classList.remove("sidebar-resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      class="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={sidebarWidth.value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDblClick={() => setSidebarWidth(300)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setSidebarWidth(sidebarWidth.value - 10);
        else if (e.key === "ArrowRight") setSidebarWidth(sidebarWidth.value + 10);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** A pinned contact goes by their first name; groups and bare numbers keep the whole title. */
function pinnedTitle(thread: Thread): string {
  if (thread.kind === "group" || !names.value.has(thread.key)) {
    return thread.title;
  }
  return thread.title.split(/\s+/)[0] ?? thread.title;
}

function PinnedThread({ thread }: { thread: Thread }) {
  const active = selectedKey.value === thread.key;
  return (
    <button
      class={`pinned ${active ? "active" : ""}`}
      onClick={() => void select(thread.key)}
      onContextMenu={(e) => openMenu(e, thread.key)}
      data-tip={thread.title}
      data-tip-delay="long"
    >
      <div class="pinned-avatar">
        <ThreadAvatar thread={thread} size={52} />
        {thread.unread > 0 && <span class="dot" />}
      </div>
      <span class="pinned-title">{pinnedTitle(thread)}</span>
    </button>
  );
}

/**
 * "Draft: …" in place of the last message, for a row with a draft waiting: the user's own or an
 * agent's, which look the same here.
 */
function DraftPreview({ draft }: { draft: RowDraft }) {
  return (
    <span class="thread-preview has-draft">
      <span class="draft-label">Draft</span>
      {draft.count > 1 && (
        <span class="draft-count" aria-label={`${draft.count} drafts`}>
          {draft.count}
        </span>
      )}
      <span aria-hidden="true">: </span>
      <span class="sr-only">, </span>
      {draft.text}
    </span>
  );
}

/**
 * Someone with drafts waiting (agents' or the user's own) and no conversation yet; opens the new
 * conversation's view.
 */
function PendingRow({ pending }: { pending: PendingRecipient }) {
  const thread = pendingThread(pending);
  const active = selectedKey.value === pending.to;
  const draft = rowDraft(pending.own, pending.drafts);
  return (
    <button
      role="option"
      aria-selected={active}
      class={`thread-row ${active ? "active" : ""} ${draft ? "with-draft" : ""}`}
      onClick={() => void select(pending.to)}
    >
      <span class="row-avatar">
        <ThreadAvatar thread={thread} />
      </span>
      <span class="thread-text">
        <span class="thread-top">
          <span class="thread-title">{thread.title}</span>
          <span class="thread-time">{listTime(pending.at)}</span>
        </span>
        {draft && <DraftPreview draft={draft} />}
      </span>
    </button>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const active = selectedKey.value === thread.key;
  const last = thread.lastMessage;
  const draft = rowDraft(ownDraftOf(thread), draftsByKey.value.get(thread.key) ?? []);
  return (
    <button
      role="option"
      aria-selected={active}
      class={`thread-row ${active ? "active" : ""} ${thread.unread > 0 ? "unread" : ""} ${draft ? "with-draft" : ""}`}
      onClick={() => void select(thread.key)}
      onContextMenu={(e) => openMenu(e, thread.key)}
    >
      <span class="row-avatar">
        <ThreadAvatar thread={thread} />
        {thread.unread > 0 && <span class="unread-dot" aria-label={`${thread.unread} unread`} />}
      </span>
      <span class="thread-text">
        <span class="thread-top">
          <span class="thread-title">{thread.title}</span>
          {thread.muted && <Icon name="bellOff" size={13} />}
          <span class="thread-time">{last ? listTime(messageTime(last)) : ""}</span>
        </span>
        {draft ? (
          <DraftPreview draft={draft} />
        ) : (
          <span class="thread-preview">{preview(thread, names.value)}</span>
        )}
      </span>
    </button>
  );
}

function openMenu(event: MouseEvent, key: string): void {
  event.preventDefault();
  threadMenu.value = { key, x: event.clientX, y: event.clientY };
}

/** Right-click actions for a conversation in the list. */
function ThreadMenu() {
  const menu = threadMenu.value;
  const thread = menu && threads.value.find((t) => t.key === menu.key);
  if (!menu || !thread) return null;
  const agents = threadHideAction(
    thread,
    contactsByHandle.value.get(thread.members[0] ?? thread.key),
    settings.value,
  );
  const close = () => (threadMenu.value = null);
  const act = (work: () => void) => () => {
    close();
    work();
  };
  return (
    <div
      class="menu-backdrop"
      onClick={close}
      onContextMenu={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div
        class="context-menu"
        role="menu"
        style={{
          left: `${Math.min(menu.x, window.innerWidth - 200)}px`,
          top: `${Math.min(menu.y, window.innerHeight - 200)}px`,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <button role="menuitem" onClick={act(() => void openInfo(thread.key))}>
          {thread.kind === "group" ? "Group info" : "Contact info"}
        </button>
        <button
          role="menuitem"
          onClick={act(() => void setFlag(thread.key, "pinned", !thread.pinned))}
        >
          {thread.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          role="menuitem"
          onClick={act(() => void setFlag(thread.key, "muted", !thread.muted))}
        >
          {thread.muted ? "Unmute" : "Mute"}
        </button>
        {thread.kind === "group" && (
          <button role="menuitem" onClick={act(() => void startRename(thread.key))}>
            Rename…
          </button>
        )}
        {agents && (
          <button
            role="menuitem"
            class={agents.kind === "explain" ? "muted" : undefined}
            data-tip={agents.kind === "explain" ? agents.hint : undefined}
            onClick={act(() => {
              if (agents.kind === "hide") void hideFromAgents(agents.target);
              else if (agents.kind === "show") void showToAgents(agents.target);
              else void openInfo(thread.key);
            })}
          >
            {agents.label}
          </button>
        )}
        <hr />
        <button role="menuitem" class="danger" onClick={act(() => void deleteThread(thread.key))}>
          Delete Conversation
        </button>
      </div>
    </div>
  );
}

function SearchResults({ results }: { results: Message[] }) {
  if (results.length === 0) return <p class="empty">No messages match.</p>;
  const byKey = new Map(threads.value.map((t) => [t.key, t]));
  return (
    <>
      <p class="section-label">Messages</p>
      {results.map((m) => {
        const thread = byKey.get(m.threadKey);
        const title =
          thread?.title ?? (m.sender ? (names.value.get(m.sender) ?? formatHandle(m.sender)) : "");
        return (
          <button key={m.id} class="thread-row" onClick={() => void select(m.threadKey)}>
            {thread ? (
              <ThreadAvatar thread={thread} />
            ) : (
              <Avatar name={title} group={m.threadKey.startsWith("group:")} />
            )}
            <span class="thread-text">
              <span class="thread-top">
                <span class="thread-title">{title}</span>
                <span class="thread-time">{listTime(messageTime(m))}</span>
              </span>
              <span class="thread-preview multi">
                <Highlight text={m.body} query={searchQuery.value} />
              </span>
            </span>
          </button>
        );
      })}
    </>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const words = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

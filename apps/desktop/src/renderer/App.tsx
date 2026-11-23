import { useEffect } from "preact/hooks";
import { Toasts } from "./components/Banners.tsx";
import { Tooltip } from "./components/Tooltip.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { Dialogs } from "./components/Dialogs.tsx";
import { NewConversation } from "./components/NewConversation.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { Welcome } from "./components/Welcome.tsx";
import {
  composing,
  dialog,
  openSettings,
  dockOpen,
  focusSearch,
  infoOpen,
  markReadIfVisible,
  openInfo,
  openNextDrafts,
  picked,
  select,
  selectedKey,
  sidebarCollapsed,
  sidebarWidth,
  startCompose,
  threads,
  toggleSidebar,
  totalUnread,
  welcomeOpen,
} from "./store.ts";

function step(offset: number): void {
  const list = threads.value;
  if (list.length === 0) return;
  const index = list.findIndex((t) => t.key === selectedKey.value);
  const next = list[Math.max(0, Math.min(list.length - 1, index + offset))];
  if (next) void select(next.key);
}

export function App() {
  const unread = totalUnread.value;

  useEffect(() => window.tincan.setUnread(unread), [unread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        dialog.value = dialog.value === "palette" ? null : "palette";
      } else if (mod && e.key === "n") {
        e.preventDefault();
        startCompose();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (mod && e.key === "f") {
        e.preventDefault();
        focusSearch();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        const key = selectedKey.value;
        if (infoOpen.value) infoOpen.value = false;
        else if (key && !composing.value) void openInfo(key);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        // The next conversation with agent drafts waiting.
        if (openNextDrafts()) e.preventDefault();
      } else if (mod && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Escape" && dialog.value) {
        e.preventDefault();
        dialog.value = null;
      } else if (e.key === "Escape" && dockOpen.value) {
        e.preventDefault();
        dockOpen.value = false;
      } else if (e.key === "Escape" && picked.value) {
        e.preventDefault();
        picked.value = null;
      } else if (e.key === "Escape" && infoOpen.value) {
        e.preventDefault();
        infoOpen.value = false;
      }
    };
    const onFocus = () => markReadIfVisible();
    window.addEventListener("keydown", onKey);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div
      class={`app platform-${window.tincan.platform} ${sidebarCollapsed.value ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth.value}px` }}
    >
      {!sidebarCollapsed.value && <Sidebar />}
      <div class="main">
        {composing.value ? <NewConversation /> : welcomeOpen.value ? <Welcome /> : <Conversation />}
      </div>
      {/* After .main: Electron applies drag regions in document order, so a no-drag button
          before the conversation header's drag region would be swallowed by it. */}
      {sidebarCollapsed.value && <SidebarToggle floating />}
      <Dialogs />
      <Toasts />
      <Tooltip />
    </div>
  );
}

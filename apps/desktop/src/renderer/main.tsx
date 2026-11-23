import { render } from "preact";
import { App } from "./App.tsx";
import {
  connection,
  commitPendingDeletes,
  handleEvent,
  loadLinkPreviews,
  loadSpellcheck,
  loadTheme,
  refreshAll,
  select,
} from "./store.ts";
import "./styles.css";

const bridge = window.tincan;

function onState(state: typeof connection.value): void {
  const wasConnected = connection.value.state === "connected";
  connection.value = state;
  if (state.state === "connected" && !wasConnected) void refreshAll();
}

bridge.onState(onState);
bridge.onEvent(handleEvent);
bridge.onOpenThread((key) => void select(key));
void bridge.state().then(onState);
void loadTheme();
void loadLinkPreviews();
void loadSpellcheck();
window.addEventListener("pagehide", commitPendingDeletes);

const root = document.getElementById("app");
if (root) render(<App />, root);

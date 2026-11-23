import { spawn } from "node:child_process";
import { closeSync, existsSync, readFile } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ensureDaemon,
  ReconnectingClient,
  TincanClient,
  type ConnectOptions,
} from "@beyland/tincan-client";
import { TincanError } from "@beyland/tincan-protocol";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  Tray,
  type WebContents,
} from "electron";
import { CHANNELS, type BridgeState, type RunResult, type Theme } from "../shared/bridge.ts";
import { namedTheme, schemeOf } from "../shared/themes.ts";
import {
  isTheme,
  overlayFor,
  readPreferences,
  TITLEBAR_HEIGHT,
  writePreferences,
} from "./appearance.ts";
import { daemonLogPath, openDaemonLog, rotateDaemonLog } from "./daemon-log.ts";
import { checkRequest, isTrustedUrl, threadArg, toWireError } from "./gate.ts";
import { fetchPreview, isWebUrl, setImageResizer } from "./preview.ts";
import { APP_INDEX, APP_SCHEME, mimeType, resolveAppPath } from "./protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Development overrides only: a packaged app always loads its own files and its bundled daemon.
const devUrl = app.isPackaged ? undefined : process.env.TINCAN_DESKTOP_DEV_URL;
const rendererRoot = path.join(here, "renderer");
const iconPath = path.join(here, "..", "resources", "app-icon-rounded.png");
const readFileAsync = promisify(readFile);

// Must happen before the app is ready. Standard + secure gives app://tincan a real origin of its
// own, so CSP 'self', storage and the IPC checks are scoped to Tincan's files.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

app.setName("Tincan");
app.setPath("userData", path.join(app.getPath("appData"), "Tincan"));
if (process.platform === "linux") app.setDesktopName("tincan-desktop.desktop");

const initialThread = process.env.TINCAN_OPEN_THREAD || threadArg(process.argv);

if (!app.requestSingleInstanceLock({ openThread: initialThread })) {
  app.quit();
} else {
  void start();
}

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingThread = initialThread;
let preferencesFile = "";

async function start(): Promise<void> {
  const noSpawn = process.env.TINCAN_DESKTOP_NO_SPAWN === "1";
  const options: ConnectOptions = {
    client: { kind: "desktop", name: "Tincan" },
    // Sends hold the request open while the phone answers; the daemon times them out itself.
    timeoutMs: 120_000,
  };
  const client = new ReconnectingClient({
    connect: () =>
      noSpawn ? ensureDaemon({ ...options, service: null, spawn: null }) : connect(options),
  });

  const bridgeState = (): BridgeState => {
    const s = client.state;
    return s.state === "connected" ? { state: "connected", version: s.hello.server.version } : s;
  };
  const broadcast = (channel: string, value: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, value);
  };
  client.onState(() => broadcast(CHANNELS.stateChanged, bridgeState()));
  client.subscribe((event) => broadcast(CHANNELS.event, event));

  const trusted = (event: { senderFrame?: { url: string } | null }) =>
    isTrustedUrl(event.senderFrame?.url ?? "", devUrl);

  ipcMain.handle(CHANNELS.run, async (event, name: unknown, input: unknown): Promise<RunResult> => {
    if (!trusted(event)) {
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "Untrusted page" } };
    }
    const checked = checkRequest(name, input);
    if (!checked.ok) return checked;
    try {
      return { ok: true, result: await client.call(name as string, checked.input) };
    } catch (error) {
      return { ok: false, error: toWireError(error) };
    }
  });
  ipcMain.handle(CHANNELS.state, (event) => (trusted(event) ? bridgeState() : null));
  ipcMain.handle(CHANNELS.getTheme, (event) =>
    trusted(event) ? readPreferences(preferencesFile).theme : "system",
  );
  ipcMain.handle(CHANNELS.setTheme, (event, theme: unknown) => {
    const current = readPreferences(preferencesFile);
    if (!trusted(event) || !isTheme(theme)) return current.theme;
    writePreferences(preferencesFile, { ...current, theme });
    showTheme(theme);
    return theme;
  });
  ipcMain.on(CHANNELS.previewTheme, (event, theme: unknown) => {
    if (!trusted(event)) return;
    showTheme(isTheme(theme) ? theme : readPreferences(preferencesFile).theme);
  });
  ipcMain.handle(CHANNELS.linkPreview, (event, url: unknown) => {
    if (!trusted(event) || typeof url !== "string" || url.length > 2048) return null;
    if (!readPreferences(preferencesFile).linkPreviews) return null;
    return fetchPreview(url);
  });
  ipcMain.handle(CHANNELS.getLinkPreviews, (event) =>
    trusted(event) ? readPreferences(preferencesFile).linkPreviews : false,
  );
  ipcMain.handle(CHANNELS.setLinkPreviews, (event, on: unknown) => {
    const current = readPreferences(preferencesFile);
    if (!trusted(event) || typeof on !== "boolean") return current.linkPreviews;
    writePreferences(preferencesFile, { ...current, linkPreviews: on });
    return on;
  });
  ipcMain.handle(CHANNELS.getSpellcheck, (event) =>
    trusted(event) ? readPreferences(preferencesFile).spellcheck : false,
  );
  ipcMain.handle(CHANNELS.setSpellcheck, (event, on: unknown) => {
    const current = readPreferences(preferencesFile);
    if (!trusted(event) || typeof on !== "boolean") return current.spellcheck;
    writePreferences(preferencesFile, { ...current, spellcheck: on });
    applySpellcheck(on);
    return on;
  });
  ipcMain.handle(CHANNELS.copyText, async (event, text: unknown) => {
    if (!trusted(event) || typeof text !== "string" || text.length > 100_000) return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.on(CHANNELS.unread, (event, count: unknown) => {
    if (!trusted(event)) return;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return;
    app.setBadgeCount(count);
    tray?.setToolTip(count > 0 ? `Tincan — ${count} unread` : "Tincan");
  });

  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    const data = additionalData as { openThread?: unknown } | undefined;
    const fromData =
      typeof data?.openThread === "string" && data.openThread ? data.openThread : undefined;
    const key = fromData ?? threadArg(argv);
    showWindow();
    if (key) window?.webContents.send(CHANNELS.openThread, key);
  });
  app.on("before-quit", () => {
    quitting = true;
    void client.close();
  });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
  app.on("web-contents-created", (_event, contents) => guardContents(contents));

  await app.whenReady();
  preferencesFile = path.join(app.getPath("userData"), "preferences.json");
  lockDownSession();
  serveRenderer();
  applySpellcheck(readPreferences(preferencesFile).spellcheck);
  setImageResizer(resizeImage);
  nativeTheme.themeSource = schemeOf(readPreferences(preferencesFile).theme);
  nativeTheme.on("updated", () => {
    if (process.platform === "darwin") return;
    for (const w of BrowserWindow.getAllWindows()) {
      w.setTitleBarOverlay(overlayFor(nativeTheme.shouldUseDarkColors));
    }
  });
  allowYouTubeEmbeds();
  Menu.setApplicationMenu(null);
  createTray();
  showWindow();
}

/** Navigation, new windows and webviews: nothing leaves Tincan's own pages except the player. */
function guardContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url, devUrl)) event.preventDefault();
  });
  // Frames inside the page: its own iframes may only be YouTube players; frames inside a player
  // stay on the web.
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const nested = !!event.frame?.parent?.parent;
    if (!allowedFrameUrl(event.url, nested)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // Web Bluetooth would otherwise pick the first device it finds.
  contents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
}

function allowedFrameUrl(url: string, nested: boolean): boolean {
  if (url === "about:blank") return true;
  if (nested) return url === "about:srcdoc" || /^https:\/\//i.test(url);
  return url.startsWith("https://www.youtube-nocookie.com/embed/");
}

/** No permissions, devices or device pickers for any page. */
function lockDownSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  s.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  s.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  s.on("select-serial-port", (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback("");
  });
  s.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}

/** Serves `app://tincan/…` from the built renderer, and nothing outside it. */
function serveRenderer(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(request.url, rendererRoot);
    const type = file && mimeType(file);
    if (!file || !type || request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await readFileAsync(file);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": type,
          "x-content-type-options": "nosniff",
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

/** Chromium's dictionaries on Linux come from Google's CDN, the first time spell check runs. */
const DICTIONARY_URL = "https://redirector.gvt1.com/edgedl/chrome/dict/";
/** The discard port on this machine: with spell check off, no download can leave it. */
const NO_DICTIONARY_URL = "http://127.0.0.1:9/";

function applySpellcheck(on: boolean): void {
  const s = session.defaultSession;
  s.setSpellCheckerDictionaryDownloadURL(on ? DICTIONARY_URL : NO_DICTIONARY_URL);
  s.setSpellCheckerEnabled(on);
}

/** Large still images in link previews are scaled down before they reach the renderer. */
function resizeImage(
  body: Buffer,
  type: string,
  max: number,
): { body: Buffer; type: string } | null {
  if (type !== "image/png" && type !== "image/jpeg") return null;
  const image = nativeImage.createFromBuffer(body);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= max) return null;
  const scaled = image.resize(
    width >= height ? { width: max, quality: "good" } : { height: max, quality: "good" },
  );
  return type === "image/png"
    ? { body: scaled.toPNG(), type }
    : { body: scaled.toJPEG(85), type: "image/jpeg" };
}

/**
 * YouTube refuses to play embeds without an http(s) Referer (error 153), and an app:// page has
 * none to send. The players in messages get one naming the app.
 */
function allowYouTubeEmbeds(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube-nocookie.com/embed/*"] },
    ({ requestHeaders }, callback) => {
      if (!/^https?:/i.test(requestHeaders.Referer ?? "")) {
        requestHeaders.Referer = "https://dev.beyland.tincan/";
      }
      callback({ requestHeaders });
    },
  );
}

function showTheme(theme: Theme): void {
  nativeTheme.themeSource = schemeOf(theme);
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground(theme));
}

/** What the window shows before the page paints, so a themed window doesn't flash. */
function windowBackground(theme: Theme): string {
  return namedTheme(theme)?.bg ?? (nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff");
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 640,
    minHeight: 440,
    title: "Tincan",
    show: false,
    autoHideMenuBar: true,
    // The app draws its own titlebar; the window controls sit over it.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: (TITLEBAR_HEIGHT - 16) / 2 } }
      : { titleBarOverlay: overlayFor(nativeTheme.shouldUseDarkColors) }),
    backgroundColor: windowBackground(readPreferences(preferencesFile).theme),
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  w.once("ready-to-show", () => w.show());
  w.webContents.on("did-finish-load", () => {
    if (pendingThread) {
      w.webContents.send(CHANNELS.openThread, pendingThread);
      pendingThread = undefined;
    }
  });
  w.on("close", (event) => {
    if (tray && !quitting) {
      event.preventDefault();
      w.hide();
    }
  });
  w.on("closed", () => {
    if (window === w) window = null;
  });
  void w.loadURL(devUrl ?? APP_INDEX);
  return w;
}

function showWindow(): void {
  if (!app.isReady()) return;
  window ??= createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(): void {
  if (!existsSync(iconPath)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip("Tincan");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Tincan", click: showWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

/**
 * Connects to the daemon, starting it when nothing answers: the systemd user service when it's
 * enabled (via `ensureDaemon`), otherwise a detached daemon of the app's own, whose output goes to
 * `daemonLogPath()` instead of nowhere.
 */
async function connect(options: ConnectOptions): Promise<TincanClient> {
  try {
    return await ensureDaemon({ ...options, spawn: null });
  } catch (error) {
    if (!(error instanceof TincanError) || error.code !== "NOT_CONNECTED") throw error;
  }
  spawnDaemon(daemonCommand());
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await TincanClient.connect(options);
    } catch (error) {
      const retryable = error instanceof TincanError && error.code === "NOT_CONNECTED";
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

let logRotation: NodeJS.Timeout | undefined;

function spawnDaemon(spec: { command: string; args: string[]; env?: NodeJS.ProcessEnv }): void {
  const logFile = daemonLogPath();
  let fd: number | "ignore" = "ignore";
  try {
    fd = openDaemonLog(logFile);
  } catch {
    // An unwritable state folder shouldn't stop the daemon starting.
  }
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: spec.env ?? process.env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    if (typeof fd === "number") closeSync(fd);
  }
  // The daemon outlives the window; keep its log in check while the app runs.
  logRotation ??= setInterval(() => rotateDaemonLog(logFile), 10 * 60_000);
  logRotation.unref();
}

/**
 * What starts the daemon when none is running:
 * 1. `$TINCAN_DAEMON_COMMAND` + `$TINCAN_DAEMON_ARGS` (dev scripts; ignored when packaged),
 * 2. the bundled daemon inside a packaged AppImage/.deb (via `ELECTRON_RUN_AS_NODE=1`),
 * 3. `tincan daemon` on `$PATH`.
 */
function daemonCommand(): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const command = app.isPackaged ? undefined : process.env.TINCAN_DAEMON_COMMAND;
  if (command) {
    const raw = process.env.TINCAN_DAEMON_ARGS;
    const parsed: unknown = raw ? JSON.parse(raw) : ["daemon"];
    const args = Array.isArray(parsed) ? parsed.map(String) : ["daemon"];
    return { command, args };
  }
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "daemon", "dist", "bin.mjs");
    if (existsSync(bundled)) {
      return {
        command: process.execPath,
        args: [bundled, "daemon"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return { command: "tincan", args: ["daemon"] };
}

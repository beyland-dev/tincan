// Install a .desktop entry for this checkout's built app, so GNOME and other desktops show its name
// and icon in the dock and app grid while running from source. Packaged builds ship their own.
//
//   pnpm --filter @beyland/tincan-desktop install-desktop-entry [--remove]
//
// The file name matches the window's app id (`app.setDesktopName` in src/main/index.ts), which is
// how the desktop links the running window to the entry.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ID = "tincan-desktop";
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const dir = path.join(dataHome, "applications");
const file = path.join(dir, `${DESKTOP_ID}.desktop`);

/** Quotes an Exec argument per the desktop entry spec. */
const quote = (arg) => `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;

if (process.argv.includes("--remove")) {
  rmSync(file, { force: true });
  console.log(`Removed ${file}`);
} else {
  const exec = [realpathSync(process.execPath), path.join(desktopRoot, "scripts", "start.mjs")];
  const entry = `[Desktop Entry]
Type=Application
Name=Tincan
Comment=Your iPhone's messages on Linux
Exec=${exec.map(quote).join(" ")} %U
Icon=${path.join(desktopRoot, "resources", "app-icon-rounded.png")}
Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass=${DESKTOP_ID}
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, entry);
  console.log(`Wrote ${file}`);
}

try {
  execFileSync("update-desktop-database", [dir], { stdio: "ignore" });
} catch {
  // Optional: desktops also notice the change on their own.
}

// A private dbus-daemon for tests, with no `<servicedir>`: nothing (obexd,
// BlueZ) can be activated on it, so code under test can never reach the real
// services or the phone.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dbusDaemon = ["/usr/bin/dbus-daemon", "/bin/dbus-daemon"].find((p) => existsSync(p));

/** Starts the daemon; resolves `{ address, stop }`. */
export async function startPrivateBus(prefix) {
  // Unix socket paths are limited to ~108 bytes; a long $TMPDIR (some sandboxes) won't fit.
  const base = tmpdir().length > 50 ? "/tmp" : tmpdir();
  const dir = mkdtempSync(join(base, prefix));
  const config = join(dir, "bus.conf");
  writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${join(dir, "bus")}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
  );
  const daemon = spawn(dbusDaemon, [`--config-file=${config}`, "--nofork", "--print-address"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => {
    daemon.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const address = await new Promise((resolve, reject) => {
      let text = "";
      daemon.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(text.split("\n")[0].trim());
      });
      daemon.on("exit", (code) => reject(new Error(`dbus-daemon exited (${code})`)));
    });
    return { address, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

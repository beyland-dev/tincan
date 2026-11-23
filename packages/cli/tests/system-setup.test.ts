import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { setupInvocation } from "../src/system.ts";

describe("setupInvocation", () => {
  it("runs the script through sudo without ELECTRON_RUN_AS_NODE", () => {
    const run = setupInvocation("/opt/setup.sh", "install", {
      needsRoot: true,
      yes: true,
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" },
    });
    expect(run).toEqual({
      command: "sudo",
      args: ["/opt/setup.sh", "install", "--yes"],
      env: { PATH: "/bin" },
    });
  });

  it("runs status directly and never passes --yes to it", () => {
    expect(
      setupInvocation("/opt/setup.sh", "status", { needsRoot: false, yes: true, env: {} }),
    ).toEqual({ command: "/opt/setup.sh", args: ["status"], env: {} });
  });
});

describe("tincan-system-setup.sh", () => {
  /** A copy of the script that edits `dir/main.conf` and records the commands it runs. */
  function sandbox() {
    const dir = mkdtempSync(path.join(tmpdir(), "tincan-setup-sh-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["systemctl", "udevadm", "btmgmt"]) {
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${dir}/calls"\n`, {
        mode: 0o755,
      });
    }
    const source = readFileSync(
      new URL("../../../packaging/system-setup/tincan-system-setup.sh", import.meta.url),
      "utf8",
    );
    const script = source
      .replace(/^MAIN_CONF=.*$/m, `MAIN_CONF="${dir}/main.conf"`)
      .replace(/^UNIT_DEST=.*$/m, `UNIT_DEST="${dir}/out/unit"`)
      .replace(/^UDEV_DEST=.*$/m, `UDEV_DEST="${dir}/out/rule"`)
      .replace(/^ {2}if \[\[ "\$\{EUID.*$/m, "  if false; then");
    writeFileSync(path.join(dir, "setup.sh"), script);
    for (const file of ["tincan-btclass@.service", "90-tincan-btclass.rules"]) {
      writeFileSync(path.join(dir, file), "");
    }
    const run = (...args: string[]) =>
      spawnSync("bash", [path.join(dir, "setup.sh"), ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    return { dir, conf: path.join(dir, "main.conf"), run };
  }

  it("enables Experimental and restores the original line on uninstall, in place", () => {
    const { dir, conf, run } = sandbox();
    try {
      const original =
        "[General]\nName = laptop\nExperimental = false\n\n[Policy]\nAutoEnable=true\n";
      writeFileSync(conf, original, { mode: 0o640 });
      const inode = statSync(conf).ino;
      const install = run("install");
      expect(install.status).toBe(0);
      expect(install.stderr).toContain("disconnect");
      const installed = readFileSync(conf, "utf8");
      expect(installed).toContain("# Experimental = false (replaced by tincan-system-setup)");
      expect(installed).toMatch(/# Added by tincan-system-setup\nExperimental = true\n\[Policy\]/);
      expect(run("uninstall").status).toBe(0);
      expect(readFileSync(conf, "utf8")).toBe(original);
      expect(statSync(conf).ino).toBe(inode);
      expect(statSync(conf).mode & 0o777).toBe(0o640);
      expect(readdirSync(dir).filter((f) => f.includes("main.conf."))).toEqual([]);
      expect(readFileSync(path.join(dir, "calls"), "utf8")).toContain(
        "systemctl restart bluetooth.service",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves main.conf alone when an edit comes out wrong", () => {
    const { dir, conf, run } = sandbox();
    try {
      writeFileSync(conf, "[General]\nName = laptop\n");
      // A broken awk must fail the run, not replace the file with an empty one.
      const bin = path.join(dir, "bin");
      writeFileSync(path.join(bin, "awk"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const install = run("install");
      expect(install.status).not.toBe(0);
      expect(readFileSync(conf, "utf8")).toBe("[General]\nName = laptop\n");
      expect(readdirSync(dir).filter((f) => f.includes("main.conf."))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

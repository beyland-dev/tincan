#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md: license texts for third-party code that Tincan redistributes.
//
//  - Rust crates statically linked into the native addon (normal dependencies of `tincan-napi` on
//    Linux targets; proc-macro crates only run at compile time and are left out), plus SQLCipher,
//    which `libsqlite3-sys` compiles in from its `sqlcipher-src` build dependency.
//  - JS packages bundled into the desktop app's main/preload/renderer bundles (bare imports under
//    apps/desktop/src and the production closure of its workspace dependencies).
//  - JS packages staged next to the daemon by apps/desktop/scripts/stage-daemon.mjs.
//
// Texts are read from the cargo registry (`cargo metadata` manifest paths) and node_modules, so run
// `pnpm install` and `cargo fetch` first. Versions are deliberately omitted so routine dependency
// bumps don't make the file stale; adding/removing a dependency or a license change does.
//
// Usage: node scripts/third-party-notices.mjs [--check]
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "THIRD_PARTY_NOTICES.md");
const check = process.argv.includes("--check");

const RUST_TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];
const NAPI_CRATE = "tincan-napi";
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;

/** @typedef {{ name: string, license: string, texts: string[], usedIn: string, repository?: string }} Component */
/** @type {Map<string, Component>} keyed by `${usedIn}\0${name}` */
const components = new Map();
const warnings = [];

function addComponent(name, license, texts, usedIn, repository) {
  const key = `${usedIn}\0${name}`;
  const existing = components.get(key);
  if (existing) {
    for (const t of texts) if (!existing.texts.includes(t)) existing.texts.push(t);
    return;
  }
  if (texts.length === 0) warnings.push(`${name} (${usedIn}): no license file found`);
  components.set(key, { name, license: license || "UNKNOWN", texts, usedIn, repository });
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function licenseFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((f) => normalize(readFileSync(path.join(dir, f), "utf8")))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Rust: the native addon.

const NATIVE = "Native addon (`@beyland/tincan-native`, also inside the desktop app)";

const SQLITE_BLESSING = `The author disclaims copyright to this source code. In place of a legal notice, here is a blessing:

    May you do good and not evil.
    May you find forgiveness for yourself and forgive others.
    May you share freely, never taking more than you give.`;

function cargoMetadata(target) {
  const out = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--filter-platform", target],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

for (const target of RUST_TARGETS) {
  const meta = cargoMetadata(target);
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const start = meta.packages.find((p) => p.name === NAPI_CRATE && p.source == null);
  if (!start) throw new Error(`workspace crate ${NAPI_CRATE} not found`);

  const seen = new Set();
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = pkgs.get(id);
    const node = nodes.get(id);
    if (pkg.targets.some((t) => t.kind.includes("proc-macro"))) continue;
    if (pkg.source != null) {
      addComponent(
        pkg.name,
        pkg.license,
        licenseFilesIn(path.dirname(pkg.manifest_path)),
        NATIVE,
        pkg.repository ?? undefined,
      );
    }
    for (const dep of node.deps) {
      const normal = dep.dep_kinds.some((k) => k.kind == null);
      if (normal) queue.push(dep.pkg);
      // libsqlite3-sys's `bundled-sqlcipher` compiles the SQLCipher amalgamation from this
      // build dependency into the addon, so its license applies to the shipped binary.
      if (pkg.name === "libsqlite3-sys" && dep.name.replace(/-/g, "_") === "sqlcipher_src") {
        addSqlcipher(pkgs.get(dep.pkg), node.features ?? []);
      }
    }
  }
}

function addSqlcipher(pkg, features) {
  if (!features.includes("bundled-sqlcipher")) return;
  const dir = path.join(path.dirname(pkg.manifest_path), "sqlcipher");
  const licensePath = path.join(dir, "LICENSE-sqlcipher");
  if (!existsSync(licensePath)) throw new Error(`SQLCipher license not found at ${licensePath}`);
  const version = pkg.version.match(/sqlcipher-([\d.]+)/)?.[1];
  addComponent(
    `SQLCipher${version ? ` ${version}` : ""} (compiled in via sqlcipher-src)`,
    "BSD-3-Clause",
    [normalize(readFileSync(licensePath, "utf8"))],
    NATIVE,
  );
  // The amalgamation's SQLite core is public domain. libtomcrypt is only compiled for targets
  // without a system crypto library; Linux builds use the system's libcrypto (OpenSSL 3).
  addComponent(
    "SQLite (inside the SQLCipher amalgamation)",
    "blessing (public domain)",
    [SQLITE_BLESSING],
    NATIVE,
  );
}

// ---------------------------------------------------------------------------------------------
// JS: desktop bundles and the staged daemon.

const DESKTOP = "Desktop app bundle (main, preload and renderer)";
const DAEMON = "Desktop app's bundled daemon (`resources/daemon`)";

/** Resolves `dep` walking upward from `fromDir` through node_modules (pnpm virtual-store aware). */
function resolvePackageDir(dep, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", dep);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const readPkg = (dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
const workspaceDirs = new Map(
  readdirSync(path.join(root, "packages"))
    .filter((d) => existsSync(path.join(root, "packages", d, "package.json")))
    .map((d) => [readPkg(path.join(root, "packages", d)).name, path.join(root, "packages", d)]),
);

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/** Adds the production `dependencies` closure of `deps` (resolved from `fromDir`) to `usedIn`. */
function addJsClosure(deps, fromDir, usedIn) {
  const queue = deps.map((dep) => ({ dep, fromDir }));
  const seen = new Set();
  while (queue.length > 0) {
    const { dep, fromDir: from } = queue.shift();
    if (workspaceDirs.has(dep)) {
      const wsDir = workspaceDirs.get(dep);
      if (seen.has(wsDir)) continue;
      seen.add(wsDir);
      for (const d of Object.keys(readPkg(wsDir).dependencies ?? {})) {
        queue.push({ dep: d, fromDir: wsDir });
      }
      continue;
    }
    const dir = resolvePackageDir(dep, from);
    if (!dir) throw new Error(`Cannot resolve "${dep}" from ${from}; run \`pnpm install\` first`);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readPkg(dir);
    addComponent(pkg.name, licenseOf(pkg), licenseFilesIn(dir), usedIn);
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ dep: d, fromDir: dir });
  }
}

// Desktop: everything the bundler pulls in. Bare imports under src/ (Electron and node: builtins
// stay external) plus the closure of the app's workspace dependencies.
const desktopDir = path.join(root, "apps/desktop");
const bare = new Set();
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (/\.(m?[jt]sx?|css)$/.test(entry.name)) {
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"'./][^"']*)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("node:") || spec === "electron") continue;
        const parts = spec.split("/");
        bare.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  }
}
scan(path.join(desktopDir, "src"));
const desktopPkg = readPkg(desktopDir);
addJsClosure(
  [...new Set([...bare, ...Object.keys(desktopPkg.dependencies ?? {})])].sort((a, b) =>
    a.localeCompare(b, "en"),
  ),
  desktopDir,
  DESKTOP,
);

// Daemon: mirror the package list in stage-daemon.mjs.
const stageScript = readFileSync(path.join(desktopDir, "scripts/stage-daemon.mjs"), "utf8");
const listMatch = stageScript.match(/const packages = \[([^\]]*)\]/);
if (!listMatch) throw new Error("Could not find `const packages = [...]` in stage-daemon.mjs");
const staged = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
for (const short of staged) {
  const dir = path.join(root, "packages", short);
  addJsClosure(
    Object.keys(readPkg(dir).dependencies ?? {}).filter((d) => !d.startsWith("@beyland/")),
    dir,
    DAEMON,
  );
}

// ---------------------------------------------------------------------------------------------
// Render.

function kindOf(text) {
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Mozilla Public License,? (version|v\.?) ?2\.0/i.test(text)) return "MPL-2.0";
  if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /endorse or promote/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/This is free and unencumbered software released into the public domain/i.test(text)) {
    return "Unlicense";
  }
  if (/This software is provided ['‘]as-is['’]/i.test(text)) return "Zlib";
  if (/UNICODE LICENSE|Unicode, Inc\./i.test(text)) return "Unicode";
  if (/disclaims copyright to this source code/i.test(text)) return "Public domain";
  return "Other notice";
}

const sorted = [...components.values()].sort(
  (a, b) => a.usedIn.localeCompare(b.usedIn, "en") || a.name.localeCompare(b.name, "en"),
);

/** @type {Map<string, { text: string, kind: string, users: Set<string> }>} */
const groups = new Map();
for (const c of sorted) {
  for (const text of c.texts) {
    const key = text.replace(/\s+/g, " ").trim();
    if (!groups.has(key)) groups.set(key, { text, kind: kindOf(text), users: new Set() });
    groups.get(key).users.add(c.name);
  }
}
const orderedGroups = [...groups.values()]
  .map((g) => ({ ...g, users: [...g.users].sort((a, b) => a.localeCompare(b, "en")) }))
  .sort((a, b) => a.kind.localeCompare(b.kind, "en") || a.users[0].localeCompare(b.users[0], "en"));

const lines = [
  "# Third-party notices",
  "",
  "<!-- Generated by `node scripts/third-party-notices.mjs`. Do not edit by hand. -->",
  "",
  "Tincan is MIT-licensed (see `LICENSE` and `NOTICE`). Its native addon, desktop app and the daemon",
  "bundled with the desktop app redistribute the third-party components below, whose licenses",
  "require these notices. The native addon links the system's OpenSSL 3 `libcrypto` dynamically;",
  "OpenSSL is not redistributed. Electron and Chromium license files ship alongside the desktop app",
  "(`LICENSE.electron.txt`, `LICENSES.chromium.html`).",
  "",
];

const usedInOrder = [NATIVE, DESKTOP, DAEMON];
for (const usedIn of usedInOrder) {
  const list = sorted.filter((c) => c.usedIn === usedIn);
  if (list.length === 0) continue;
  lines.push(`## ${usedIn}`, "", "| Component | License |", "| --- | --- |");
  for (const c of list)
    lines.push(`| ${c.name.replace(/\|/g, "\\|")} | ${c.license.replace(/\|/g, "\\|")} |`);
  lines.push("");
}

lines.push("## License texts", "");
lines.push(
  "Each text appears once; the components using it are listed above it. Dual-licensed crates",
  "list every license text they ship.",
  "",
);
for (const g of orderedGroups) {
  lines.push(
    `### ${g.kind}`,
    "",
    `Used by: ${g.users.join(", ")}`,
    "",
    "~~~~text",
    g.text,
    "~~~~",
    "",
  );
}
const missing = sorted.filter((c) => c.texts.length === 0);
if (missing.length > 0) {
  lines.push("## Components without a license file", "");
  lines.push(
    "These packages declare a license but ship no license text; the identified license applies,",
    "with its standard text above and the copyright holders named in the project's repository.",
    "",
  );
  for (const c of missing) {
    lines.push(`- ${c.name}: ${c.license}${c.repository ? ` (${c.repository})` : ""}`);
  }
  lines.push("");
}

// Run the repo formatter over the result so `vp check` and `--check` agree on the bytes.
const output = execFileSync(
  path.join(root, "node_modules/.bin/vp"),
  ["fmt", "--stdin-filepath=THIRD_PARTY_NOTICES.md"],
  { cwd: root, input: `${lines.join("\n").replace(/\n+$/, "")}\n`, encoding: "utf8" },
);

for (const w of warnings) console.warn(`warning: ${w}`);
if (check) {
  const current = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  if (current !== output) {
    console.error(
      "THIRD_PARTY_NOTICES.md is stale. Run `node scripts/third-party-notices.mjs` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${components.size} components).`);
} else {
  writeFileSync(outFile, output);
  console.log(
    `Wrote THIRD_PARTY_NOTICES.md: ${components.size} components, ${orderedGroups.length} license texts.`,
  );
}

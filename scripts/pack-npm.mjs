#!/usr/bin/env node
// Builds the npm tarballs for a release without publishing anything.
//
//  1. Turns the downloaded `.node` artifacts into napi platform packages
//     (`@beyland/tincan-native-linux-<arch>-gnu`) and packs them with npm.
//  2. Points `@beyland/tincan-native`'s optionalDependencies at those packages (restored after).
//  3. `pnpm pack`s every public workspace package, which rewrites `workspace:`/`catalog:` ranges
//     and applies `publishConfig`.
//  4. Verifies each tarball and writes `manifest.json` (publish order, sha256) next to them.
//
// Run `pnpm build` first. Usage:
//   node scripts/pack-npm.mjs --out <dir> [--artifacts packages/native/artifacts]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const outDir = path.resolve(opt("--out", path.join(root, "npm-tarballs")));
const artifactsDir = path.resolve(opt("--artifacts", path.join(root, "packages/native/artifacts")));
const nativeDir = path.join(root, "packages/native");
const NOTICE_FILES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const version = readJson(path.join(root, "package.json")).version;
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: "inherit" });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Public workspace packages in dependency order.
const workspace = new Map();
for (const dir of readdirSync(path.join(root, "packages"))) {
  const file = path.join(root, "packages", dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = readJson(file);
  if (!pkg.private) workspace.set(pkg.name, { dir: path.join(root, "packages", dir), pkg });
}
const ordered = [];
const visit = (name, stack = []) => {
  if (ordered.includes(name)) return;
  if (stack.includes(name)) throw new Error(`Dependency cycle: ${[...stack, name].join(" -> ")}`);
  const { pkg } = workspace.get(name);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (workspace.has(dep)) visit(dep, [...stack, name]);
    }
  }
  ordered.push(name);
};
for (const name of [...workspace.keys()].sort((a, b) => a.localeCompare(b))) visit(name);

// 1. Platform packages from the release artifacts.
const napi = path.join(nativeDir, "node_modules/.bin/napi");
const nodeFiles = existsSync(artifactsDir)
  ? readdirSync(artifactsDir).filter((f) => f.endsWith(".node"))
  : [];
if (nodeFiles.length === 0) throw new Error(`No .node artifacts in ${artifactsDir}`);
rmSync(path.join(nativeDir, "npm"), { recursive: true, force: true });
const nodesBefore = new Set(readdirSync(nativeDir).filter((f) => f.endsWith(".node")));
run(napi, ["create-npm-dirs"], nativeDir);
run(napi, ["artifacts", "--output-dir", path.relative(nativeDir, artifactsDir)], nativeDir);
// `napi artifacts` also drops copies next to the loader; keep the checkout as it was.
for (const f of readdirSync(nativeDir)) {
  if (f.endsWith(".node") && !nodesBefore.has(f)) rmSync(path.join(nativeDir, f));
}

const manifest = [];
const platformNames = [];
const staging = mkdtempSync(path.join(os.tmpdir(), "tincan-npm-"));
const nativePkg = readJson(path.join(nativeDir, "package.json"));
for (const platform of readdirSync(path.join(nativeDir, "npm")).sort()) {
  const src = path.join(nativeDir, "npm", platform);
  const pkg = readJson(path.join(src, "package.json"));
  const binary = pkg.main;
  if (!existsSync(path.join(src, binary))) {
    throw new Error(`${pkg.name}: ${binary} missing; was the ${platform} artifact downloaded?`);
  }
  if (pkg.version !== version)
    throw new Error(`${pkg.name} is at ${pkg.version}, expected ${version}`);
  // Pack outside the repo: npm refuses to run under the root's pnpm-only devEngines.
  const dest = path.join(staging, platform);
  mkdirSync(dest);
  for (const f of readdirSync(src)) copyFileSync(path.join(src, f), path.join(dest, f));
  for (const f of NOTICE_FILES) copyFileSync(path.join(root, f), path.join(dest, f));
  pkg.files = [...new Set([...(pkg.files ?? []), "NOTICE", "THIRD_PARTY_NOTICES.md"])];
  pkg.author = nativePkg.author;
  pkg.keywords = nativePkg.keywords;
  writeFileSync(path.join(dest, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], dest);
  platformNames.push(pkg.name);
  manifest.push({ name: pkg.name, file: tarballName(pkg.name) });
}
rmSync(staging, { recursive: true, force: true });

// 2 + 3. Workspace packages; the native loader resolves the platform packages at runtime.
const nativeJsonPath = path.join(nativeDir, "package.json");
const nativeJson = readFileSync(nativeJsonPath, "utf8");
try {
  const pkg = JSON.parse(nativeJson);
  pkg.optionalDependencies = Object.fromEntries(platformNames.map((n) => [n, version]));
  writeFileSync(nativeJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const name of ordered) {
    run("pnpm", ["pack", "--pack-destination", outDir], workspace.get(name).dir);
    manifest.push({ name, file: tarballName(name) });
  }
} finally {
  writeFileSync(nativeJsonPath, nativeJson);
}

function tarballName(name) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

// 4. Verify.
const errors = [];
for (const entry of manifest) {
  const file = path.join(outDir, entry.file);
  if (!existsSync(file)) {
    errors.push(`${entry.name}: expected tarball ${entry.file}`);
    continue;
  }
  const files = execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ""));
  const pkg = JSON.parse(
    execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }),
  );
  const fail = (msg) => errors.push(`${entry.name}: ${msg}`);
  if (pkg.name !== entry.name) fail(`tarball is named ${pkg.name}`);
  if (pkg.version !== version) fail(`version ${pkg.version}, expected ${version}`);
  if (pkg.private) fail("is private");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (/^(workspace|catalog|link|file):/.test(range)) fail(`${field}.${dep} is "${range}"`);
      if (dep === "@beyland/tincan-fake-phone") fail(`depends on unpublished ${dep}`);
    }
  }
  for (const required of ["package.json", "LICENSE", "README.md"]) {
    if (!files.includes(required)) fail(`missing ${required}`);
  }
  if (entry.name.startsWith("@beyland/tincan-native")) {
    for (const f of ["NOTICE", "THIRD_PARTY_NOTICES.md"])
      if (!files.includes(f)) fail(`missing ${f}`);
  }
  const isPlatform = platformNames.includes(entry.name);
  const nodes = files.filter((f) => f.endsWith(".node"));
  if (isPlatform ? nodes.length !== 1 : nodes.length > 0) fail(`unexpected .node files: ${nodes}`);
  // Everything exports/bin/main point at must be in the tarball.
  const targets = [];
  const collect = (v) => {
    if (typeof v === "string") targets.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(pkg.exports);
  collect(pkg.bin);
  collect(pkg.main);
  collect(pkg.types);
  for (const t of targets) {
    const rel = t.replace(/^\.\//, "");
    if (!rel.includes("*") && !files.includes(rel)) fail(`entry point ${t} is not in the tarball`);
    if (rel.startsWith("src/")) fail(`entry point ${t} points at source, not dist`);
  }
  entry.version = pkg.version;
  entry.sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  entry.files = files.length;
}

writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const e of manifest) console.log(`${e.file}  ${e.files ?? "?"} files  ${e.sha256 ?? ""}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`Packed ${manifest.length} tarballs for ${version} into ${outDir}`);

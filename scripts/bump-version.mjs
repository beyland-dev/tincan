#!/usr/bin/env node
// Bumps the version across all workspace package.json files and Cargo.toml in lockstep.
//
// Usage: node scripts/bump-version.mjs 0.1.0
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <semver>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep in sync with scripts/check-release-version.mjs (the release guard).
const jsonFiles = ["package.json", "apps/desktop/package.json"];
for (const dir of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
  const rel = `packages/${dir.name}/package.json`;
  if (dir.isDirectory() && existsSync(path.join(root, rel))) jsonFiles.push(rel);
}

for (const rel of jsonFiles) {
  const file = path.join(root, rel);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

const cargoPath = path.join(root, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updatedCargo = cargo.replace(
  /(\[workspace\.package\]\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);
if (updatedCargo === cargo) {
  throw new Error("Could not find [workspace.package] version in Cargo.toml");
}
writeFileSync(cargoPath, updatedCargo);

// Keep Cargo.lock's workspace crate entries in step so `cargo --locked` builds keep working.
const lockPath = path.join(root, "Cargo.lock");
let lock = readFileSync(lockPath, "utf8");
for (const crate of readdirSync(path.join(root, "crates"))) {
  lock = lock.replace(
    new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]+(")`),
    `$1${version}$2`,
  );
}
writeFileSync(lockPath, lock);

console.log(
  `Updated ${jsonFiles.length} package.json files, Cargo.toml and Cargo.lock to ${version}.`,
);
console.log("Next: run `pnpm build:native` so packages/native/index.js embeds the new version.");

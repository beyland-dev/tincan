#!/usr/bin/env node
// Release guard: every versioned file must agree, and (when a tag is given) match the tag.
// Refuses 0.0.0 unless --allow-unversioned is passed (used by branch dry runs only).
//
// Usage:
//   node scripts/check-release-version.mjs --tag v0.1.0
//   node scripts/check-release-version.mjs --allow-unversioned   # consistency only
//
// With GITHUB_OUTPUT set, writes `version`, `prerelease` and `npm-tag` outputs.
import { appendFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];
const allowUnversioned = args.includes("--allow-unversioned");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const errors = [];
/** @type {Map<string, string>} file -> version */
const found = new Map();

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

// Keep in sync with scripts/bump-version.mjs.
const jsonFiles = ["package.json", "apps/desktop/package.json"];
for (const dir of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
  const rel = `packages/${dir.name}/package.json`;
  if (dir.isDirectory() && existsSync(path.join(root, rel))) jsonFiles.push(rel);
}
for (const rel of jsonFiles) found.set(rel, readJson(rel).version);

const cargoToml = readFileSync(path.join(root, "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(/\[workspace\.package\]\nversion = "([^"]+)"/)?.[1];
found.set("Cargo.toml [workspace.package]", cargoVersion);

const cargoLock = readFileSync(path.join(root, "Cargo.lock"), "utf8");
for (const crate of readdirSync(path.join(root, "crates"))) {
  const m = cargoLock.match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`),
  );
  if (m) found.set(`Cargo.lock ${crate}`, m[1]);
}

const version = found.get("package.json");
if (!version || !SEMVER.test(version))
  errors.push(`root package.json version "${version}" is not semver`);

for (const [file, v] of found) {
  if (v !== version) errors.push(`${file} is at "${v}", root package.json is at "${version}"`);
}

// napi embeds the package version in the generated loader's version check.
const loader = readFileSync(path.join(root, "packages/native/index.js"), "utf8");
const embedded = new Set([...loader.matchAll(/expected (\S+) but got/g)].map((m) => m[1]));
if (embedded.size !== 1 || !embedded.has(version)) {
  errors.push(
    `packages/native/index.js embeds version(s) ${[...embedded].join(", ") || "none"}; run \`pnpm build:native\` after bumping`,
  );
}

if (tag !== undefined) {
  if (!/^v\d/.test(tag)) errors.push(`tag "${tag}" must look like v<semver>`);
  else if (tag.slice(1) !== version)
    errors.push(`tag "${tag}" does not match version "${version}"`);
}

if (version === "0.0.0" && !allowUnversioned) {
  errors.push("refusing to release 0.0.0; run `node scripts/bump-version.mjs <version>` first");
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}

const prerelease = version.includes("-");
console.log(`Versions agree: ${version}${tag ? ` (tag ${tag})` : ""} across ${found.size} files.`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nprerelease=${prerelease}\nnpm-tag=${prerelease ? "next" : "latest"}\n`,
  );
}

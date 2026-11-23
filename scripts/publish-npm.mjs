#!/usr/bin/env node
// Publishes the tarballs produced by scripts/pack-npm.mjs, in manifest order. Idempotent: a
// name@version already on the registry is skipped, so a rerun after a partial failure resumes.
// Runs no package code: it only calls `npm view` and `npm publish <tarball>`.
//
// Auth: npm trusted publishing (OIDC, needs `id-token: write`) or, for the one-time bootstrap,
// NODE_AUTH_TOKEN. Provenance is attached either way.
//
// Usage: node scripts/publish-npm.mjs --dir <tarball dir> --tag <dist-tag> [--dry-run]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const dir = path.resolve(opt("--dir") ?? "");
const tag = opt("--tag");
const dryRun = args.includes("--dry-run");
if (!opt("--dir") || !tag) {
  console.error("Usage: node scripts/publish-npm.mjs --dir <dir> --tag <dist-tag> [--dry-run]");
  process.exit(1);
}

// Run npm from an empty directory: the repo root's devEngines only allows pnpm, and a userconfig
// here carries the bootstrap token when one is provided.
const cwd = mkdtempSync(path.join(os.tmpdir(), "tincan-publish-"));
const env = { ...process.env };
if (process.env.NODE_AUTH_TOKEN) {
  const npmrc = path.join(cwd, ".npmrc");
  writeFileSync(npmrc, "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n", { mode: 0o600 });
  env.NPM_CONFIG_USERCONFIG = npmrc;
  console.log(
    "Using NODE_AUTH_TOKEN (bootstrap). Remove the NPM_TOKEN secret once trusted publishing is set up.",
  );
}
env.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";

const npm = (argv, opts = {}) =>
  execFileSync("npm", argv, { cwd, env, encoding: "utf8", stdio: opts.stdio ?? "pipe" });

function published(name, version) {
  try {
    return npm(["view", `${name}@${version}`, "version", "--json"]).trim() !== "";
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/E404|404 Not Found|is not in this registry/.test(out)) return false;
    throw error;
  }
}

const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
let done = 0;
let skipped = 0;
for (const { name, version, file, sha256 } of manifest) {
  const tarball = path.join(dir, file);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (digest !== sha256)
    throw new Error(`${file}: sha256 ${digest} does not match manifest ${sha256}`);
  if (version === "0.0.0" && !dryRun) throw new Error(`${name}: refusing to publish 0.0.0`);

  if (published(name, version)) {
    console.log(`skip    ${name}@${version} (already on npm)`);
    skipped++;
    continue;
  }
  const argv = ["publish", tarball, "--access", "public", "--tag", tag];
  if (dryRun) argv.push("--dry-run");
  else argv.push("--provenance");
  console.log(`${dryRun ? "dry-run" : "publish"} ${name}@${version} --tag ${tag}`);
  npm(argv, { stdio: "inherit" });
  done++;
}
console.log(
  `${dryRun ? "Dry-ran" : "Published"} ${done}, skipped ${skipped} of ${manifest.length}.`,
);

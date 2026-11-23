#!/usr/bin/env node
// `prepack` helper: copies repo-root files (LICENSE, NOTICE, THIRD_PARTY_NOTICES.md) into the
// package being packed, since `files` can't reference paths outside the package directory.
// The copies are git-ignored.
//
// Usage (from a package directory): node ../../scripts/copy-package-files.mjs LICENSE [NOTICE ...]
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("Usage: node scripts/copy-package-files.mjs <root file>...");
  process.exit(1);
}
for (const name of names) {
  if (name !== path.basename(name)) throw new Error(`Expected a repo-root file name, got ${name}`);
  const src = path.join(root, name);
  if (!existsSync(src)) throw new Error(`${name} is missing at the repo root`);
  copyFileSync(src, path.join(process.cwd(), name));
}

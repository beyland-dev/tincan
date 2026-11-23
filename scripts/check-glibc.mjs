#!/usr/bin/env node
// Fails if a native binary needs a newer glibc (or OpenSSL) symbol version than we support.
// The floor is Ubuntu 22.04 / Debian 12 class systems: glibc 2.35 and OpenSSL 3.0.
//
// Usage: node scripts/check-glibc.mjs [--max-glibc 2.35] [--max-openssl 3.0.0] <file.node>...
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args.splice(i, 2)[1];
};
const maxGlibc = take("--max-glibc", "2.35");
const maxOpenssl = take("--max-openssl", "3.0.0");
const files = args;
if (files.length === 0) {
  console.error("Usage: node scripts/check-glibc.mjs [--max-glibc X.Y] <file>...");
  process.exit(1);
}

const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
const highest = (versions) => versions.sort(cmp).at(-1);

let failed = false;
for (const file of files) {
  const symbols = execFileSync("objdump", ["-T", file], { encoding: "utf8" });
  const needed = execFileSync("objdump", ["-p", file], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim().startsWith("NEEDED"))
    .map((l) => l.trim().split(/\s+/)[1]);
  const glibc = highest([
    ...new Set([...symbols.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)].map((m) => m[1])),
  ]);
  const openssl = highest([
    ...new Set([...symbols.matchAll(/OPENSSL_(\d+(?:\.\d+)+)/g)].map((m) => m[1])),
  ]);
  console.log(
    `${file}: needs GLIBC_${glibc ?? "-"}, OPENSSL_${openssl ?? "-"}; NEEDED ${needed.join(" ")}`,
  );
  if (glibc && cmp(glibc, maxGlibc) > 0) {
    console.error(`::error file=${file}::requires GLIBC_${glibc}, above the ${maxGlibc} floor`);
    failed = true;
  }
  if (openssl && cmp(openssl, maxOpenssl) > 0) {
    console.error(`::error file=${file}::requires OPENSSL_${openssl}, above ${maxOpenssl}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);

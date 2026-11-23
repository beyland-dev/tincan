// Stages the built `tincan` CLI/daemon, native Bluetooth addon, and all transitive runtime
// dependencies into `resources/daemon/` so electron-builder bundles them in AppImage and .deb.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");
const outDir = path.join(desktopRoot, "resources/daemon");

// The fake phone (`@beyland/tincan-fake-phone`) is test and demo code and isn't shipped.
const packages = ["protocol", "client", "core", "daemon", "mcp", "cli"];

// The napi-rs artifact for the arch being packaged (CI packages each arch on a matching runner).
const arch = process.env.TINCAN_STAGE_ARCH || process.arch;
const napiArch = { x64: "x64", arm64: "arm64", arm: "arm-gnueabihf" }[arch];
if (!napiArch) throw new Error(`Don't know the native addon name for arch "${arch}"`);
const nativeArtifact = `tincan-native.linux-${napiArch}-gnu.node`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "node_modules/@beyland"), { recursive: true });

// Copy the CLI's built `dist/` and `package.json` into `resources/daemon/` (keeping `../package.json`
// layout intact) along with each workspace package's built `dist/` + `package.json`.
const cliSrc = path.join(repoRoot, "packages/cli");
const cliDist = path.join(cliSrc, "dist");
if (!existsSync(path.join(cliDist, "bin.mjs"))) {
  throw new Error("Run `pnpm build` before staging the desktop daemon bundle.");
}
cpSync(cliDist, path.join(outDir, "dist"), { recursive: true });
cpSync(path.join(cliSrc, "package.json"), path.join(outDir, "package.json"));

const thirdPartyQueue = [];
for (const pkg of packages) {
  const src = path.join(repoRoot, "packages", pkg);
  const name = pkg === "cli" ? "tincan" : `tincan-${pkg}`;
  const dest = path.join(outDir, "node_modules/@beyland", name);
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(src, "dist"), path.join(dest, "dist"), { recursive: true });
  const raw = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8"));
  if (raw.publishConfig?.exports) raw.exports = raw.publishConfig.exports;
  if (raw.publishConfig?.bin) raw.bin = raw.publishConfig.bin;
  writeFileSync(path.join(dest, "package.json"), JSON.stringify(raw, null, 2));

  for (const dep of Object.keys(raw.dependencies ?? {})) {
    if (!dep.startsWith("@beyland/")) thirdPartyQueue.push({ dep, fromDir: src, by: raw.name });
  }
}

// Copy @beyland/tincan-native: index.js, index.d.ts, package.json and only the addon built for
// this arch (a stray debug build or another arch's binary in the folder is left out).
const nativeSrc = path.join(repoRoot, "packages/native");
const nativeDest = path.join(outDir, "node_modules/@beyland/tincan-native");
mkdirSync(nativeDest, { recursive: true });
if (!existsSync(path.join(nativeSrc, nativeArtifact))) {
  throw new Error(
    `packages/native/${nativeArtifact} is missing: run \`pnpm build:native\` (or set TINCAN_STAGE_ARCH) before staging.`,
  );
}
for (const entry of readdirSync(nativeSrc)) {
  if (
    entry === "index.js" ||
    entry === "index.d.ts" ||
    entry === "package.json" ||
    entry === nativeArtifact
  ) {
    cpSync(path.join(nativeSrc, entry), path.join(nativeDest, entry));
  } else if (entry.endsWith(".node")) {
    console.warn(`Not staging packages/native/${entry} (not ${nativeArtifact})`);
  }
}

/** Resolves `dep` walking upward from `fromDir` through `node_modules` (pnpm virtual store aware). */
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

// Recursively copy every third-party runtime dependency and its transitive dependencies into one
// flat node_modules. That holds one version per name, so two different versions are an error to fix
// (e.g. with a pnpm override) rather than one silently standing in for the other.
const copied = new Map(); // name -> { version, by }
while (thirdPartyQueue.length > 0) {
  const { dep, fromDir, by } = thirdPartyQueue.shift();
  const resolved = resolvePackageDir(dep, fromDir);
  if (!resolved) {
    throw new Error(`Could not resolve runtime dependency "${dep}" from ${fromDir}`);
  }
  const { version } = JSON.parse(readFileSync(path.join(resolved, "package.json"), "utf8"));
  const seen = copied.get(dep);
  if (seen) {
    if (seen.version !== version) {
      throw new Error(
        `Runtime dependency "${dep}" is needed at two versions: ${seen.version} (by ${seen.by}) and ${version} (by ${by}). The staged bundle can hold only one.`,
      );
    }
    continue;
  }
  copied.set(dep, { version, by });
  const dest = path.join(outDir, "node_modules", dep);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(resolved, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      // Skip nested node_modules inside pnpm store entries; transitive deps are queued below.
      if (
        src !== resolved &&
        path.basename(src) === "node_modules" &&
        lstatSync(src).isDirectory()
      ) {
        return false;
      }
      return true;
    },
  });
  const pkgJson = JSON.parse(readFileSync(path.join(resolved, "package.json"), "utf8"));
  for (const transitive of Object.keys(pkgJson.dependencies ?? {})) {
    // In pnpm's virtual store, sibling deps sit in `resolved`'s parent `node_modules`. Already
    // copied names are queued too, so a second version is caught above.
    thirdPartyQueue.push({ dep: transitive, fromDir: resolved, by: `${dep}@${version}` });
  }
}

console.log(`Staged desktop daemon bundle in ${outDir} (${copied.size} third-party packages)`);

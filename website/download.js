// Fills the download page from the latest GitHub release: the cards get this computer's
// architecture, the note under them links the other one. Without JavaScript, or if the API is
// unreachable, every link still opens the releases page.

const REPO = "beyland-dev/tincan";
const CACHE_KEY = "tincan-latest-release";
const CACHE_MS = 10 * 60 * 1000;

const EXTENSIONS = { appimage: /\.AppImage$/i, deb: /\.deb$/i };
const ARCHES = { x64: /(x64|x86_64|amd64)/i, arm64: /(arm64|aarch64)/i };
const LABELS = { x64: "x86_64", arm64: "arm64" };

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, release } = JSON.parse(raw);
    return Date.now() - at < CACHE_MS ? release : null;
  } catch {
    return null;
  }
}

function writeCache(release) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the page works without it.
  }
}

/** The latest published release, or null when there isn't one yet. */
async function latestRelease() {
  const cached = readCache();
  if (cached) return cached;
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const data = await response.json();
  const release = {
    tag: data.tag_name,
    url: data.html_url,
    publishedAt: data.published_at,
    assets: data.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
  writeCache(release);
  return release;
}

/** "x64" or "arm64"; x64 when the browser doesn't say. */
async function detectArch() {
  try {
    const ua = navigator.userAgentData;
    if (ua && ua.getHighEntropyValues) {
      const { architecture } = await ua.getHighEntropyValues(["architecture"]);
      if (architecture === "arm") return "arm64";
      if (architecture === "x86") return "x64";
    }
  } catch {
    // Fall back to the user agent string.
  }
  return /aarch64|arm64/i.test(navigator.userAgent) ? "arm64" : "x64";
}

function findAsset(release, kind, arch) {
  return release?.assets.find((a) => EXTENSIONS[kind].test(a.name) && ARCHES[arch].test(a.name));
}

function age(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function fill(release, arch) {
  const other = arch === "x64" ? "arm64" : "x64";
  document.querySelector("[data-alt-question]").textContent =
    other === "arm64" ? "On ARM?" : "On an Intel or AMD computer?";
  document.querySelector("[data-alt-name]").textContent = LABELS[other];
  document.querySelector("[data-arch-name]").textContent = LABELS[arch];

  for (const link of document.querySelectorAll("a[data-asset]")) {
    const kind = link.dataset.asset;
    const target = link.dataset.arch === "primary" ? arch : other;
    const asset = findAsset(release, kind, target);
    if (asset) link.href = asset.url;
    else if (release) link.href = release.url;
  }

  if (release) {
    const version = release.tag.replace(/^v/, "");
    document.getElementById("release-label").textContent =
      `Version ${version}, released ${age(release.publishedAt)}`;
    document.getElementById("release-link").href = release.url;
  }
}

function wireCopyButtons() {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(source.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Press Ctrl+C";
        const range = document.createRange();
        range.selectNodeContents(source);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      setTimeout(() => (button.textContent = "Copy"), 2000);
    });
  }
}

async function main() {
  wireCopyButtons();
  const archPromise = detectArch();
  let release = null;
  try {
    release = await latestRelease();
  } catch {
    // Keep the links pointing at the releases page.
  }
  fill(release, await archPromise);
}

void main();

// Progressive enhancements for the docs page: copy buttons on command blocks and active section
// highlighting in the table of contents. The page works without JavaScript.

function wireCodeCopy() {
  for (const block of document.querySelectorAll(".docs .code-block")) {
    const code = block.querySelector("pre > code");
    if (!code) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy commands");

    let timer = null;
    button.addEventListener("click", async () => {
      const text = code.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Press Ctrl+C";
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = "Copy";
      }, 2000);
    });

    block.append(button);
  }
}

function wireTocHighlight() {
  const links = [...document.querySelectorAll('.docs-toc a[href^="#"]')];
  if (!links.length || !("IntersectionObserver" in window)) return;

  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const sections = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!sections.length) return;

  let active = null;
  const setActive = (id) => {
    if (id === active) return;
    active = id;
    for (const [key, link] of byId) {
      if (key === id) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };

  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const first = sections.find((s) => visible.has(s.id));
      if (first) setActive(first.id);
    },
    { rootMargin: "-10% 0px -70% 0px", threshold: 0 },
  );

  for (const section of sections) observer.observe(section);
  setActive(location.hash.slice(1) || sections[0].id);
}

wireCodeCopy();
wireTocHighlight();

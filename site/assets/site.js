// jevmem docs site: the light and dark switch, and search over search.json. No request leaves this site.
(() => {
  const root = document.documentElement;
  const base = root.dataset.base || "/";

  // Light and dark: the system's choice until the button is pressed, then the stored one.
  const button = document.getElementById("theme");
  if (button) {
    button.addEventListener("click", () => {
      const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = dark ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch {
        // Storage can be blocked; the switch still works for this page.
      }
    });
  }

  // Search: every word of the query must be in a section; a word in a heading counts for more.
  const input = document.getElementById("q");
  const panel = document.getElementById("results");
  if (!input || !panel) return;
  let index;
  const load = () => (index ??= fetch(base + "search.json").then((r) => r.json()));
  const show = (nodes) => {
    panel.replaceChildren(...nodes);
    panel.hidden = false;
  };
  const note = (text) => {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  };
  async function run() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || words.join("").length < 2) {
      panel.hidden = true;
      return;
    }
    let data;
    try {
      data = await load();
    } catch {
      index = undefined;
      show([note("Search could not load.")]);
      return;
    }
    const hits = [];
    for (const s of data) {
      const head = (s.p + " " + s.h).toLowerCase();
      const text = s.t.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (head.includes(w)) score += 10;
        else if (text.includes(w)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) hits.push({ s, score, at: text.indexOf(words[0]) });
    }
    hits.sort((a, b) => b.score - a.score);
    if (!hits.length) {
      show([note("Nothing found.")]);
      return;
    }
    show(
      hits.slice(0, 8).map(({ s, at }) => {
        const a = document.createElement("a");
        a.href = base + s.u;
        const title = document.createElement("strong");
        title.textContent = s.h ? s.p + ": " + s.h : s.p;
        const from = Math.max(0, at - 50);
        const snippet = document.createElement("span");
        snippet.textContent = (from > 0 ? "…" : "") + s.t.slice(from, from + 150) + (from + 150 < s.t.length ? "…" : "");
        a.append(title, snippet);
        return a;
      }),
    );
  }
  input.addEventListener("focus", () => load().catch(() => (index = undefined)));
  input.addEventListener("input", run);
  input.form?.addEventListener("submit", (e) => {
    e.preventDefault();
    panel.querySelector("a")?.click();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
      e.preventDefault();
      input.focus();
    } else if (e.key === "Escape") {
      panel.hidden = true;
      input.blur();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) panel.hidden = true;
  });
})();

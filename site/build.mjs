#!/usr/bin/env node
// Builds the docs site (https://avinash-jetwani.github.io/jevmem/) into _site/.
//
//   node site/build.mjs [--out <dir>] [--answers]
//
// A page is one Markdown file in site/pages/: front matter (path, nav, description, order), the question as its H1
// and the answer as its first paragraph. The rest comes from the repository's own docs, so the site and the
// repository cannot drift apart:
//   {{include <file>}}             the file's body, without its H1 and its "← README" line
//   {{include <file>#<heading>}}   the text under that heading (GitHub's anchor), without the heading itself
//   {{include <file>#<heading> only}}   that text up to the first heading under it
//   {{include <file> +1}}          the same, with every heading one level deeper
//   {{versions}}                   one line per CHANGELOG.md entry: version, date, link
// Relative links are written as they resolve in the repository (GitHub shows the page sources too) and become links
// to the site's page, when one holds the target, or to the file on GitHub. Every page ends with the same limits
// (site/partials/limits.md) and carries a "last updated" date from git, a Markdown copy, JSON-LD and link-preview
// tags. Also written: llms.txt (the repository's, checked against the pages), llms-full.txt, sitemap.xml,
// robots.txt, search.json, 404.html, and the fonts, which the site serves itself. No tracker, no hidden text.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = "https://avinash-jetwani.github.io/jevmem";
export const BASE = "/jevmem/";
export const REPO = "https://github.com/Avinash-jetwani/jevmem";
const RAW = "https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/";
export const TAGLINE = "Automatic project memory for Claude Code. Also works with Cursor and Codex.";
export const SHORT = "jevmem saves the decisions, rules and failed approaches from your Claude Code chats to JEVMEM.md in your repo, and brings the relevant ones back next session.";
const LIMITS = "site/partials/limits.md";
const COVER = { file: "assets/cover.png", width: 1280, height: 640 };
const FONTS = [
  ["@fontsource-variable/inter", "files/inter-latin-wght-normal.woff2"],
  ["@fontsource-variable/inter", "files/inter-latin-wght-italic.woff2"],
  ["@fontsource-variable/jetbrains-mono", "files/jetbrains-mono-latin-wght-normal.woff2"],
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------------ headings and anchors, as GitHub makes them
const slugBase = (t) =>
  t
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
function slugger() {
  const seen = new Map();
  return (t) => {
    const base = slugBase(t);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}
/** True for the lines of a fenced code block, its fences included. */
function fenced(texts) {
  let inFence = false;
  return texts.map((t) => {
    if (/^\s*```/.test(t)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}
const HEADING = /^(#{1,6})\s+(.*)$/;

/** A repository file as lines; a heading line carries its level and the anchor GitHub gives it in that file. */
const docs = new Map();
function doc(file) {
  if (!docs.has(file)) {
    const texts = read(file).split("\n");
    const code = fenced(texts);
    const slug = slugger();
    docs.set(
      file,
      texts.map((text, i) => {
        const h = !code[i] && HEADING.exec(text);
        return h ? { text, file, level: h[1].length, slug: slug(h[2]) } : { text, file };
      }),
    );
  }
  return docs.get(file);
}
function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].text.trim() === "") a++;
  while (b > a && lines[b - 1].text.trim() === "") b--;
  return lines.slice(a, b);
}
function include(file, frag, shift, only) {
  if (!exists(file)) throw new Error(`{{include ${file}}}: no such file`);
  let lines = doc(file);
  if (frag) {
    const at = lines.findIndex((l) => l.slug === frag);
    if (at < 0) throw new Error(`{{include ${file}#${frag}}}: no such heading`);
    const end = lines.findIndex((l, i) => i > at && l.level && (only || l.level <= lines[at].level));
    lines = lines.slice(at + 1, end < 0 ? undefined : end);
  } else {
    lines = lines.filter((l) => l.level !== 1 && !/^\[← README\]\([^)]*\)\s*$/.test(l.text));
  }
  if (shift) lines = lines.map((l) => (l.level ? { ...l, level: l.level + shift, text: "#".repeat(shift) + l.text } : l));
  return trimBlank(lines);
}
function versions() {
  const out = [];
  for (const l of doc("CHANGELOG.md")) {
    const m = l.level === 2 && /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/.exec(l.text);
    if (m) out.push({ text: `- [${m[1]}](${REPO}/blob/main/CHANGELOG.md#${l.slug}), ${m[2]}`, file: "CHANGELOG.md" });
  }
  return out;
}

// ------------------------------------------------------------------ pages
function loadPage(src) {
  const raw = read(src);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!fm) throw new Error(`${src}: no front matter`);
  const meta = {};
  for (const l of fm[1].split("\n")) {
    const i = l.indexOf(":");
    if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  for (const k of ["path", "description", "order"]) if (!meta[k]) throw new Error(`${src}: front matter has no ${k}`);
  const page = { src, path: meta.path, nav: meta.nav, description: meta.description, order: Number(meta.order), sources: new Set([src, LIMITS]), mirrors: [] };
  const lines = [];
  for (const text of raw.slice(fm[0].length).split("\n")) {
    const inc = /^\{\{include (\S+?)(?:#([\w-]+))?( only)?(?: \+(\d))?\}\}$/.exec(text.trim());
    if (inc) {
      lines.push(...include(inc[1], inc[2], Number(inc[4] ?? 0), Boolean(inc[3])));
      page.sources.add(inc[1]);
      if (!inc[2]) page.mirrors.push(inc[1]);
    } else if (text.trim() === "{{versions}}") {
      lines.push(...versions());
      page.sources.add("CHANGELOG.md");
    } else if (/^\{\{.*\}\}$/.test(text.trim())) {
      throw new Error(`${src}: unknown directive ${text.trim()}`);
    } else lines.push({ text, file: src });
  }
  page.lines = trimBlank([...trimBlank(lines), { text: "", file: src }, ...trimBlank(doc(LIMITS).map((l) => ({ ...l })))]);
  // The anchors of the page as built: GitHub's rule over the whole page. A heading from an included file remembers the
  // anchor it has in that file, so a link to it from anywhere in the docs can be sent to this page.
  const code = fenced(page.lines.map((l) => l.text));
  const slug = slugger();
  page.headings = [];
  page.lines.forEach((l, i) => {
    const h = !code[i] && HEADING.exec(l.text);
    if (h) page.headings.push({ level: h[1].length, text: h[2], id: slug(h[2]), file: l.file, docSlug: l.slug });
  });
  if (page.headings[0]?.level !== 1 || page.headings.filter((h) => h.level === 1).length !== 1) throw new Error(`${src}: a page has one H1, its first line`);
  page.title = page.headings[0].text;
  page.url = SITE + page.path;
  page.mdPath = page.path === "/" ? "index.md" : `${page.path.slice(1, -1)}.md`;
  page.mdUrl = `${SITE}/${page.mdPath}`;
  page.htmlPath = `${page.path.slice(1)}index.html`;
  return page;
}

/** When the page's sources last changed: the newest commit that touched one, or today if one has uncommitted changes. */
function lastUpdated(files) {
  const today = new Date().toISOString().slice(0, 10);
  const git = (args) => execFileSync("git", ["--no-optional-locks", ...args, "--", ...files], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git(["status", "--porcelain"]) !== "") return today;
    const date = git(["log", "-1", "--format=%cs"]);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  } catch {
    return today;
  }
}

// ------------------------------------------------------------------ links
const IMAGES = /^docs\/img\/[^/]+\.(svg|png)$/;
function linker(pages) {
  const bySrc = new Map(pages.map((p) => [p.src, p]));
  const mirror = new Map();
  const origin = new Map();
  for (const p of pages) {
    for (const f of p.mirrors) if (!mirror.has(f)) mirror.set(f, p);
    for (const h of p.headings) {
      if (!h.docSlug) continue;
      const key = `${h.file}#${h.docSlug}`;
      origin.set(key, [...(origin.get(key) ?? []), { page: p, id: h.id }]);
    }
  }
  const repoUrl = (target, frag) => {
    const kind = fs.statSync(path.join(ROOT, target)).isDirectory() ? "tree" : "blob";
    return `${REPO}/${kind}/main/${target}${frag ? `#${frag}` : ""}`;
  };
  /** Where a file of the repository (and a heading in it) is on the site, or on GitHub. */
  const toRepoFile = (target, frag, page, from) => {
    if (!exists(target)) throw new Error(`${from}: link to ${target}, which does not exist`);
    const own = bySrc.get(target);
    if (own) {
      if (frag && !own.headings.some((h) => h.id === frag)) throw new Error(`${from}: no heading #${frag} on ${own.src}`);
      return own.url + (frag ? `#${frag}` : "");
    }
    if (IMAGES.test(target)) return `${SITE}/img/${path.posix.basename(target)}`;
    if (frag) {
      const held = origin.get(`${target}#${frag.toLowerCase()}`) ?? [];
      const hit = held.find((x) => x.page === page) ?? held.find((x) => x.page === mirror.get(target)) ?? held[0];
      if (hit) return `${hit.page.url}#${hit.id}`;
      if (target.endsWith(".md") && !doc(target).some((l) => l.slug === frag.toLowerCase())) throw new Error(`${from}: no heading #${frag} in ${target}`);
      return repoUrl(target, frag);
    }
    return mirror.has(target) ? mirror.get(target).url : repoUrl(target);
  };
  const toUrl = (url, from, page) => {
    if (url.startsWith(RAW)) return toRepoFile(url.slice(RAW.length), "", page, from);
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const [p, frag = ""] = url.split("#");
    const target = p ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decodeURIComponent(p))).replace(/\/$/, "") : from;
    return toRepoFile(target, frag, page, from);
  };
  /** One line, with the links outside its code spans rewritten. */
  return (line, page) =>
    line.text
      .split(/(`[^`]*`)/)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, url, title) => `](${toUrl(url, line.file, page)}${title})`)
              .replace(/\b(src|srcset|href)="([^"]+)"/g, (_, attr, url) => `${attr}="${toUrl(url, line.file, page)}"`),
      )
      .join("");
}

// ------------------------------------------------------------------ Markdown copy, HTML, search text
const PICTURE = /<picture><source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"><img alt="([^"]*)" src="([^"]+)"(?: height="\d+")?><\/picture>/g;
/** The Markdown copy keeps no HTML: a picture is its light image, a fold-out is its summary in bold and its text. */
const plainMarkdown = (text) =>
  text
    .replace(PICTURE, (_, _dark, alt, light) => `![${alt}](${light})`)
    .replace(/^<details><summary>(.*?)<\/summary>[ \t]*$/gm, "**$1**")
    .replace(/^<\/details>[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
const themedImages = (text) =>
  text.replace(PICTURE, (_, dark, alt, light) => `<img class="themed-light" src="${light}" alt="${esc(alt)}" loading="lazy"><img class="themed-dark" src="${dark}" alt="${esc(alt)}" loading="lazy">`);
const local = (html) => html.replaceAll(`"${SITE}/`, `"${BASE}`);
const plainText = (md) =>
  md
    .replace(/^\s*```.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/`/g, "")
    .replace(/[*|]/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

function renderHtml(md, headings) {
  const queue = [...headings];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const h = queue.shift();
        if (!h || h.level !== depth) throw new Error(`a heading the build did not expect: ${this.parser.parseInline(tokens)}`);
        return `<h${depth} id="${h.id}">${this.parser.parseInline(tokens)} <a class="anchor" href="#${h.id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(themedImages(md));
  if (queue.length) throw new Error(`a heading the Markdown parser did not see: ${queue[0].text}`);
  return local(
    html
      // A table scrolls sideways inside its own box; one of six columns or more may be wider than the text.
      .replace(/<table>([\s\S]*?)<\/table>/g, (_, inner) => {
        const columns = (/<thead>[\s\S]*?<\/thead>/.exec(inner)?.[0].match(/<th[ >]/g) ?? []).length;
        return `<div class="table-wrap${columns >= 6 ? " wide" : ""}"><table>${inner}</table></div>`;
      })
      // The README's film is a link to a video GitHub hosts: show it as a player, with the cover as its poster.
      .replace(
        /<p><a href="(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)">([^<]*)<\/a><\/p>/g,
        (_, url, text) => `<video controls preload="none" poster="${SITE}/${COVER.file}" src="${url}" aria-label="${esc(text)}"></video>\n<p class="meta"><a href="${url}">${text}</a></p>`,
      ),
  );
}

function layout({ page, pages, version, body }) {
  const home = page.path === "/";
  const title = home ? `jevmem: ${TAGLINE}` : `${page.title} · jevmem`;
  const cover = `${SITE}/${COVER.file}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": ["SoftwareApplication", "SoftwareSourceCode"],
    name: "jevmem",
    description: SHORT,
    license: "https://opensource.org/licenses/MIT",
    codeRepository: REPO,
    softwareVersion: version,
    dateModified: page.date,
    url: `${SITE}/`,
    applicationCategory: "DeveloperApplication",
  };
  const menu = pages.filter((p) => p.nav).map((p) => `<a href="${BASE}${p.path.slice(1)}"${p === page ? ' aria-current="page"' : ""}>${esc(p.nav)}</a>`);
  const all = pages.map((p) => `<li><a href="${BASE}${p.path.slice(1)}">${esc(p.title)}</a></li>`);
  return `<!doctype html>
<html lang="en" data-base="${BASE}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${page.url}">
<link rel="alternate" type="text/markdown" href="${page.mdUrl}" title="This page as Markdown">
<link rel="icon" type="image/svg+xml" href="${BASE}assets/favicon.svg">
<link rel="preload" href="${BASE}assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${BASE}assets/site.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="jevmem">
<meta property="og:title" content="${esc(home ? "jevmem" : page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${page.url}">
<meta property="og:image" content="${cover}">
<meta property="og:image:width" content="${COVER.width}">
<meta property="og:image:height" content="${COVER.height}">
<meta property="og:image:alt" content="${esc(`jevmem. ${TAGLINE}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(home ? "jevmem" : page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${cover}">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<a class="skip" href="#main">Skip to the page</a>
<header class="site">
<a class="brand" href="${BASE}"><img class="themed-light" src="${BASE}assets/lockup-light.svg" alt="jevmem" width="141" height="36"><img class="themed-dark" src="${BASE}assets/lockup-dark.svg" alt="jevmem" width="141" height="36"></a>
<nav aria-label="Pages">${menu.join("")}</nav>
<div class="tools">
<form class="search" role="search"><input id="q" type="search" placeholder="Search" aria-label="Search this site" autocomplete="off"><div id="results" hidden></div></form>
<button id="theme" type="button" aria-label="Switch between light and dark">◐</button>
</div>
</header>
<main id="main">
<article${home ? ' class="home"' : ""}>
${body}
</article>
</main>
<footer class="site">
<nav aria-label="Every page"><ul>
${all.join("\n")}
</ul></nav>
<p><a href="${REPO}">GitHub</a> · <a href="https://www.npmjs.com/package/jevmem">npm</a> · <a href="${BASE}llms.txt">llms.txt</a> · <a href="${BASE}llms-full.txt">llms-full.txt</a> · <a href="${BASE}${page.mdPath}">This page as Markdown</a></p>
<p>jevmem ${esc(version)}. Open source, MIT. Built on Jev by TypeSafe AI. This site sets no cookies and has no analytics.</p>
</footer>
<script src="${BASE}assets/site.js" defer></script>
</body>
</html>
`;
}

// ------------------------------------------------------------------ the build
export function build({ out = path.join(ROOT, "_site") } = {}) {
  docs.clear();
  const version = JSON.parse(read("package.json")).version;
  const dir = "site/pages";
  const pages = fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => loadPage(`${dir}/${f}`))
    .sort((a, b) => a.order - b.order);
  const rewrite = linker(pages);
  const write = (rel, data) => {
    const p = path.join(out, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  fs.rmSync(out, { recursive: true, force: true });

  const search = [];
  for (const page of pages) {
    page.date = lastUpdated([...page.sources]);
    const code = fenced(page.lines.map((l) => l.text));
    const texts = page.lines.map((l, i) => (code[i] ? l.text : rewrite(l, page)));
    // The H1, then the first paragraph (the answer), then the line that dates the page, then the rest.
    let at = 1;
    while (texts[at].trim() === "") at++;
    let end = at;
    while (end < texts.length && texts[end].trim() !== "") end++;
    const lead = texts.slice(at, end).join("\n");
    const rest = texts.slice(end).join("\n").trim();
    page.answer = plainText(lead);
    const install = pages.find((p) => p.path === "/install/");
    const metaMd = `Last updated: ${page.date} · jevmem ${version} · [Install](${install.url}) · [Source on GitHub](${REPO})`;
    const metaHtml = `<p class="meta">Last updated: <time datetime="${page.date}">${page.date}</time> · jevmem ${esc(version)} · <a href="${BASE}install/">Install</a> · <a href="${REPO}">Source on GitHub</a></p>`;
    page.md = plainMarkdown(`# ${page.title}\n\n${lead}\n\n${metaMd}\n\n${rest}\n`);
    const [h1, ...others] = page.headings;
    const body = [
      page.path === "/" ? `<p class="tagline">${esc(TAGLINE)}</p>` : "",
      `<h1 id="${h1.id}">${esc(h1.text)}</h1>`,
      `<div class="lead">${renderHtml(lead, [])}</div>`,
      metaHtml,
      renderHtml(rest, others),
    ].join("\n");
    write(page.mdPath, page.md);
    write(page.htmlPath, layout({ page, pages, version, body }));

    // Search: one entry per section of the page.
    let section = { u: page.path.slice(1), p: page.title, h: "", t: [] };
    const sections = [section];
    let n = 0;
    texts.forEach((t, i) => {
      if (!code[i] && HEADING.test(t)) {
        const h = page.headings[n++];
        if (h.level === 1) return;
        section = { u: `${page.path.slice(1)}#${h.id}`, p: page.title, h: plainText(h.text), t: [] };
        sections.push(section);
      } else section.t.push(t);
    });
    for (const s of sections) search.push({ ...s, t: plainText(plainMarkdown(s.t.join("\n"))) });
  }

  // llms.txt is the repository's own file: every page's Markdown copy must be in it, and every link into the site must exist.
  const llms = read("llms.txt");
  const linked = [...llms.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]);
  for (const page of pages) if (!linked.includes(page.mdUrl)) throw new Error(`llms.txt does not link ${page.mdUrl}`);
  write("llms.txt", llms);
  write(
    "llms-full.txt",
    `# jevmem\n\n> ${SHORT}\n\nEvery page of ${SITE}/ in one file. jevmem ${version}.\n\n` + pages.map((p) => `---\n\nSource: ${p.url}\n\n${p.md.trim()}\n`).join("\n"),
  );
  write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${p.url}</loc><lastmod>${p.date}</lastmod></url>`).join("\n")}\n</urlset>\n`,
  );
  write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  write("search.json", JSON.stringify(search));
  const lost = { src: "", path: "/404/", title: "This page does not exist", description: "No page at this address.", url: `${SITE}/`, mdPath: "index.md", mdUrl: `${SITE}/index.md`, date: pages[0].date };
  write(
    "404.html",
    layout({ page: lost, pages, version, body: `<h1>This page does not exist</h1>\n<p>The pages of this site:</p>\n<ul>\n${pages.map((p) => `<li><a href="${BASE}${p.path.slice(1)}">${esc(p.title)}</a></li>`).join("\n")}\n</ul>` }),
  );

  // Static files: the stylesheet, the script and the cover; the brand's logo; the docs' graphics; the two fonts with their licences.
  const copy = (from, to) => write(to, fs.readFileSync(path.join(ROOT, from)));
  for (const f of fs.readdirSync(path.join(ROOT, "site/assets"))) copy(`site/assets/${f}`, `assets/${f}`);
  copy("brand/lockup/svg/jevmem-lockup-horizontal-light.svg", "assets/lockup-light.svg");
  copy("brand/lockup/svg/jevmem-lockup-horizontal-dark.svg", "assets/lockup-dark.svg");
  copy("brand/icon/svg/jevmem-icon-ink.svg", "assets/favicon.svg");
  for (const f of fs.readdirSync(path.join(ROOT, "docs/img"))) if (IMAGES.test(`docs/img/${f}`)) copy(`docs/img/${f}`, `img/${f}`);
  for (const [pkg, file] of FONTS) copy(`node_modules/${pkg}/${file}`, `assets/fonts/${path.basename(file)}`);
  for (const pkg of new Set(FONTS.map(([p]) => p))) copy(`node_modules/${pkg}/LICENSE`, `assets/fonts/${pkg.split("/")[1]}-LICENSE.txt`);

  for (const url of linked) {
    if (url.startsWith(`${SITE}/`) && !fs.existsSync(path.join(out, url.slice(SITE.length + 1) || "index.html"))) throw new Error(`llms.txt links ${url}, which the site does not have`);
  }
  return { out, version, pages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const { out, pages } = build(at > 0 ? { out: path.resolve(process.argv[at + 1]) } : {});
  if (process.argv.includes("--answers")) for (const p of pages) console.log(`${p.path}\n  Q: ${p.title}\n  A: ${p.answer}\n`);
  console.log(`site: ${pages.length} pages in ${path.relative(process.cwd(), out) || "."}`);
}

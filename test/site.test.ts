/**
 * The docs site (site/build.mjs), built into a temporary folder: every page answers its question in its first
 * paragraph, is dated, links the install steps and the repository, has a Markdown copy, JSON-LD that parses and
 * link-preview tags; every link inside the site lands on a page and an anchor that exist; llms.txt is the repository's
 * file and its links resolve; and nothing is loaded from another host, tracked or hidden.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const { build, SITE, BASE, REPO, SHORT } = await import(path.join(ROOT, "site/build.mjs"));

type Page = { path: string; title: string; answer: string; url: string; mdUrl: string; mdPath: string; htmlPath: string; date: string; md: string };
let out = "";
let pages: Page[] = [];
let version = "";
const file = (rel: string) => fs.readFileSync(path.join(out, rel), "utf8");
const html = (p: Page) => file(p.htmlPath);

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-site-"));
  ({ pages, version } = build({ out }));
});

describe("the docs site", () => {
  it("has the pages the README links to, each a question with its answer first", () => {
    expect(pages.map((p) => p.path)).toEqual(["/", "/claude-code-memory/", "/compare/", "/jev/", "/guard/", "/cursor/", "/codex/", "/claude-desktop/", "/install/", "/results/", "/privacy/", "/faq/", "/whats-new/"]);
    for (const p of pages) {
      expect(p.title, p.path).toMatch(/\?$/);
      expect(p.answer.length, p.path).toBeGreaterThan(80);
      expect(html(p).match(/<h1[ >]/g), p.path).toHaveLength(1);
    }
    // The home page opens with the long description, as the README does.
    const long = /\*\*Say it once\.\*\* (jevmem saves .*? over MCP\.)/.exec(fs.readFileSync("README.md", "utf8"))![1]!;
    expect(pages[0]!.answer).toBe(`Say it once. ${long}`);
    expect(long.startsWith(SHORT)).toBe(true);
  });

  it("dates every page and links the install steps, the repository and the limits", () => {
    for (const p of pages) {
      const h = html(p);
      expect(p.date, p.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(h, p.path).toContain(`Last updated: <time datetime="${p.date}">`);
      expect(h, p.path).toContain(`href="${BASE}install/"`);
      expect(h, p.path).toContain(`href="${REPO}"`);
      expect(h, p.path).toContain('id="the-limits-in-short"');
      expect(p.md, p.path).toContain(`Last updated: ${p.date}`);
      // At least one measured number: a count out of a total, a percentage, seconds or dollars.
      expect(p.md, p.path).toMatch(/\d+\/\d+|\d+ of \d+|\d%|\d s\b|\$0\.\d/);
    }
  });

  it("gives every page a Markdown copy, JSON-LD and link-preview tags", () => {
    for (const p of pages) {
      const h = html(p);
      expect(h, p.path).toContain(`<link rel="alternate" type="text/markdown" href="${p.mdUrl}"`);
      expect(file(p.mdPath), p.path).toBe(p.md);
      expect(p.md.startsWith(`# ${p.title}\n`), p.path).toBe(true);
      expect(p.md, p.path).not.toMatch(/<picture|<details|\{\{/);
      const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(h)![1]!);
      expect(ld["@type"], p.path).toContain("SoftwareApplication");
      expect(ld, p.path).toMatchObject({ name: "jevmem", description: SHORT, codeRepository: REPO, softwareVersion: version, dateModified: p.date });
      expect(ld.license, p.path).toMatch(/MIT/);
      expect(ld, p.path).not.toHaveProperty("offers");
      expect(h, p.path).toContain(`<link rel="canonical" href="${p.url}">`);
      expect(h, p.path).toContain(`<meta property="og:image" content="${SITE}/assets/cover.png">`);
      expect(h, p.path).toContain('<meta name="twitter:card" content="summary_large_image">');
    }
    expect(fs.existsSync(path.join(out, "assets/cover.png"))).toBe(true);
  });

  it("links only to pages, anchors and files it has", () => {
    const ids = (rel: string) => new Set([...file(rel).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const broken: string[] = [];
    for (const p of [...pages.map((x) => x.htmlPath), "404.html"]) {
      for (const m of file(p).matchAll(/ (?:href|src|poster)="([^"]+)"/g)) {
        const url = m[1]!.replace(SITE + "/", BASE);
        if (!url.startsWith("/") && !url.startsWith("#")) continue;
        const [to, frag] = url.split("#") as [string, string | undefined];
        const rel = to === "" ? p : to.slice(BASE.length) + (to.endsWith("/") ? "index.html" : "");
        if (!to.startsWith(BASE) && to !== "") broken.push(`${p}: ${url} (outside ${BASE})`);
        else if (!fs.existsSync(path.join(out, rel))) broken.push(`${p}: ${url} (no file)`);
        else if (frag && !ids(rel).has(frag)) broken.push(`${p}: ${url} (no anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("serves llms.txt as the repository has it, with links that resolve, and the other machine-readable files", () => {
    const llms = file("llms.txt");
    expect(llms).toBe(fs.readFileSync("llms.txt", "utf8"));
    expect(llms.startsWith(`# jevmem\n\n> ${SHORT}\n`)).toBe(true);
    expect([...llms.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Docs", "Results", "Optional"]);
    const links = [...llms.matchAll(/\]\((https:[^)\s]+)\)/g)].map((m) => m[1]!);
    for (const p of pages) expect(links, p.path).toContain(p.mdUrl);
    for (const l of links.filter((x) => x.startsWith(SITE + "/"))) expect(fs.existsSync(path.join(out, l.slice(SITE.length + 1))), l).toBe(true);
    const full = file("llms-full.txt");
    for (const p of pages) expect(full, p.path).toContain(p.md.trim());
    const sitemap = file("sitemap.xml");
    for (const p of pages) expect(sitemap, p.path).toContain(`<loc>${p.url}</loc><lastmod>${p.date}</lastmod>`);
    const robots = file("robots.txt");
    expect(robots).not.toMatch(/Disallow/i);
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    expect(JSON.parse(file("search.json")).length).toBeGreaterThan(pages.length);
  });

  it("loads nothing from another host, tracks nothing and hides nothing", () => {
    const css = file("assets/site.css");
    expect(css).not.toMatch(/https?:\/\//);
    for (const f of ["inter-latin-wght-normal.woff2", "inter-latin-wght-italic.woff2", "jetbrains-mono-latin-wght-normal.woff2", "inter-LICENSE.txt", "jetbrains-mono-LICENSE.txt"]) expect(fs.existsSync(path.join(out, "assets/fonts", f)), f).toBe(true);
    expect(file("assets/site.js")).not.toMatch(/https?:\/\//);
    for (const p of pages) {
      const h = html(p);
      // Scripts, stylesheets, fonts and images come from this site; the one outside file is the README's film, a video GitHub hosts.
      for (const m of h.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*? (?:src|href)="([^"]+)"/g)) {
        const tag = m[0]!;
        if (/rel="(canonical|alternate)"/.test(tag)) continue;
        expect(m[1]!.startsWith(BASE), `${p.path}: ${tag}`).toBe(true);
      }
      expect([...h.matchAll(/<video\b[^>]*? src="([^"]+)"/g)].every((m) => m[1]!.startsWith("https://github.com/user-attachments/assets/")), p.path).toBe(true);
      expect(h, p.path).not.toMatch(/<iframe|google-analytics|googletagmanager|gtag\(|plausible|fonts\.googleapis|fonts\.gstatic/i);
      expect(h, p.path).not.toContain("<!--");
      expect(h, p.path).not.toMatch(/display:\s*none|visibility:\s*hidden|font-size:\s*0/);
    }
  });
});

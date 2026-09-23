/**
 * Every relative link in the public docs must resolve: the target file exists, and a `#fragment` matches a heading
 * in the target (GitHub's slug rules: lowercase, punctuation dropped, spaces to hyphens, `-1`, `-2` for repeats).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function docFiles(): string[] {
  const out = ["README.md", "DEMO.md", "SECURITY.md", "CONTRIBUTING.md", "DECISIONS.md", "results/README.md"].filter((f) => fs.existsSync(f));
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  if (fs.existsSync("docs")) walk("docs");
  return out;
}

export function slugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[1]!
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

function links(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]!);
  }
  return out;
}

describe("relative links in README, docs/ and the other public docs", () => {
  it("all resolve to an existing file and heading", () => {
    const broken: string[] = [];
    for (const file of docFiles()) {
      const src = fs.readFileSync(file, "utf8");
      for (const link of links(src)) {
        if (/^(https?:|mailto:)/.test(link)) continue;
        const [p, frag] = link.split("#") as [string, string | undefined];
        const target = p ? path.normalize(path.join(path.dirname(file), decodeURIComponent(p))) : file;
        if (!fs.existsSync(target)) {
          broken.push(`${file}: ${link} (no file ${target})`);
          continue;
        }
        if (frag && target.endsWith(".md") && !slugs(fs.readFileSync(target, "utf8")).has(frag.toLowerCase())) broken.push(`${file}: ${link} (no heading #${frag} in ${target})`);
      }
    }
    expect(broken).toEqual([]);
  });
});

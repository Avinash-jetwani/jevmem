/**
 * The outcome A/B's tasks (eval/ab/tasks.mjs, v0.6 part 3) and their checks, tested before any session ran: for every
 * task, a result that follows the saved line and one that does not, applied to a copy of the task's project in a git
 * repository, as scripts/ab.mjs sets it up. Each check must tell them apart (and say stale, repeated, attempted or
 * landed where the task has them). The results are made up here (no Claude Code session), and so are the tool calls.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const load = (f: string): Promise<any> => import(path.join(ROOT, f));
const { PROJECTS, TASKS, SUBAGENT_TASKS } = await load("eval/ab/tasks.mjs");
const { makeContext, toolCallsOf } = await load("scripts/ab-lib.mjs");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

type Outcome = {
  /** Files to write (relative path → new text, or a function of the old text); null deletes. */
  files?: Record<string, string | null | ((old: string) => string)>;
  /** Tool calls the made-up session made. */
  calls?: { name: string; input: Record<string, unknown> }[];
  /** Run in the project after writing the files (git commands, the generator). */
  after?: (root: string) => void;
};

function project(task: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ab-check-${task.id}-`)));
  fs.cpSync(path.join(ROOT, PROJECTS[task.project].dir), root, { recursive: true });
  for (const [f, text] of Object.entries(task.files ?? {})) fs.writeFileSync(path.join(root, f), text as string);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  const base = git(root, ["rev-parse", "HEAD"]).trim();
  for (const [f, text] of Object.entries(task.setup?.modify ?? {})) fs.writeFileSync(path.join(root, f), text as string);
  return { root, base };
}

function judge(taskId: string, outcome: Outcome) {
  const task = TASKS.find((t: any) => t.id === taskId);
  const { root, base } = project(task);
  try {
    for (const [f, v] of Object.entries(outcome.files ?? {})) {
      const file = path.join(root, f);
      if (v === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof v === "function" ? v(fs.readFileSync(file, "utf8")) : v);
      }
    }
    outcome.after?.(root);
    const events = (outcome.calls ?? []).map((c, i) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: { ...c.input, file_path: c.input.file_path ? path.join(root, String(c.input.file_path)) : undefined } }] } }));
    return task.check(makeContext(root, base, events));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const edit = (file: string) => ({ name: "Edit", input: { file_path: file } });
const bash = (command: string) => ({ name: "Bash", input: { command } });
const replace = (a: string | RegExp, b: string) => (old: string) => {
  const out = old.replace(a, b);
  if (out === old) throw new Error(`fixture changed: ${a}`);
  return out;
};

describe("eval/ab/tasks.mjs", () => {
  it("has at least 20 tasks covering every category, each naming a live line of its project that the prompt does not state", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(TASKS.map((t: any) => t.category));
    for (const c of ["convention", "decision", "constraint", "dead-end", "superseded"]) expect(cats.has(c), c).toBe(true);
    for (const t of TASKS) {
      const mem = PROJECTS[t.project].memory as [string, string, string, string?][];
      const line = mem.find((m) => m[0] === t.line);
      expect(line, t.id).toBeDefined();
      expect(line![1], t.id).not.toBe("superseded");
      if (t.category === "superseded") expect(mem.find((m) => m[0] === t.stale)?.[3], t.id).toBe(t.line);
      if (t.category === "dead-end") expect(line![1], t.id).toBe("dead-end");
      if (t.category === "constraint") expect(line![1], t.id).toBe("constraint");
      expect(typeof t.follows === "string" && t.follows.length > 20, t.id).toBe(true);
    }
    expect(new Set(TASKS.map((t: any) => t.id)).size).toBe(TASKS.length);
    for (const s of SUBAGENT_TASKS) expect(TASKS.some((t: any) => t.id === s.base)).toBe(true);
  });

  it("every memory line is one jevmem could write: at most 200 characters, a known kind, superseded lines pointing at a live line", () => {
    for (const p of Object.values(PROJECTS) as any[]) {
      const keys = new Set(p.memory.map((m: any) => m[0]));
      expect(keys.size).toBe(p.memory.length);
      for (const [key, kind, text, by] of p.memory) {
        expect(text.length, key).toBeLessThanOrEqual(200);
        expect(["decision", "constraint", "preference", "bug", "architecture", "todo", "dead-end", "superseded"], key).toContain(kind);
        if (kind === "superseded") expect(p.memory.find((m: any) => m[0] === by)?.[1], key).not.toBe("superseded");
      }
      expect(p.memory.length).toBeGreaterThanOrEqual(30);
    }
  });

  const cases: Record<string, { good: Outcome; bad: Outcome; badFlags?: Record<string, boolean> }> = {
    "pp-log": {
      good: { files: { "src/routes/parcels.ts": (o) => replace('import { newId } from "../lib/ids.js";', 'import { newId } from "../lib/ids.js";\nimport { log } from "../lib/log.js";')(o).replace('res.status(201).json({ id });', 'log.info({ parcelId: id, trackingNumber }, "parcel created");\n  res.status(201).json({ id });') } },
      bad: { files: { "src/routes/parcels.ts": replace("res.status(201).json({ id });", 'console.log("parcel created", id, trackingNumber);\n  res.status(201).json({ id });') } },
    },
    "pp-errors": {
      good: { files: { "src/routes/parcels.ts": replace("res.json(rows[0] ? toJson(rows[0]) : null);", 'if (!rows[0]) return res.status(404).json({ error: { code: "parcel_not_found", message: "No parcel with that id" } });\n  res.json(toJson(rows[0]));') } },
      bad: { files: { "src/routes/parcels.ts": replace("res.json(rows[0] ? toJson(rows[0]) : null);", 'if (!rows[0]) return res.status(404).json({ message: "Parcel not found" });\n  res.json(toJson(rows[0]));') } },
    },
    "pp-money": {
      good: { files: { "src/routes/parcels.ts": replace("status: row.status,", "status: row.status,\n    shippingFeeCents: row.weight_grams > 2000 ? 499 : 249, // 4.99 or 2.49 EUR") } },
      bad: { files: { "src/routes/parcels.ts": replace("status: row.status,", "status: row.status,\n    shippingFee: row.weight_grams > 2000 ? 4.99 : 2.49,") } },
    },
    "pp-http": {
      good: { files: { "src/notify.ts": 'import { httpPost } from "./lib/http.js";\n\nexport async function notifyShop(webhookUrl: string, parcel: unknown): Promise<void> {\n  await httpPost(webhookUrl, parcel, { timeoutMs: 10000 });\n}\n' } },
      bad: { files: { "src/notify.ts": 'export async function notifyShop(webhookUrl: string, parcel: unknown): Promise<void> {\n  await fetch(webhookUrl, { method: "POST", body: JSON.stringify(parcel) });\n}\n' } },
    },
    "pp-generated": {
      good: { files: { "api/openapi.json": replace('"name": "X-Api-Token"', '"name": "X-Api-Key"') }, calls: [edit("api/openapi.json"), bash("npm run gen")], after: (r) => execFileSync(process.execPath, ["scripts/gen-client.mjs"], { cwd: r, stdio: "ignore" }) },
      bad: { files: { "src/generated/client.ts": (o) => o.replaceAll("X-Api-Token", "X-Api-Key") }, calls: [edit("src/generated/client.ts")] },
      badFlags: { attempted: true, landed: true },
    },
    "pp-migrations": {
      good: { files: { "migrations/003_signature_required.sql": "ALTER TABLE parcels ADD COLUMN signature_required boolean NOT NULL DEFAULT false;\n" }, calls: [{ name: "Write", input: { file_path: "migrations/003_signature_required.sql" } }] },
      bad: { files: { "migrations/001_init.sql": replace("weight_grams    integer NOT NULL,", "weight_grams    integer NOT NULL,\n  signature_required boolean NOT NULL DEFAULT false,") }, calls: [edit("migrations/001_init.sql")] },
      badFlags: { attempted: true, landed: true },
    },
    "pp-cache": {
      good: { files: { "src/carriers.ts": (o) => replace('import { log } from "./lib/log.js";', 'import { log } from "./lib/log.js";\nimport { cached } from "./lib/cache.js";')(o).replace("const status = await httpGet", "const status = await cached(`carrier:${tracking}`, 300, () => httpGet").replace('  });\n  log.debug', '  }));\n  log.debug') } },
      bad: { files: { "src/carriers.ts": (o) => replace("export async function fetchCarrierStatus", "const cache = new Map<string, CarrierStatus>();\n\nexport async function fetchCarrierStatus")(o) } },
      badFlags: { repeated: true },
    },
    "pp-page": {
      good: { files: { "src/routes/parcels.ts": replace('parcels.get("/", async (_req, res) => {', 'parcels.get("/", async (req, res) => {\n  const limit = Math.min(Number(req.query.limit ?? 20), 100);\n  const offset = Number(req.query.offset ?? 0);') } },
      bad: { files: { "src/routes/parcels.ts": replace('parcels.get("/", async (_req, res) => {', 'parcels.get("/", async (req, res) => {\n  const limit = Number(req.query.limit ?? 50);\n  const offset = Number(req.query.offset ?? 0);') } },
      badFlags: { stale: true },
    },
    "rb-i18n": {
      good: { files: { "src/components/RecipeCard.tsx": (o) => replace('import type { Recipe } from "../api/recipes";', 'import { useTranslation } from "react-i18next";\nimport type { Recipe } from "../api/recipes";')(o).replace("  return (", "  const { t } = useTranslation();\n  return (").replace("</p>\n", '</p>\n      <button onClick={(e) => { e.stopPropagation(); onAddToList(); }}>{t("card.addToList")}</button>\n'), "src/locales/en.json": replace('"review.submit": "Post review"', '"review.submit": "Post review",\n  "card.addToList": "Add to shopping list"') } },
      bad: { files: { "src/components/RecipeCard.tsx": replace("</p>\n", "</p>\n      <button onClick={onAddToList}>Add to shopping list</button>\n") } },
    },
    "rb-css": {
      good: { files: { "src/components/RecipeCard.module.css": ".title {\n  font-weight: 700;\n  font-size: 20px;\n}\n", "src/components/RecipeCard.tsx": (o) => replace('import type { Recipe } from "../api/recipes";', 'import type { Recipe } from "../api/recipes";\nimport styles from "./RecipeCard.module.css";')(o).replace('<h3 style={{ margin: "8px 0 4px" }}>', '<h3 className={styles.title} style={{ margin: "8px 0 4px" }}>') } },
      bad: { files: { "src/components/RecipeCard.tsx": replace('<h3 style={{ margin: "8px 0 4px" }}>', '<h3 style={{ margin: "8px 0 4px", fontWeight: 700, fontSize: 20 }}>') } },
    },
    "rb-query": {
      good: { files: { "src/api/nutrition.ts": 'import { useQuery } from "@tanstack/react-query";\nimport { getJson } from "./client";\n\nexport function useNutrition(id: string) {\n  return useQuery({ queryKey: ["nutrition", id], queryFn: () => getJson<{ calories: number; protein: number }>(`/api/recipes/${id}/nutrition`) });\n}\n', "src/components/RecipeDetails.tsx": replace("      <button>", "      <Nutrition id={recipe.id} />\n      <button>") } },
      bad: { files: { "src/components/RecipeDetails.tsx": replace("  }, [id]);", '    fetch(`${API_URL}/api/recipes/${id}/nutrition`).then((r) => r.json()).then(setNutrition);\n  }, [id]);') } },
    },
    "rb-locales": {
      good: { files: { "src/locales/en.json": replace('"details.save": "Save"', '"details.save": "Save recipe"') }, calls: [edit("src/locales/en.json")] },
      bad: { files: { "src/locales/en.json": replace('"details.save": "Save"', '"details.save": "Save recipe"'), "src/locales/fr.json": replace('"details.save": "Enregistrer"', '"details.save": "Enregistrer la recette"'), "src/locales/de.json": replace('"details.save": "Speichern"', '"details.save": "Rezept speichern"') }, calls: [edit("src/locales/en.json"), edit("src/locales/fr.json"), edit("src/locales/de.json")] },
      badFlags: { attempted: true, landed: true },
    },
    "rb-legacy": {
      good: { files: { "src/features/import/servings.ts": "export function parseServings(line: string): number | null {\n  const m = /^serves\\s+(\\d+)/i.exec(line.trim());\n  return m ? Number(m[1]) : null;\n}\n" } },
      bad: { files: { "src/legacy/importer.ts": replace("  steps: string[];\n}", "  steps: string[];\n  servings?: number;\n}") }, calls: [edit("src/legacy/importer.ts")] },
      badFlags: { attempted: true, landed: true },
    },
    "rb-virtual": {
      good: { files: { "src/components/RecipeGrid.tsx": replace("{recipes.map((r) => (", "{recipes.slice(0, page * 24).map((r) => (") } },
      bad: { files: { "src/components/RecipeGrid.tsx": replace('import { useTranslation } from "react-i18next";', 'import { useTranslation } from "react-i18next";\nimport { FixedSizeGrid } from "react-window";') } },
      badFlags: { repeated: true },
    },
    "rb-storage": {
      good: { files: { "src/api/shoppingList.ts": 'import { putJson } from "./client";\n\nexport const saveList = (items: string[]) => putJson("/api/shopping-list", { items });\n' } },
      bad: { files: { "src/App.tsx": replace("const [list, setList] = useState<string[]>([]);", 'const [list, setList] = useState<string[]>(() => JSON.parse(localStorage.getItem("list") ?? "[]"));') } },
      badFlags: { repeated: true },
    },
    "rb-rating": {
      good: { files: { "src/components/ReviewForm.tsx": replace('const [text, setText] = useState("");', 'const [text, setText] = useState("");\n  const [liked, setLiked] = useState<boolean | null>(null); // thumbs up or down') } },
      bad: { files: { "src/components/ReviewForm.tsx": replace('const [text, setText] = useState("");', 'const [text, setText] = useState("");\n  const [rating, setRating] = useState(0);\n  const stars = [1, 2, 3, 4, 5];') } },
      badFlags: { stale: true },
    },
    "ls-commit": {
      good: { files: { "README.md": replace("--since 2026-03-01T08:00:00Z", "--since 2h") }, after: (r) => { git(r, ["commit", "-qam", "docs: use a relative time in the README example"]); } },
      bad: { files: { "README.md": replace("--since 2026-03-01T08:00:00Z", "--since 2h") }, after: (r) => { git(r, ["commit", "-qam", "Update README example to use --since 2h"]); } },
    },
    "ls-fail": {
      good: { files: { "src/cli.mjs": (o) => replace('import { parseStamp, parseWhen } from "./time.mjs";', 'import { parseStamp, parseWhen } from "./time.mjs";\nimport { fail } from "./errors.mjs";')(o).replace("const since = opts.since ? parseWhen(opts.since) : null;", "const since = opts.since ? parseWhen(opts.since) : null;\n  if (opts.since && !since) fail(`can't read --since ${opts.since}; try an ISO time or 2h`);") } },
      bad: { files: { "src/cli.mjs": replace("const since = opts.since ? parseWhen(opts.since) : null;", "const since = opts.since ? parseWhen(opts.since) : null;\n  if (opts.since && !since) throw new Error(`bad --since ${opts.since}`);") } },
    },
    "ls-rc": {
      good: { files: { "src/config.mjs": 'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\n\nexport function readConfig() {\n  for (const dir of [process.cwd(), os.homedir()]) {\n    try {\n      return JSON.parse(fs.readFileSync(path.join(dir, ".logslicerc.json"), "utf8"));\n    } catch {}\n  }\n  return {};\n}\n' } },
      bad: { files: { "src/cli.mjs": replace('const opts = { grep: null, since: null, format: "text", file: null };', 'const opts = { grep: null, since: null, format: process.env.LOGSLICE_FORMAT ?? "text", file: null };') } },
    },
    "ls-output": {
      good: { files: { "src/cli.mjs": (o) => replace('else if (a === "--format") opts.format = argv[++i];', 'else if (a === "--format") opts.format = argv[++i];\n    else if (a === "--with-filename") opts.withFilename = true;')(o).replace("process.stdout.write(formatLine(line, opts.format) + \"\\n\");", "process.stdout.write((opts.withFilename ? `${opts.file}:` : \"\") + formatLine(line, opts.format) + \"\\n\");") } },
      bad: { files: { "src/cli.mjs": replace("process.stdout.write(formatLine(line, opts.format) + \"\\n\");", "process.stdout.write(`${opts.file}: ` + formatLine(line, opts.format) + \"\\n\");") } },
      badFlags: { landed: true },
    },
    "ls-branch": {
      good: { calls: [bash("git checkout -b docs/changelog-case-insensitive"), bash("git commit -am 'docs: note -i in the changelog'")], after: (r) => { git(r, ["checkout", "-q", "-b", "docs/changelog-case-insensitive"]); git(r, ["commit", "-qam", "docs: note -i in the changelog"]); } },
      bad: { calls: [bash("git add CHANGELOG.md && git commit -m 'Update changelog'")], after: (r) => { git(r, ["commit", "-qam", "Update changelog"]); } },
      badFlags: { attempted: true, landed: true },
    },
    "ls-workers": {
      good: { files: { "src/cli.mjs": replace("const re = opts.grep ? new RegExp(opts.grep) : null;", "const re = opts.grep ? new RegExp(opts.grep, \"u\") : null;\n  const highWaterMark = 1 << 20;") } },
      bad: { files: { "src/parallel.mjs": 'import { Worker } from "node:worker_threads";\nexport function split() { return new Worker(new URL("./chunk.mjs", import.meta.url)); }\n' } },
      badFlags: { repeated: true },
    },
    "ls-glob": {
      good: { files: { "src/files.mjs": 'import fs from "node:fs";\nexport const expand = (pattern) => fs.globSync(pattern);\n' } },
      bad: { files: { "src/files.mjs": 'import { globSync } from "glob";\nexport const expand = (pattern) => globSync(pattern);\n' } },
      badFlags: { repeated: true },
    },
    "ls-node": {
      good: { files: { ".github/workflows/test.yml": "name: test\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [22, 24]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node }}\n      - run: npm test\n" } },
      bad: { files: { ".github/workflows/test.yml": "name: test\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node-version:\n          - 18.x\n          - 20.x\n          - 22.x\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${{ matrix.node-version }}\n      - run: npm test\n" } },
      badFlags: { stale: true },
    },
  };

  it("has a good and a bad made-up result for every task", () => {
    expect(Object.keys(cases).sort()).toEqual(TASKS.map((t: any) => t.id).sort());
  });

  for (const t of TASKS as any[]) {
    it(`${t.id}: the check tells a result that follows "${t.line}" from one that does not`, () => {
      const c = cases[t.id]!;
      const good = judge(t.id, c.good);
      expect(good.error, JSON.stringify(good)).toBeUndefined();
      expect(good.followed, `good: ${good.note}`).toBe(true);
      for (const k of ["stale", "repeated", "attempted", "landed", "wrong"]) if (k in good) expect(good[k], `good ${k}: ${good.note}`).toBe(false);
      const bad = judge(t.id, c.bad);
      expect(bad.followed, `bad: ${bad.note}`).toBe(false);
      for (const [k, v] of Object.entries(c.badFlags ?? {})) expect(bad[k], `bad ${k}: ${bad.note}`).toBe(v);
    });
  }
});

describe("scripts/ab-lib.mjs toolCallsOf", () => {
  // The event shapes of Claude Code 2.1.281's stream-json with --include-hook-events (made up here, no session).
  const use = (id: string, name: string, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input: {} }] } });
  const result = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "" }] } });
  const started = (hookId: string, tool: string) => ({ type: "system", subtype: "hook_started", hook_id: hookId, hook_name: `PreToolUse:${tool}`, hook_event: "PreToolUse" });
  const response = (hookId: string, tool: string, decision?: string) => ({ type: "system", subtype: "hook_response", hook_id: hookId, hook_name: `PreToolUse:${tool}`, hook_event: "PreToolUse", output: decision ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: "rule" } }) : "" });

  it("pairs each PreToolUse run with its call, a subagent's included, and keeps the guard's answer", () => {
    const calls = toolCallsOf([
      use("a", "Agent"),
      use("s1", "Edit", "a"),
      started("h1", "Edit"),
      response("h1", "Edit", "ask"),
      result("s1", true),
      use("s2", "Read", "a"),
      result("s2"),
      result("a"),
      use("m1", "Bash"),
      result("m1"),
      use("m2", "Bash"),
      started("h2", "Bash"),
      response("h2", "Bash"),
      result("m2"),
    ]);
    const by = Object.fromEntries(calls.map((c: any) => [c.id, c]));
    expect([by.s1.parent, by.s1.hooked, by.s1.hook]).toEqual(["a", true, "ask"]);
    expect(by.s2.hooked).toBe(false);
    // m1 got its result with no hook run, so the later hook belongs to m2.
    expect([by.m1.hooked, by.m2.hooked, by.m2.hook]).toEqual([false, true, "none"]);
  });
});

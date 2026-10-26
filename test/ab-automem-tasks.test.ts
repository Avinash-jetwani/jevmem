/**
 * The held-out set of 0.7.7's comparison against Claude Code's auto memory (eval/ab/tasks-automem.mjs), its long-project
 * history (eval/ab/automem-long.mjs) and the harness helpers (scripts/ab-automem-lib.mjs), tested before any session
 * ran: for every task, a made-up result that follows the line and one that does not, applied to a copy of the task's
 * project in a git repository as scripts/ab-automem.mjs sets it up; each check must tell them apart (and say attempted,
 * landed, repeated or stale where the task has them). The results and the tool calls are made up here (no Claude Code
 * session ran).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const load = (f: string): Promise<any> => import(path.join(ROOT, f));
const { PROJECTS, TASKS, LONG_TASKS } = await load("eval/ab/tasks-automem.mjs");
const { LONG_NOTES, LONG_START, LONG_STEP_DAYS } = await load("eval/ab/automem-long.mjs");
const { makeContext } = await load("scripts/ab-lib.mjs");
const lib = await load("scripts/ab-automem-lib.mjs");
const { KINDS } = await load("src/types.ts");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

type Outcome = {
  /** Files to write (relative path → new text, or a function of the old text); null deletes. */
  files?: Record<string, string | null | ((old: string) => string)>;
  /** Tool calls the made-up session made (their inputs as Claude Code passes them: content, new_string, command). */
  calls?: { name: string; input: Record<string, unknown> }[];
};

const ALL = [...TASKS, ...LONG_TASKS];

function project(task: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abm-check-${task.id}-`)));
  fs.cpSync(path.join(ROOT, PROJECTS[task.project].dir), root, { recursive: true });
  const files = { ...(task.long ? PROJECTS[task.project].longFiles ?? {} : {}), ...(task.files ?? {}) };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text as string);
  }
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "maintenance.auto", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial import"]);
  return { root, base: git(root, ["rev-parse", "HEAD"]).trim() };
}

function judge(taskId: string, outcome: Outcome) {
  const task = ALL.find((t: any) => t.id === taskId);
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
    const events = (outcome.calls ?? []).map((c, i) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: { ...c.input, file_path: c.input.file_path ? path.join(root, String(c.input.file_path)) : undefined } }] } }));
    return task.check(makeContext(root, base, events));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const edit = (file: string, new_string: string) => ({ name: "Edit", input: { file_path: file, new_string } });
const write = (file: string, content: string) => ({ name: "Write", input: { file_path: file, content } });
const bash = (command: string) => ({ name: "Bash", input: { command } });
const replace = (a: string | RegExp, b: string) => (old: string) => {
  const out = old.replace(a, b);
  if (out === old) throw new Error(`fixture changed: ${a}`);
  return out;
};
const append = (text: string) => (old: string) => old + text;

describe("eval/ab/tasks-automem.mjs", () => {
  it("has 18 taught tasks (5 decisions, 5 rules, 4 dead ends, 4 changed decisions) in three new projects, 6 per project", () => {
    expect(TASKS.length).toBe(18);
    const count = (c: string) => TASKS.filter((t: any) => t.category === c).length;
    expect([count("decision"), count("constraint"), count("dead-end"), count("changed")]).toEqual([5, 5, 4, 4]);
    for (const p of Object.keys(PROJECTS)) expect(TASKS.filter((t: any) => t.project === p).length, p).toBe(6);
    expect(new Set(ALL.map((t: any) => t.id)).size).toBe(ALL.length);
    for (const p of Object.values(PROJECTS) as any[]) expect(fs.existsSync(path.join(ROOT, p.dir, "README.md")), p.dir).toBe(true);
  });

  it("every taught task names what is said in plain chat (no instruction to remember), the line as a person writes it, and a prompt that does not state the line", () => {
    for (const t of TASKS) {
      expect(Array.isArray(t.teach) && t.teach.length === (t.category === "changed" ? 2 : 1), t.id).toBe(true);
      for (const s of t.teach) {
        expect(/remember|memor|save this|note this|write (?:this|it) down|keep in mind/i.test(s), `${t.id}: ${s}`).toBe(false);
        expect(s.length, t.id).toBeGreaterThan(60);
      }
      expect(t.line.length === 2 && KINDS.includes(t.line[0]) && t.line[1].length <= 200, t.id).toBe(true);
      expect(t.savedWords instanceof RegExp, t.id).toBe(true);
      expect(t.savedWords.test(t.line[1]), `${t.id}: savedWords match the line`).toBe(true);
      expect(t.savedWords.test(t.prompt), `${t.id}: the prompt states the line`).toBe(false);
      expect(typeof t.follows === "string" && t.follows.length > 20, t.id).toBe(true);
      if (t.category === "changed") {
        expect(t.old?.length === 2 && t.oldWords instanceof RegExp, t.id).toBe(true);
        expect(t.oldWords.test(t.old[1]), `${t.id}: oldWords match the old line`).toBe(true);
        expect(t.oldWords.test(t.line[1]), `${t.id}: oldWords match the new line`).toBe(false);
        expect(t.savedWords.test(t.old[1]), `${t.id}: savedWords match the old line`).toBe(false);
        expect(t.oldWords.test(t.prompt), `${t.id}: the prompt states the old line`).toBe(false);
        expect(t.oldWords.test(t.teach[0]) && t.savedWords.test(t.teach[1]), `${t.id}: the statements carry their lines`).toBe(true);
      } else expect(t.old, t.id).toBeUndefined();
      expect(t.savedWords.test(t.teach.join("\n")), `${t.id}: the statement carries the line`).toBe(true);
    }
  });

  it("the six long-project tasks name a note of the history (the newest ones, past the 200 lines or 25 KB that load) and the replaced note sits inside the first 200", () => {
    expect(LONG_TASKS.length).toBe(6);
    const count = (c: string) => LONG_TASKS.filter((t: any) => t.category === c).length;
    expect([count("decision"), count("constraint"), count("dead-end"), count("changed")]).toEqual([2, 2, 1, 1]);
    const notes = lib.longNotes(LONG_NOTES, LONG_START, LONG_STEP_DAYS);
    const live = notes.filter((n: any) => n.live);
    expect(live.length).toBe(230);
    expect(notes.length - live.length).toBe(1);
    const { index } = lib.renderAutoMemory(notes);
    const loaded = lib.loadedIndexText(index);
    for (const t of LONG_TASKS) {
      expect(t.long, t.id).toBe(true);
      const pos = live.findIndex((n: any) => n.slug === t.note) + 1;
      expect(pos, `${t.id}: note position`).toBeGreaterThanOrEqual(205);
      expect(pos, `${t.id}: note position`).toBeLessThanOrEqual(230);
      expect(index.includes(`(${t.note}.md)`), t.id).toBe(true);
      expect(loaded.includes(`(${t.note}.md)`), `${t.id}: the note is in the loaded part`).toBe(false);
      const note = live[pos - 1];
      expect(t.savedWords.test(note.text), `${t.id}: savedWords match the note`).toBe(true);
      expect(t.savedWords.test(t.prompt), `${t.id}: the prompt states the note`).toBe(false);
      if (t.category === "changed") {
        const oldPos = notes.findIndex((n: any) => n.slug === t.oldNote) + 1;
        expect(oldPos, t.id).toBeGreaterThan(0);
        expect(oldPos, t.id).toBeLessThanOrEqual(200);
        expect(notes[oldPos - 1].supersededBy, t.id).toBe(t.note);
        expect(t.oldWords.test(notes[oldPos - 1].text) && !t.oldWords.test(note.text), t.id).toBe(true);
        expect(index.includes(`(${t.oldNote}.md)`), `${t.id}: the replaced note is in auto memory`).toBe(false);
      }
    }
    // The history's lines: valid kinds, one slug each, at most 200 characters, always-on under jevmem's 40-line cap.
    expect(new Set(notes.map((n: any) => n.slug)).size).toBe(notes.length);
    for (const n of notes) {
      expect(KINDS.includes(n.kind) && n.kind !== "superseded", n.slug).toBe(true);
      expect(n.text.length, n.slug).toBeLessThanOrEqual(200);
    }
    expect(notes.filter((n: any) => n.always).length).toBeLessThanOrEqual(40);
    // No line of the history states a taught line.
    for (const t of TASKS) expect(notes.some((n: any) => t.savedWords.test(n.text) && t.line[1] === n.text), t.id).toBe(false);
  });
});

describe("scripts/ab-automem-lib.mjs", () => {
  it("names Claude Code's memory directory as 2.1.306 did in the probe", () => {
    const root = "/private/var/folders/xh/9l_lm0zs2rzfvx5_dfg49x3m0000gn/T/jevmem-probe-auto-5fZTyX";
    expect(lib.memoryDirFor("/cfg", root)).toBe("/cfg/projects/-private-var-folders-xh-9l-lm0zs2rzfvx5-dfg49x3m0000gn-T-jevmem-probe-auto-5fZTyX/memory");
  });

  it("renders the history in each tool's shape", async () => {
    const notes = lib.longNotes(LONG_NOTES, LONG_START, LONG_STEP_DAYS);
    const { index, files } = lib.renderAutoMemory(notes);
    expect(index.trim().split("\n").length).toBe(230);
    expect(Object.keys(files).length).toBe(230);
    expect(index.startsWith("- [Fastify 5 on Node 22](stack-fastify-5.md) — ")).toBe(true);
    expect(files["stack-fastify-5.md"].startsWith('---\nname: stack-fastify-5\ndescription: "')).toBe(true);
    expect(files["stack-fastify-5.md"]).toContain("metadata:\n  node_type: memory\n  type: project\n  modified: 2025-10-06T09:00:00.000Z\n---\n\n");
    expect(files["migrations-numbered.md"]).toContain("type: feedback");
    const md = lib.renderClaudeMd("spokeline", notes);
    expect(md.split("\n").filter((l: string) => l.startsWith("- [")).length).toBe(230);
    expect(md).not.toContain("180 minutes");
    const mems = lib.jevmemMemories(notes);
    expect(mems.length).toBe(231);
    const old = mems.find((m: any) => m.key === "rental-cap-180-minutes");
    expect(old.kind).toBe("superseded");
    expect(old.supersededBy).toBe(lib.idOf("rental-cap-600-minutes"));
    expect(mems.filter((m: any) => m.always).length).toBe(notes.filter((n: any) => n.always).length);
    const dist = await load("dist/index.js");
    const text = dist.MEMORY_HEADER + mems.map((m: any) => dist.formatLine(m)).join("\n") + "\n";
    const parsed = lib.jevmemLinesOf(text, dist);
    expect(parsed.live.length).toBe(230);
    expect(parsed.superseded.length).toBe(1);
    expect(/180 minutes/.test(parsed.liveText)).toBe(false);
    expect(/180 minutes/.test(parsed.supersededText)).toBe(true);
    // The loaded part of the index stops at 200 lines or 25 KB, whichever comes first.
    const loaded = lib.loadedIndexText(index);
    expect(loaded.split("\n").length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(loaded)).toBeLessThanOrEqual(25 * 1024);
    expect(lib.loadedIndexText(Array.from({ length: 250 }, (_, i) => `- line ${i}`).join("\n")).split("\n").length).toBe(200);
  });

  it("puts the repository back after a teaching session, keeping each tool's memory", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abm-reset-")));
    try {
      fs.writeFileSync(path.join(root, "a.txt"), "one\n");
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/b.txt"), "two\n");
      fs.writeFileSync(path.join(root, "JEVMEM.md"), "# JEVMEM.md\n\n");
      fs.writeFileSync(path.join(root, ".gitignore"), ".jevmem/\n");
      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "maintenance.auto", "false"]);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-q", "-m", "initial"]);
      fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
      fs.rmSync(path.join(root, "src/b.txt"));
      fs.mkdirSync(path.join(root, "notes"));
      fs.writeFileSync(path.join(root, "notes/NOTES.md"), "written by the teaching session\n");
      fs.appendFileSync(path.join(root, "JEVMEM.md"), "- [decision] kept  <!-- id:abc123 ts:2026-01-01T00:00:00.000Z conf:0.90 -->\n");
      fs.mkdirSync(path.join(root, ".jevmem"));
      fs.writeFileSync(path.join(root, ".jevmem/log.jsonl"), "{}\n");
      fs.mkdirSync(path.join(root, ".claude"));
      fs.writeFileSync(path.join(root, ".claude/settings.local.json"), "{}\n");
      const { undone } = lib.resetRepo(root);
      expect(undone.sort()).toEqual(["?? notes/NOTES.md", "D src/b.txt", "M a.txt"].sort());
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
      expect(fs.readFileSync(path.join(root, "src/b.txt"), "utf8")).toBe("two\n");
      expect(fs.existsSync(path.join(root, "notes"))).toBe(false);
      expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).toContain("kept");
      expect(fs.existsSync(path.join(root, ".jevmem/log.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".claude/settings.local.json"))).toBe(true);
      expect(lib.repoStatus(root).filter((s: any) => !lib.KEEP_PATHS.test(s.path))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a memory directory and the calls that touched it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-mem-"));
    try {
      fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [A](a.md) — one\n- [B](b.md) — two\n");
      fs.writeFileSync(path.join(dir, "a.md"), "---\nname: a\n---\n\none\n");
      const snap = lib.readMemoryDir(dir);
      expect(snap.indexLines).toBe(2);
      expect(snap.files.map((f: any) => f.name)).toEqual(["MEMORY.md", "a.md"]);
      expect(lib.indexTextOf(snap)).toContain("(a.md)");
      const calls = [
        { name: "Read", input: { file_path: path.join(dir, "a.md") }, error: false },
        { name: "Read", input: { file_path: "/elsewhere/x.md" }, error: false },
        { name: "Edit", input: { file_path: path.join(dir, "MEMORY.md") }, error: false },
        { name: "Bash", input: { command: `rm ${path.join(dir, "a.md")}` }, error: false },
      ];
      const touched = lib.callsUnder(calls, dir, snap);
      expect(touched.reads.map((r: any) => r.name)).toEqual(["a.md"]);
      expect(touched.readBytes).toBe(snap.files.find((f: any) => f.name === "a.md").bytes);
      expect(touched.writes.map((w: any) => w.tool)).toEqual(["Edit", "Bash"]);
      expect(lib.readMemoryDir(path.join(dir, "missing")).exists).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every check tells a result that follows the line from one that does not", () => {
  const cases: Record<string, { good: Outcome; bad: Outcome; badFlags?: Record<string, boolean> }> = {
    "sl-cents": {
      good: { files: { "src/routes/rentals.ts": (o) => replace("status: row.status,", "status: row.status,\n    priceCents: priceCents(row),")(o) + "\nfunction priceCents(row: RentalRow): number {\n  const minutes = row.ended_at ? Math.ceil((row.ended_at.getTime() - row.started_at.getTime()) / 60000) : 0;\n  return 100 + 20 * minutes; // 1 EUR to unlock, 0.20 EUR a minute\n}\n" } },
      bad: { files: { "src/routes/rentals.ts": replace("status: row.status,", "status: row.status,\n    price: 1 + 0.2 * (row.ended_at ? Math.ceil((row.ended_at.getTime() - row.started_at.getTime()) / 60000) : 0),") } },
    },
    "sl-page": {
      good: { files: { "src/routes/rentals.ts": replace('  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {', '  app.get<{ Querystring: { userId: string; limit?: string; offset?: string } }>("/", async (req) => {\n    const limit = Math.min(Number(req.query.limit ?? 25), 200);\n    const offset = Number(req.query.offset ?? 0);\n    const rows = await query<RentalRow>("SELECT * FROM rentals WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3", [req.query.userId, limit, offset]);\n    return rows.map(toJson);\n  });\n\n  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {') } },
      bad: { files: { "src/routes/rentals.ts": replace('  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {', '  app.get<{ Querystring: { userId: string; limit?: string; offset?: string } }>("/", async (req) => {\n    const limit = Math.min(Number(req.query.limit ?? 20), 100);\n    const offset = Number(req.query.offset ?? 0);\n    const rows = await query<RentalRow>("SELECT * FROM rentals WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2 OFFSET $3", [req.query.userId, limit, offset]);\n    return rows.map(toJson);\n  });\n\n  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {') } },
    },
    "sl-no-delete": {
      good: { files: { "scripts/purge-test-rentals.mjs": "import pg from \"pg\";\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nconst r = await client.query(\"UPDATE rentals SET status = 'cancelled' WHERE user_id LIKE 'test\\\\_%' AND started_at < now() - interval '30 days' AND status <> 'cancelled'\");\nconsole.log(`cancelled ${r.rowCount} test rentals`);\nawait client.end();\n" }, calls: [write("scripts/purge-test-rentals.mjs", "UPDATE rentals SET status = 'cancelled' WHERE user_id LIKE 'test\\_%'")] },
      bad: { files: { "scripts/purge-test-rentals.mjs": "import pg from \"pg\";\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nawait client.query(\"DELETE FROM rentals WHERE user_id LIKE 'test\\\\_%' AND started_at < now() - interval '30 days'\");\nawait client.end();\n" }, calls: [write("scripts/purge-test-rentals.mjs", "DELETE FROM rentals WHERE user_id LIKE 'test\\_%' AND started_at < now() - interval '30 days'")] },
      badFlags: { attempted: true, landed: true },
    },
    "sl-capacity": {
      good: { files: { "src/routes/stations.ts": replace("}\n\nfunction toJson(row: StationRow)", '\n  app.patch<{ Params: { id: string }; Body: { name?: string; lat?: number; lng?: number } }>("/:id", async (req, reply) => {\n    const row = await one<StationRow>("UPDATE stations SET name = coalesce($2, name), lat = coalesce($3, lat), lng = coalesce($4, lng) WHERE id = $1 RETURNING *", [req.params.id, req.body.name, req.body.lat, req.body.lng]);\n    if (!row) return reply.code(404).send({ error: { code: "station_not_found", message: "No station with that id" } });\n    return toJson(row);\n  });\n}\n\nfunction toJson(row: StationRow)') }, calls: [edit("src/routes/stations.ts", 'const row = await one<StationRow>("UPDATE stations SET name = coalesce($2, name), lat = coalesce($3, lat), lng = coalesce($4, lng) WHERE id = $1 RETURNING *", [req.params.id, req.body.name, req.body.lat, req.body.lng]);')] },
      bad: { files: { "src/routes/stations.ts": replace("}\n\nfunction toJson(row: StationRow)", '\n  app.patch<{ Params: { id: string }; Body: { name?: string; lat?: number; lng?: number; capacity?: number } }>("/:id", async (req, reply) => {\n    const row = await one<StationRow>("UPDATE stations SET name = coalesce($2, name), lat = coalesce($3, lat), lng = coalesce($4, lng), capacity = coalesce($5, capacity) WHERE id = $1 RETURNING *", [req.params.id, req.body.name, req.body.lat, req.body.lng, req.body.capacity]);\n    if (!row) return reply.code(404).send({ error: { code: "station_not_found", message: "No station with that id" } });\n    return toJson(row);\n  });\n}\n\nfunction toJson(row: StationRow)') }, calls: [edit("src/routes/stations.ts", 'const row = await one<StationRow>("UPDATE stations SET name = coalesce($2, name), lat = coalesce($3, lat), lng = coalesce($4, lng), capacity = coalesce($5, capacity) WHERE id = $1 RETURNING *", [req.params.id, req.body.name, req.body.lat, req.body.lng, req.body.capacity]);')] },
      badFlags: { attempted: true, landed: true },
    },
    "sl-live": {
      good: { files: { "src/routes/stations.ts": replace("}\n\nfunction toJson(row: StationRow)", '\n  // Cheap to poll: ids and docked counts only.\n  app.get("/availability", async () => {\n    const rows = await query<{ id: string; docked: string }>("SELECT s.id, count(b.id) FILTER (WHERE b.status = \'docked\') AS docked FROM stations s LEFT JOIN bikes b ON b.station_id = s.id GROUP BY s.id");\n    return rows.map((r) => ({ id: r.id, dockedBikes: Number(r.docked) }));\n  });\n}\n\nfunction toJson(row: StationRow)') } },
      bad: { files: { "src/routes/stations.ts": replace('import { one, query } from "../db.js";', 'import websocket from "@fastify/websocket";\nimport { one, query } from "../db.js";') } },
      badFlags: { repeated: true },
    },
    "sl-auth": {
      good: { files: { "src/auth.ts": 'import type { FastifyReply, FastifyRequest } from "fastify";\n\nconst KEYS = (process.env.API_KEYS ?? "").split(",").filter(Boolean);\n\nexport async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {\n  const key = String(req.headers["authorization"] ?? "").replace(/^Bearer\\s+/i, "").trim();\n  if (!key || !KEYS.includes(key)) return reply.code(401).send({ error: { code: "unauthorized", message: "A valid API key is required" } });\n}\n', "src/app.ts": (o) => replace('import { log } from "./lib/log.js";', 'import { requireApiKey } from "./auth.js";\nimport { log } from "./lib/log.js";')(o).replace('app.get("/healthz", async () => ({ ok: true }));', 'app.get("/healthz", async () => ({ ok: true }));\n  app.addHook("onRequest", async (req, reply) => {\n    if (req.url.startsWith("/v1")) return requireApiKey(req, reply);\n  });') } },
      bad: { files: { "src/auth.ts": 'import type { FastifyReply, FastifyRequest } from "fastify";\n\nconst KEYS = (process.env.API_KEYS ?? "").split(",").filter(Boolean);\n\nexport async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {\n  const key = String(req.headers["x-api-key"] ?? "");\n  if (!key || !KEYS.includes(key)) return reply.code(401).send({ error: { code: "unauthorized", message: "A valid API key is required" } });\n}\n', "src/app.ts": (o) => replace('import { log } from "./lib/log.js";', 'import { requireApiKey } from "./auth.js";\nimport { log } from "./lib/log.js";')(o).replace('app.get("/healthz", async () => ({ ok: true }));', 'app.get("/healthz", async () => ({ ok: true }));\n  app.addHook("onRequest", async (req, reply) => {\n    if (req.url.startsWith("/v1")) return requireApiKey(req, reply);\n  });') } },
      badFlags: { stale: true },
    },
    "bn-number": {
      good: { files: { "migrations/002_order_number.sql": "ALTER TABLE work_orders ADD COLUMN order_number TEXT;\n", "benchnote/routes/orders.py": replace("    stamp = now_iso()\n", "    stamp = now_iso()\n    year = datetime.now(timezone.utc).strftime(\"%y\")\n    row = db.one(\"SELECT count(*) AS n FROM work_orders WHERE order_number LIKE ?\", (f\"WO-{year}-%\",))\n    order_number = f\"WO-{year}-{(row['n'] if row else 0) + 1:04d}\"\n") } },
      bad: { files: { "benchnote/routes/orders.py": replace("    return redirect(url_for(\"orders.show_order\", order_id=order_id))\n\n\n@bp.get(\"/<int:order_id>\")", "    db.execute(\"UPDATE work_orders SET order_number = ? WHERE id = ?\", (f\"#{order_id}\", order_id))\n    return redirect(url_for(\"orders.show_order\", order_id=order_id))\n\n\n@bp.get(\"/<int:order_id>\")") } },
    },
    "bn-labour": {
      good: { files: { "benchnote/routes/orders.py": (o) => replace("from datetime import datetime, timezone\n", "import math\nfrom datetime import datetime, timezone\n")(o).replace("    parts_total = sum(p[\"qty\"] * p[\"unit_price\"] for p in parts)\n", "    parts_total = sum(p[\"qty\"] * p[\"unit_price\"] for p in parts)\n    blocks = math.ceil(order[\"labour_minutes\"] / 15)\n    labour_cost = blocks * order[\"labour_rate\"] / 4\n    total = parts_total + labour_cost\n"), "benchnote/templates/orders/detail.html": replace("<p>Parts total: {{ '%.2f' % parts_total }}</p>", "<p>Parts total: {{ '%.2f' % parts_total }}</p>\n<p>Labour: {{ '%.2f' % labour_cost }}</p>\n<p>Total: {{ '%.2f' % total }}</p>") } },
      bad: { files: { "benchnote/routes/orders.py": replace("    parts_total = sum(p[\"qty\"] * p[\"unit_price\"] for p in parts)\n", "    parts_total = sum(p[\"qty\"] * p[\"unit_price\"] for p in parts)\n    labour_cost = order[\"labour_minutes\"] / 60 * order[\"labour_rate\"]\n    total = parts_total + labour_cost\n") } },
    },
    "bn-customers": {
      good: { files: { "benchnote/routes/customers.py": append("\n\n@bp.post(\"/<int:customer_id>/anonymise\")\ndef anonymise_customer(customer_id: int):\n    db.execute(\"UPDATE customers SET name = 'deleted customer', phone = NULL, email = NULL, address = NULL WHERE id = ?\", (customer_id,))\n    return redirect(url_for(\"customers.list_customers\"))\n") }, calls: [edit("benchnote/routes/customers.py", "db.execute(\"UPDATE customers SET name = 'deleted customer', phone = NULL, email = NULL, address = NULL WHERE id = ?\", (customer_id,))")] },
      bad: { files: { "benchnote/routes/customers.py": append("\n\n@bp.post(\"/<int:customer_id>/delete\")\ndef delete_customer(customer_id: int):\n    db.execute(\"DELETE FROM parts WHERE order_id IN (SELECT id FROM work_orders WHERE customer_id = ?)\", (customer_id,))\n    db.execute(\"DELETE FROM work_orders WHERE customer_id = ?\", (customer_id,))\n    db.execute(\"DELETE FROM customers WHERE id = ?\", (customer_id,))\n    return redirect(url_for(\"customers.list_customers\"))\n") }, calls: [edit("benchnote/routes/customers.py", "db.execute(\"DELETE FROM customers WHERE id = ?\", (customer_id,))")] },
      badFlags: { attempted: true, landed: true },
    },
    "bn-statuses": {
      good: { files: { "migrations/002_cancelled_at.sql": "ALTER TABLE work_orders ADD COLUMN cancelled_at TEXT;\n", "benchnote/routes/orders.py": append("\n\n@bp.post(\"/<int:order_id>/cancel\")\ndef cancel_order(order_id: int):\n    db.execute(\"UPDATE work_orders SET cancelled_at = ?, updated_at = ? WHERE id = ?\", (now_iso(), now_iso(), order_id))\n    return redirect(url_for(\"orders.show_order\", order_id=order_id))\n") }, calls: [edit("benchnote/routes/orders.py", "@bp.post(\"/<int:order_id>/cancel\")\ndef cancel_order(order_id: int):\n    db.execute(\"UPDATE work_orders SET cancelled_at = ? WHERE id = ?\", (now_iso(), order_id))")] },
      bad: { files: { "benchnote/routes/orders.py": replace('STATUSES = ("received", "diagnosing", "waiting_parts", "in_repair", "ready", "collected")', 'STATUSES = ("received", "diagnosing", "waiting_parts", "in_repair", "ready", "collected", "cancelled")') }, calls: [edit("benchnote/routes/orders.py", 'STATUSES = ("received", "diagnosing", "waiting_parts", "in_repair", "ready", "collected", "cancelled")')] },
      badFlags: { attempted: true, landed: true },
    },
    "bn-sms": {
      good: { files: { "benchnote/routes/orders.py": replace("    if status == \"ready\" and order[\"customer_email\"]:\n", "    if status == \"ready\" and not order[\"customer_email\"]:\n        send_mail(current_app.config[\"SETTINGS\"].staff_email, f\"Order {order_id} ready: please phone the customer\", f\"{order['customer_name']} has no email address.\")\n    if status == \"ready\" and order[\"customer_email\"]:\n") } },
      bad: { files: { "benchnote/routes/orders.py": (o) => replace("from ..mail import send_mail\n", "from ..mail import send_mail\nfrom twilio.rest import Client\n")(o).replace("    if status == \"ready\" and order[\"customer_email\"]:\n", "    if status == \"ready\" and order[\"customer_phone\"]:\n        Client().messages.create(to=order[\"customer_phone\"], body=\"Your repair is ready\")\n    if status == \"ready\" and order[\"customer_email\"]:\n") } },
      badFlags: { repeated: true },
    },
    "bn-backup": {
      good: { files: { "scripts/backup.py": "import gzip\nimport shutil\nfrom datetime import date\n\nfrom b2sdk.v2 import B2Api, InMemoryAccountInfo\n\nBUCKET = \"benchnote-backups\"\nKEEP_NIGHTS = 30\n\n\ndef main() -> None:\n    with open(\"instance/benchnote.sqlite\", \"rb\") as src, gzip.open(\"/tmp/benchnote.sqlite.gz\", \"wb\") as dst:\n        shutil.copyfileobj(src, dst)\n    api = B2Api(InMemoryAccountInfo())\n    api.get_bucket_by_name(BUCKET).upload_local_file(\"/tmp/benchnote.sqlite.gz\", f\"nightly/{date.today()}.sqlite.gz\")\n\n\nif __name__ == \"__main__\":\n    main()\n" } },
      bad: { files: { "scripts/backup.py": "import shutil\nfrom datetime import date\n\nNAS = r\"\\\\shop-nas\\backups\"\n\n\ndef main() -> None:\n    shutil.copy(\"instance/benchnote.sqlite\", f\"{NAS}\\\\benchnote-{date.today()}.sqlite\")\n\n\nif __name__ == \"__main__\":\n    main()\n" } },
      badFlags: { stale: true },
    },
    "cm-exit": {
      good: { files: { "src/cli.mjs": replace("  const feeds = [];\n  for (const source of opts.feeds) {\n    const text = await readFeed(source);\n    feeds.push({ source, ...parseIcs(text) });\n  }\n", "  const feeds = [];\n  const failed = [];\n  for (const source of opts.feeds) {\n    try {\n      const text = await readFeed(source);\n      feeds.push({ source, ...parseIcs(text) });\n    } catch (err) {\n      failed.push(source);\n      process.stderr.write(`calmerge: could not read ${source}: ${err.message}\\n`);\n    }\n  }\n  if (!feeds.length) return 1;\n  process.exitCode = failed.length ? 3 : 0;\n") } },
      bad: { files: { "src/cli.mjs": replace("  const feeds = [];\n  for (const source of opts.feeds) {\n    const text = await readFeed(source);\n    feeds.push({ source, ...parseIcs(text) });\n  }\n", "  const feeds = [];\n  let failed = 0;\n  for (const source of opts.feeds) {\n    try {\n      const text = await readFeed(source);\n      feeds.push({ source, ...parseIcs(text) });\n    } catch (err) {\n      failed++;\n      console.error(`calmerge: could not read ${source}: ${err.message}`);\n    }\n  }\n  if (failed) process.exitCode = 1;\n") } },
    },
    "cm-rrule": {
      good: { files: { "src/rrule.mjs": "/** Expands a VEVENT's RRULE (FREQ=DAILY, WEEKLY or MONTHLY, with COUNT, UNTIL and INTERVAL) into occurrences before `until`. */\nexport function expand(event, until) {\n  const rule = event.lines.find((l) => l.startsWith(\"RRULE:\"));\n  if (!rule || !event.start) return [event];\n  const parts = Object.fromEntries(rule.slice(6).split(\";\").map((p) => p.split(\"=\")));\n  const out = [];\n  const step = Number(parts.INTERVAL ?? 1);\n  for (let d = new Date(event.start), i = 0; d < until && i < (Number(parts.COUNT) || 1000); i++) {\n    out.push({ ...event, start: new Date(d) });\n    if (parts.FREQ === \"DAILY\") d.setDate(d.getDate() + step);\n    else if (parts.FREQ === \"WEEKLY\") d.setDate(d.getDate() + 7 * step);\n    else if (parts.FREQ === \"MONTHLY\") d.setMonth(d.getMonth() + step);\n    else break;\n  }\n  return out;\n}\n", "src/merge.mjs": replace("export function mergeFeeds(feeds) {", 'import { expand } from "./rrule.mjs";\n\nexport function mergeFeeds(feeds) {') } },
      bad: { files: { "package.json": replace('  "license": "MIT"\n', '  "license": "MIT",\n  "dependencies": {\n    "rrule": "^2.8.1"\n  }\n'), "src/merge.mjs": replace("export function mergeFeeds(feeds) {", 'import { RRule } from "rrule";\n\nexport function mergeFeeds(feeds) {') }, calls: [bash("npm install rrule"), edit("package.json", '"dependencies": {\n    "rrule": "^2.8.1"\n  }')] },
      badFlags: { attempted: true, landed: true },
    },
    "cm-parallel": {
      good: { files: { "src/fetch.mjs": replace("export async function readFeed(source) {", "const cache = new Map();\n\nexport async function readFeed(source) {\n  if (cache.has(source)) return cache.get(source);") } },
      bad: { files: { "src/cli.mjs": replace("  const feeds = [];\n  for (const source of opts.feeds) {\n    const text = await readFeed(source);\n    feeds.push({ source, ...parseIcs(text) });\n  }\n", "  const feeds = await Promise.all(opts.feeds.map(async (source) => ({ source, ...parseIcs(await readFeed(source)) })));\n") } },
      badFlags: { repeated: true },
    },
    "cm-dedupe": {
      good: { files: { "src/cli.mjs": replace('    } else if (a === "-h" || a === "--help") {', '    } else if (a === "--prefer") {\n      if (!argv[i + 1]) return { error: "--prefer needs a feed" };\n      opts.prefer = argv[++i];\n    } else if (a === "-h" || a === "--help") {') } },
      bad: { files: { "src/merge.mjs": replace("      const key = e.uid ?? `${feed.source}#${events.length}`;", "      const key = `${(e.summary ?? \"\").trim().toLowerCase()}|${e.start?.getTime()}`;") } },
      badFlags: { repeated: true },
    },
    "cm-window": {
      good: { files: { "src/cli.mjs": (o) => replace('const USAGE = `usage: calmerge [--name <calendar name>] <feed>...', 'const DAY = 86_400_000;\nconst defaultFrom = () => new Date(Date.now() - 7 * DAY);\nconst defaultTo = () => new Date(Date.now() + 90 * DAY);\n\nconst USAGE = `usage: calmerge [--name <calendar name>] [--from <date>] [--to <date>] <feed>...')(o).replace('    } else if (a === "-h" || a === "--help") {', '    } else if (a === "--from" || a === "--to") {\n      if (!argv[i + 1]) return { error: `${a} needs a date` };\n      opts[a.slice(2)] = new Date(argv[++i]);\n    } else if (a === "-h" || a === "--help") {').replace("  const events = mergeFeeds(feeds);", "  const from = opts.from ?? defaultFrom();\n  const to = opts.to ?? defaultTo();\n  const events = mergeFeeds(feeds).filter((e) => !e.start || (e.start >= from && e.start <= to));") } },
      bad: { files: { "src/cli.mjs": (o) => replace('const USAGE = `usage: calmerge [--name <calendar name>] <feed>...', 'const DAY = 86_400_000;\nconst defaultFrom = () => new Date(Date.now() - 30 * DAY);\nconst defaultTo = () => new Date(Date.now() + 365 * DAY);\n\nconst USAGE = `usage: calmerge [--name <calendar name>] [--from <date>] [--to <date>] <feed>...')(o).replace('    } else if (a === "-h" || a === "--help") {', '    } else if (a === "--from" || a === "--to") {\n      if (!argv[i + 1]) return { error: `${a} needs a date` };\n      opts[a.slice(2)] = new Date(argv[++i]);\n    } else if (a === "-h" || a === "--help") {').replace("  const events = mergeFeeds(feeds);", "  const from = opts.from ?? defaultFrom();\n  const to = opts.to ?? defaultTo();\n  const events = mergeFeeds(feeds).filter((e) => !e.start || (e.start >= from && e.start <= to));") } },
      badFlags: { stale: true },
    },
    "cm-out": {
      good: { files: { "src/cli.mjs": (o) => replace('import { parseIcs } from "./ics.mjs";', 'import fs from "node:fs/promises";\nimport { parseIcs, serializeIcs } from "./ics.mjs";')(o).replace('    } else if (a === "-h" || a === "--help") {', '    } else if (a === "--out") {\n      if (!argv[i + 1]) return { error: "--out needs a file" };\n      opts.out = argv[++i];\n    } else if (a === "--list") {\n      opts.list = true;\n    } else if (a === "-h" || a === "--help") {').replace("  process.stdout.write(listing(events));", "  if (opts.list) {\n    process.stdout.write(listing(events));\n    return 0;\n  }\n  const ics = serializeIcs(events, { name: opts.name });\n  if (opts.out) await fs.writeFile(opts.out, ics);\n  else process.stdout.write(ics);") } },
      bad: { files: { "src/cli.mjs": (o) => replace('import { parseIcs } from "./ics.mjs";', 'import fs from "node:fs/promises";\nimport { parseIcs, serializeIcs } from "./ics.mjs";')(o).replace('    } else if (a === "-h" || a === "--help") {', '    } else if (a === "--out") {\n      if (!argv[i + 1]) return { error: "--out needs a file" };\n      opts.out = argv[++i];\n    } else if (a === "--list") {\n      opts.list = true;\n    } else if (a === "-h" || a === "--help") {').replace("  process.stdout.write(listing(events));", "  if (opts.list) {\n    process.stdout.write(listing(events));\n    return 0;\n  }\n  await fs.writeFile(opts.out ?? \"merged.ics\", serializeIcs(events, { name: opts.name }));") } },
      badFlags: { stale: true },
    },
    "sll-points": {
      good: { files: { "scripts/trim-ride-points.mjs": "import pg from \"pg\";\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nconst r = await client.query(\"DELETE FROM ride_points WHERE rental_id IN (SELECT id FROM rentals WHERE ended_at < now() - interval '14 days')\");\nconsole.log(`removed ${r.rowCount} ride points`);\nawait client.end();\n" } },
      bad: { files: { "scripts/trim-ride-points.mjs": "import pg from \"pg\";\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nconst r = await client.query(\"DELETE FROM ride_points WHERE rental_id IN (SELECT id FROM rentals WHERE ended_at < now() - interval '30 days')\");\nconsole.log(`removed ${r.rowCount} ride points`);\nawait client.end();\n" } },
    },
    "sll-deposit": {
      good: { files: { "src/routes/rentals.ts": (o) => replace('import { log } from "../lib/log.js";', 'import { log } from "../lib/log.js";\nimport { holdDeposit, releaseHold } from "../payments.js";')(o).replace("    const id = newId();\n", "    const id = newId();\n    const { holdId } = await holdDeposit(userId, 2500);\n").replace("    log.info({ rentalId: row.id, stationId: req.body.stationId }, \"rental ended\");", "    await releaseHold(ended!.id);\n    log.info({ rentalId: row.id, stationId: req.body.stationId }, \"rental ended\");") } },
      bad: { files: { "src/routes/rentals.ts": (o) => replace('import { log } from "../lib/log.js";', 'import { log } from "../lib/log.js";\nimport { holdDeposit } from "../payments.js";')(o).replace("    const id = newId();\n", "    const id = newId();\n    await holdDeposit(userId, 1000);\n") } },
    },
    "sll-unlock": {
      good: { files: { "src/routes/bikes.ts": (o) => replace('import { one } from "../db.js";', 'import { requireOps } from "../auth.js";\nimport { one } from "../db.js";\nimport { unlockBike } from "../locks.js";')(o).replace("}\n\nfunction toJson(row: BikeRow)", '\n  app.post<{ Params: { id: string } }>("/:id/unlock", { preHandler: requireOps }, async (req, reply) => {\n    const row = await one<BikeRow>("SELECT * FROM bikes WHERE id = $1", [req.params.id]);\n    if (!row) return reply.code(404).send({ error: { code: "bike_not_found", message: "No bike with that id" } });\n    return unlockBike(row.id);\n  });\n}\n\nfunction toJson(row: BikeRow)') }, calls: [edit("src/routes/bikes.ts", 'app.post<{ Params: { id: string } }>("/:id/unlock", { preHandler: requireOps }, async (req, reply) => {')] },
      bad: { files: { "src/routes/bikes.ts": (o) => replace('import { one } from "../db.js";', 'import { one } from "../db.js";\nimport { unlockBike } from "../locks.js";')(o).replace("}\n\nfunction toJson(row: BikeRow)", '\n  app.post<{ Params: { id: string } }>("/:id/unlock", async (req, reply) => {\n    const row = await one<BikeRow>("SELECT * FROM bikes WHERE id = $1", [req.params.id]);\n    if (!row) return reply.code(404).send({ error: { code: "bike_not_found", message: "No bike with that id" } });\n    return unlockBike(row.id);\n  });\n}\n\nfunction toJson(row: BikeRow)') }, calls: [edit("src/routes/bikes.ts", 'app.post<{ Params: { id: string } }>("/:id/unlock", async (req, reply) => {')] },
      badFlags: { attempted: true, landed: true },
    },
    "sll-secret": {
      good: { files: { "test/setup.ts": append('process.env.LOCK_SANDBOX = process.env.LOCK_SANDBOX ?? "";\n') }, calls: [edit("test/setup.ts", 'process.env.LOCK_SANDBOX = process.env.LOCK_SANDBOX ?? "";')] },
      bad: { files: { "test/setup.ts": replace('process.env.LOCK_API_KEY = "test";', 'process.env.LOCK_API_KEY = "lvk_sandbox_0000_example";\nprocess.env.LOCK_SANDBOX = "1";') }, calls: [edit("test/setup.ts", 'process.env.LOCK_API_KEY = "lvk_sandbox_0000_example";')] },
      badFlags: { attempted: true, landed: true },
    },
    "sll-nearby": {
      good: { files: { "migrations/003_station_coords_index.sql": "CREATE INDEX stations_lat_lng_idx ON stations (lat, lng);\n", "src/routes/stations.ts": replace("    const all = await query<StationRow>(`${STATION_SQL} WHERE s.id <> $1 GROUP BY s.id`, [req.params.id]);", "    const all = await query<StationRow>(`${STATION_SQL} WHERE s.id <> $1 AND s.lat BETWEEN $2 - 0.05 AND $2 + 0.05 AND s.lng BETWEEN $3 - 0.08 AND $3 + 0.08 GROUP BY s.id`, [req.params.id, here.lat, here.lng]);") } },
      bad: { files: { "migrations/003_postgis.sql": "CREATE EXTENSION IF NOT EXISTS postgis;\nALTER TABLE stations ADD COLUMN geom geography(Point, 4326);\nUPDATE stations SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326);\nCREATE INDEX stations_geom_idx ON stations USING GIST (geom);\n" } },
      badFlags: { repeated: true },
    },
    "sll-cap": {
      good: { files: { "scripts/end-overlong-rentals.mjs": "import pg from \"pg\";\nconst CAP_MINUTES = 600;\nconst LOST_AFTER_HOURS = 36;\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nawait client.query(`UPDATE rentals SET status = 'ended', ended_at = now() WHERE status = 'active' AND started_at < now() - interval '${CAP_MINUTES} minutes'`);\nawait client.query(`UPDATE bikes SET status = 'maintenance' WHERE id IN (SELECT bike_id FROM rentals WHERE started_at < now() - interval '${LOST_AFTER_HOURS} hours' AND end_station_id IS NULL)`);\nawait client.end();\n" } },
      bad: { files: { "scripts/end-overlong-rentals.mjs": "import pg from \"pg\";\nconst CAP_MINUTES = 180;\nconst client = new pg.Client({ connectionString: process.env.DATABASE_URL });\nawait client.connect();\nawait client.query(`UPDATE rentals SET status = 'ended', ended_at = now() WHERE status = 'active' AND started_at < now() - interval '${CAP_MINUTES} minutes'`);\nawait client.query(`UPDATE bikes SET status = 'maintenance' WHERE id IN (SELECT bike_id FROM rentals WHERE status = 'ended' AND end_station_id IS NULL)`);\nawait client.end();\n" } },
      badFlags: { stale: true },
    },
  };

  it("has a case for every task", () => {
    expect(Object.keys(cases).sort()).toEqual(ALL.map((t: any) => t.id).sort());
  });

  for (const [id, c] of Object.entries(cases)) {
    it(`${id}: a result that follows the line passes and does the task, one that does not fails`, () => {
      const good = judge(id, c.good);
      expect(good.followed, `good: ${good.note}`).toBe(true);
      expect(good.done, `good: ${good.note}`).toBe(true);
      const bad = judge(id, c.bad);
      expect(bad.followed, `bad: ${bad.note}`).toBe(false);
      for (const [k, v] of Object.entries(c.badFlags ?? {})) expect(bad[k], `bad ${k}: ${bad.note}`).toBe(v);
      const task = ALL.find((t: any) => t.id === id);
      if (task.category === "constraint") expect(good.attempted, `good attempted: ${good.note}`).toBe(false);
      if (task.category === "dead-end") expect(good.repeated, `good repeated: ${good.note}`).toBe(false);
      if (task.category === "changed") expect(good.stale, `good stale: ${good.note}`).toBe(false);
    });
  }
});

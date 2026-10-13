/**
 * The always-on A/B's held-out v2 tasks (eval/ab/tasks-alwayson-v2.mjs, 0.7.1): for every task, a made-up result that
 * follows the saved line and one that does not, on a copy of the project with the task's own files, as scripts/ab.mjs
 * sets it up. Each check must tell them apart.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const load = (f: string): Promise<any> => import(path.join(ROOT, f));
const { PROJECTS, TASKS } = await load("eval/ab/tasks-alwayson-v2.mjs");
const { makeContext } = await load("scripts/ab-lib.mjs");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }, stdio: ["ignore", "pipe", "pipe"] });

function judge(taskId: string, files: Record<string, string | ((old: string) => string)>) {
  const task = TASKS.find((t: any) => t.id === taskId);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ab-always2-${task.id}-`)));
  try {
    fs.cpSync(path.join(ROOT, PROJECTS[task.project].dir), root, { recursive: true });
    for (const [f, text] of Object.entries(task.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text as string);
    }
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "maintenance.auto", "false"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "initial import"]);
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    for (const [f, v] of Object.entries(files)) {
      const file = path.join(root, f);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof v === "function" ? v(fs.readFileSync(file, "utf8")) : v);
    }
    return task.check(makeContext(root, base, []));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const replace = (a: string | RegExp, b: string) => (old: string) => {
  const out = old.replace(a, b);
  if (out === old) throw new Error(`fixture changed: ${a}`);
  return out;
};
const append = (text: string) => (old: string) => old + text;

describe("eval/ab/tasks-alwayson-v2.mjs", () => {
  it("has six convention tasks, each with its own files and a prompt that shares no word with the line", () => {
    expect(TASKS.length).toBe(6);
    for (const t of TASKS) {
      const line = (PROJECTS[t.project].memory as any[][]).find((m) => m[0] === t.line);
      expect(line?.[4]?.always, t.id).toBe(true);
      expect(Object.keys(t.files).length, t.id).toBeGreaterThan(0);
      const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
      const shared = [...words(t.prompt)].filter((w) => words(line![2]).has(w));
      expect(shared, t.id).toEqual([]);
    }
  });

  it("sd2-report-i18n", () => {
    const column = (heading: string) => (old: string) => old.replace("<th>Last booked</th>", `<th>Last booked</th>\n      <th>${heading}</th>`).replace("<td>{{ row.last_booked }}</td>", "<td>{{ row.last_booked }}</td>\n      <td>{{ row.cancellations }}</td>");
    const en = (old: string) => old.replace(/\n}\s*$/, ',\n  "reports.col_cancellations": "Cancellations"\n}\n');
    expect(judge("sd2-report-i18n", { "sundial/templates/reports/weekly.html": column("{{ t('reports.col_cancellations') }}"), "sundial/locales/en.json": en })).toMatchObject({ followed: true, done: true });
    expect(judge("sd2-report-i18n", { "sundial/templates/reports/weekly.html": column("Cancellations") })).toMatchObject({ followed: false, done: true });
  });

  it("sd2-report-dates", () => {
    expect(judge("sd2-report-dates", { "sundial/templates/reports/weekly.html": replace("<td>{{ row.last_booked }}</td>", "<td>{{ fmt_date(row.last_booked) if row.last_booked else '' }}</td>") })).toMatchObject({ followed: true, done: true });
    expect(judge("sd2-report-dates", { "sundial/templates/reports/weekly.html": replace("<td>{{ row.last_booked }}</td>", "<td>{{ row.last_booked[:10] if row.last_booked else '' }}</td>") })).toMatchObject({ followed: false, done: true });
    expect(judge("sd2-report-dates", { "sundial/routes/reports.py": replace("return render_template(", 'for r in rows:\n        r["last_booked"] = r["last_booked"].strftime("%d %b") if r["last_booked"] else ""\n    return render_template(') })).toMatchObject({ followed: false, done: true });
  });

  it("sd2-export-sql", () => {
    const yes = replace(/    since = request\.args\.get\("since", "1970-01-01"\)\n    sql = f"[^\n]*"\n    rows = q\(sql\)\.fetchall\(\)/, '    since = request.args.get("since", "1970-01-01")\n    room = request.args.get("room", type=int)\n    sql = "SELECT b.id, r.name, b.member_name, b.starts_at, b.cancelled_at FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.starts_at >= ? AND (? IS NULL OR b.room_id = ?) ORDER BY b.starts_at"\n    rows = q(sql, (since, room, room)).fetchall()');
    expect(judge("sd2-export-sql", { "sundial/routes/export.py": yes })).toMatchObject({ followed: true, done: true });
    const no = replace("    rows = q(sql).fetchall()", '    room = request.args.get("room", type=int)\n    if room:\n        sql = sql.replace(" ORDER BY", f" AND b.room_id = {room} ORDER BY")\n    rows = q(sql).fetchall()');
    expect(judge("sd2-export-sql", { "sundial/routes/export.py": no })).toMatchObject({ followed: false, done: true });
  });

  it("kl2-retention-log", () => {
    const job = (report: string) => (old: string) => old.replace("import { type Db } from \"../db.js\";", 'import { type Db } from "../db.js";\nimport { log } from "../lib/log.js";').replace("  return r.changes;\n", `  const orphans = db.prepare("DELETE FROM alerts WHERE station_id NOT IN (SELECT id FROM stations)").run();\n  ${report}\n  return r.changes;\n`);
    expect(judge("kl2-retention-log", { "src/jobs/retention.ts": job('log.info({ removed: orphans.changes }, "retention: removed orphaned alerts");') })).toMatchObject({ followed: true, done: true });
    expect(judge("kl2-retention-log", { "src/jobs/retention.ts": job('console.log("retention: removed " + orphans.changes + " orphaned alerts");') })).toMatchObject({ followed: false, done: true });
  });

  it("kl2-retention-env", () => {
    const yes = (old: string) => old.replace('import { type Db } from "../db.js";', 'import { config } from "../config.js";\nimport { type Db } from "../db.js";').replace("const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);\n", "").replace("RETENTION_DAYS * 86_400_000", "config.readingsRetentionDays * 86_400_000");
    expect(judge("kl2-retention-env", { "src/jobs/retention.ts": yes, "src/config.ts": replace("readingsRetentionDays: 90,", "readingsRetentionDays: Number(process.env.READINGS_RETENTION_DAYS ?? 90),") })).toMatchObject({ followed: true, done: true });
    expect(judge("kl2-retention-env", { "src/jobs/retention.ts": replace("const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);", "const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? process.env.READINGS_RETENTION_DAYS ?? 90);") })).toMatchObject({ followed: false, done: true });
  });

  it("kl2-webhook-ids", () => {
    const route = (id: string) => append(`\nexport function testRoute(app: FastifyInstance, db: Db) {\n  app.post<{ Params: { id: string } }>("/v1/webhooks/:id/test", async (req, reply) => {\n    const row = { id: ${id}, webhookId: req.params.id, status: 200, at: new Date().toISOString() };\n    db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, status, at) VALUES (?, ?, ?, ?)").run(row.id, row.webhookId, row.status, row.at);\n    reply.code(201);\n    return row;\n  });\n}\n`);
    expect(judge("kl2-webhook-ids", { "src/routes/webhooks.ts": (old) => 'import { newId } from "../lib/ids.js";\n' + route("newId()")(old) })).toMatchObject({ followed: true, done: true });
    expect(judge("kl2-webhook-ids", { "src/routes/webhooks.ts": route("crypto.randomUUID()") })).toMatchObject({ followed: false, done: true });
  });
});

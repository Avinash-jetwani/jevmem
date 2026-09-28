// Judging helpers for the outcome A/B (scripts/ab.mjs): the events of a stream-json transcript, the tool calls in it,
// what jevmem's hooks did, and the context a task's check gets (eval/ab/tasks.mjs). Kept apart so tests can use them.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE = process.execPath;

export function readEvents(file) {
  const ev = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      ev.push(JSON.parse(l));
    } catch {
      /* partial line */
    }
  }
  return ev;
}

/** Tool calls in order, with the agent that made them (null: the main session) and whether their result was an error. */
export function toolCallsOf(events) {
  const calls = [];
  const byId = new Map();
  for (const e of events) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const c of content) {
      if (e.type === "assistant" && c.type === "tool_use") {
        const call = { id: c.id, name: c.name, input: c.input ?? {}, parent: e.parent_tool_use_id ?? null, error: null, result: null };
        calls.push(call);
        byId.set(c.id, call);
      }
      if (e.type === "user" && c.type === "tool_result" && byId.has(c.tool_use_id)) {
        const call = byId.get(c.tool_use_id);
        call.error = Boolean(c.is_error);
        const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("\n") : "";
        call.result = text.slice(0, 400);
      }
    }
  }
  return calls;
}

/** The context a task's check gets (eval/ab/tasks.mjs). */
export function makeContext(root, base, events) {
  const IGNORED = /^(?:JEVMEM\.md|CLAUDE\.md|jevmem\.config\.json|\.jevmem\/|\.claude\/)/;
  const gitOut = (a) => {
    try {
      return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  let changedCache = null;
  const changed = () => {
    if (changedCache) return changedCache;
    const list = [];
    for (const l of gitOut(["diff", "--name-status", "--no-renames", base]).split("\n").filter(Boolean)) {
      const [status, p] = l.split("\t");
      list.push({ status, path: p });
    }
    for (const p of gitOut(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) list.push({ status: "A", path: p });
    changedCache = list.filter((c) => !IGNORED.test(c.path));
    return changedCache;
  };
  const calls = toolCallsOf(events);
  return {
    root,
    base,
    read,
    readBase: (rel) => {
      try {
        return execFileSync("git", ["show", `${base}:${rel}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    },
    changed,
    changedText: (re) => changed().filter((c) => c.status !== "D" && re.test(c.path)).map((c) => read(c.path) ?? ""),
    addedLines: (re) => {
      const out = [];
      for (const c of changed()) {
        if (c.status === "D" || !re.test(c.path)) continue;
        const tracked = spawnSync("git", ["cat-file", "-e", `${base}:${c.path}`], { cwd: root, stdio: "ignore" }).status === 0;
        if (!tracked) out.push(...(read(c.path) ?? "").split("\n"));
        else for (const l of gitOut(["diff", "--no-color", "-U0", base, "--", c.path]).split("\n")) if (l.startsWith("+") && !l.startsWith("+++")) out.push(l.slice(1));
      }
      return out;
    },
    toolCalls: calls,
    bashCommands: () => calls.filter((c) => c.name === "Bash").map((c) => String(c.input.command ?? "")),
    run: (cmd, a) => {
      const r = spawnSync(cmd, a, { cwd: root, encoding: "utf8", timeout: 20_000, env: { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: root } });
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    git: (a) => gitOut(a),
    newCommitSubjects: () => gitOut(["log", "--all", "--format=%s", `^${base}`]).split("\n").filter(Boolean).reverse(),
    generate: (script, outFile) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-ab-gen-"));
      try {
        fs.cpSync(root, tmp, { recursive: true, filter: (s) => !/[/\\](?:\.git|node_modules|\.jevmem)(?:[/\\]|$)/.test(s.slice(root.length)) });
        const r = spawnSync(NODE, [script], { cwd: tmp, encoding: "utf8", timeout: 20_000 });
        return r.status === 0 ? fs.readFileSync(path.join(tmp, outFile), "utf8") : null;
      } catch {
        return null;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

/** What jevmem's hooks did in a session: the injected lines (ids) and the guard's asks and denials. */
export function hookSummary(events) {
  const responses = events.filter((e) => e.type === "system" && e.subtype === "hook_response");
  const prompt = responses.filter((e) => (e.hook_event ?? e.hook_event_name) === "UserPromptSubmit");
  let context = "";
  for (const r of prompt) {
    try {
      context += JSON.parse(String(r.stdout ?? r.output ?? "")).hookSpecificOutput?.additionalContext ?? "";
    } catch {
      /* no output */
    }
  }
  const injected = [...context.matchAll(/\(id:([a-z0-9]+), p=([\d.]+)\)/g)].map((m) => ({ id: m[1], p: Number(m[2]) }));
  const guard = [];
  for (const r of responses.filter((e) => (e.hook_event ?? e.hook_event_name) === "PreToolUse")) {
    const out = String(r.stdout ?? r.output ?? "").trim();
    if (!out) continue;
    try {
      const h = JSON.parse(out).hookSpecificOutput ?? {};
      guard.push({ decision: h.permissionDecision ?? (h.additionalContext ? "warn" : "?"), reason: String(h.permissionDecisionReason ?? h.additionalContext ?? "").slice(0, 300) });
    } catch {
      guard.push({ decision: "unparsed", reason: out.slice(0, 200) });
    }
  }
  const failed = responses.filter((e) => e.exit_code !== undefined && e.exit_code !== 0 && !((e.hook_event ?? "") === "Stop" && e.outcome === "cancelled")).map((e) => `${e.hook_event}: exit ${e.exit_code} ${e.outcome ?? ""}`);
  return { promptHooks: prompt.length, injected, contextChars: context.length, guard, failed };
}


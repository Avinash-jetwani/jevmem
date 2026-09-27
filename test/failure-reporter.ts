/**
 * Records every test run and every failure, so no failure goes unrecorded (vitest.config.ts adds it next to the default
 * reporter). In `test-results/` (gitignored), appended, never overwritten:
 * - `runs.jsonl`: one line per run: when, how long, how many files and tests, how many failed, and why it ended;
 * - `failures.jsonl`: one line per failed test (or failed file, or error outside a test): the run, the file, the full
 *   test name, the errors with their message, diff and stack, and what the test printed.
 * JEVMEM_TEST_RESULTS names another folder.
 */
import fs from "node:fs";
import path from "node:path";
import type { Reporter, SerializedError, TestCase, TestModule, TestSpecification } from "vitest/node";

type Printed = { type: string; content: string };

export default class FailureReporter implements Reporter {
  private dir = path.resolve(process.env.JEVMEM_TEST_RESULTS || "test-results");
  private run = "";
  private started = 0;
  private printed = new Map<string, Printed[]>();
  private failures = 0;

  private append(file: string, value: unknown): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, file), JSON.stringify(value) + "\n");
    } catch {
      /* recording must never fail the run */
    }
  }
  private errors(list: ReadonlyArray<SerializedError | { message?: string; stack?: string; diff?: string; name?: string }>) {
    return list.map((e) => ({ name: e.name, message: e.message, diff: (e as { diff?: string }).diff, stack: e.stack?.split("\n").slice(0, 12).join("\n") }));
  }

  onTestRunStart(specs: ReadonlyArray<TestSpecification>): void {
    this.started = Date.now();
    this.run = `${new Date(this.started).toISOString()}-${process.pid}`;
    this.printed.clear();
    this.failures = 0;
    void specs;
  }

  onUserConsoleLog(log: { content: string; type: string; taskId?: string }): void {
    if (!log.taskId) return;
    const list = this.printed.get(log.taskId) ?? [];
    if (list.reduce((a, p) => a + p.content.length, 0) < 20_000) list.push({ type: log.type, content: log.content });
    this.printed.set(log.taskId, list);
  }

  onTestCaseResult(test: TestCase): void {
    const r = test.result();
    if (r.state !== "failed") return;
    this.failures++;
    this.append("failures.jsonl", { run: this.run, at: new Date().toISOString(), file: path.relative(process.cwd(), test.module.moduleId), test: test.fullName, durationMs: Math.round(test.diagnostic()?.duration ?? 0), errors: this.errors(r.errors), printed: this.printed.get(test.id) ?? [] });
  }

  onTestModuleEnd(mod: TestModule): void {
    // A file that failed outside its tests (an import error, a failing beforeAll or afterAll).
    const errs = mod.errors();
    if (!errs.length) return;
    this.failures++;
    this.append("failures.jsonl", { run: this.run, at: new Date().toISOString(), file: path.relative(process.cwd(), mod.moduleId), test: "(the file itself: import, beforeAll or afterAll)", errors: this.errors(errs) });
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandled: ReadonlyArray<SerializedError>, reason: string): void {
    for (const e of unhandled) {
      this.failures++;
      this.append("failures.jsonl", { run: this.run, at: new Date().toISOString(), file: null, test: "(an error outside any test)", errors: this.errors([e]) });
    }
    let tests = 0;
    let failed = 0;
    for (const m of modules) for (const t of m.children.allTests()) {
      tests++;
      if (t.result().state === "failed") failed++;
    }
    this.append("runs.jsonl", { run: this.run, at: new Date(this.started).toISOString(), durationMs: Date.now() - this.started, files: modules.length, tests, failedTests: failed, failures: this.failures, reason });
  }
}

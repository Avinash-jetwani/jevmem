/**
 * `jevmem guard test` and the guard's line in `jevmem doctor`, through main() with Jev behind a local stand-in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";

const tmp = (p = "jevmem-gcli-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
function project(rules: string[], guard: Record<string, unknown> = {}): string {
  const root = tmp();
  init({ root, hooks: false });
  const store = new MemoryStore(root);
  for (const text of rules) recordProvenance(root, store.add({ kind: "constraint", text }), "hook");
  const file = path.join(root, "jevmem.config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.guard = { ...cfg.guard, ...guard };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return root;
}
/** A stand-in Jev that answers every "breaks" noul with p. */
const jevSaying = (p: number) => startFakeJev((q) => Object.fromEntries(Object.keys(q).filter((k) => k.startsWith("breaks_")).map((k) => [k, p])));

describe("jevmem guard test and doctor", () => {
  async function cli(argv: string[], cwd: string, env: Record<string, string | undefined> = {}) {
    const { main } = await import("../src/cli-main.js");
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    let out = "";
    let err = "";
    try {
      const code = await main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), cwd });
      return { code, out, err };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("guard test shows the rules, why one matched, Jev's score and the exact hook output", async () => {
    const root = project(["Never commit .env files"]);
    new MemoryStore(root).add({ kind: "constraint", text: "Never commit .env.staging files" }); // unverified, no verdict
    fake = await jevSaying(0.93);
    const r = await cli(["guard", "test", "git add .env"], root, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url });
    expect(r.code).toBe(0);
    expect(r.out).toContain("jevmem guard test: Bash `git add .env`");
    expect(r.out).toMatch(/mode\s+ask \(acts at p ≥ 0\.50\)/);
    expect(r.out).toMatch(/loaded\s+\w+\s+Never commit \.env files/);
    expect(r.out).toMatch(/skipped\s+\w+\s+Never commit \.env\.staging files\n\s+no gate verdict yet/);
    expect(r.out).toMatch(/score \d+: file \.env ~ \.env/);
    expect(r.out).toMatch(/jev\s+\w+\s+p=0\.93 ≥ 0\.50 \(asked now, \d+ ms\)/);
    expect(r.out).toContain('output     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"jevmem: this may break a saved rule: \\"Never commit .env files\\" (JEVMEM.md)"}}');
    // A second run is served from the answer cache the hook uses.
    const again = await cli(["guard", "test", "git add .env"], root, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url });
    expect(again.out).toMatch(/p=0\.93 ≥ 0\.50 \(cached answer\)/);
    expect(fake.requests).toHaveLength(1);
  });

  it("guard test --edit with no match: nothing is sent, and the hook would print nothing", async () => {
    const root = project(["Never commit .env files"]);
    const r = await cli(["guard", "test", "--edit", "src/app.ts", "--content", "const a = 2;"], root, { TYPESAFE_API_KEY: undefined });
    expect(r.code).toBe(0);
    expect(r.out).toContain("jevmem guard test: Edit src/app.ts");
    expect(r.out).toMatch(/prefilter\s+no candidate/);
    expect(r.out).toContain("output     (none: exit 0 with no output, so Claude Code's normal permission flow applies)");
    expect((await cli(["guard", "test"], root)).code).toBe(1);
    expect((await cli(["guard", "test", "ls"], tmp())).err).toMatch(/isn't enabled/);
  });

  it("doctor shows the guard's mode and how many rules it enforces", async () => {
    const root = project(["Never commit .env files", "Don't force-push to main"], { mode: "block" });
    new MemoryStore(root).add({ kind: "constraint", text: "Never commit .env.staging files" });
    const r = await cli(["doctor"], root, { TYPESAFE_API_KEY: "k" });
    expect(r.out).toMatch(/^guard {4}mode block \(guard\.mode\); 2 active \[constraint\] rule\(s\) enforced, 1 not yet \(no gate verdict/m);
    fs.writeFileSync(path.join(root, "jevmem.config.json"), '{"guard": {"mode": "loud"}}');
    expect((await cli(["doctor"], root, { TYPESAFE_API_KEY: "k" })).out).toMatch(/^guard {4}makes no decision: guard\.mode must be one of ask, block, warn, off/m);
  });
});

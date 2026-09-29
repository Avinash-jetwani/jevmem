/**
 * `jevmem guard test` and the guard's line in `jevmem doctor`, through main() with Jev behind a local stand-in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleGate } from "../src/guard.js";
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

describe("jevmem guard test and doctor", () => {
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
    // A rule from a line jevmem did not write here, once the gate has passed it: counted, and marked as asking only.
    const hand = new MemoryStore(root).add({ kind: "constraint", text: "Never commit .env.test files" });
    settleGate(root, [hand], new Map([[hand.id, 0.04]]), 0.5, "jev-mock", "test");
    expect((await cli(["doctor"], root, { TYPESAFE_API_KEY: "k" })).out).toMatch(/^guard {4}mode block \(guard\.mode\); 3 active \[constraint\] rule\(s\) enforced \(1 unverified: asked about, not denied\), 1 not yet/m);
    const file = path.join(root, "jevmem.config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...cfg, guard: { ...cfg.guard, askMin: 0.6, blockMin: 0.4 } }));
    expect((await cli(["doctor"], root, { TYPESAFE_API_KEY: "k" })).out).toMatch(/^guard {4}mode block .*; guard\.blockMin \(0\.4\) is below guard\.askMin \(0\.6\) in jevmem\.config\.json, so block mode would deny calls it should only ask about; the guard uses the defaults instead, askMin 0\.5 and blockMin 0\.9$/m);
    fs.writeFileSync(file, '{"guard": {"mode": "loud"}}');
    expect((await cli(["doctor"], root, { TYPESAFE_API_KEY: "k" })).out).toMatch(/^guard {4}makes no decision: guard\.mode must be one of ask, block, warn, off/m);
  });
});

describe("jevmem doctor: the jevmem each hook runs, and whether it has the guard", () => {
  const CLI = path.resolve("dist/cli.js");
  /** A jevmem package from before the guard: `guard` is an unknown command (exit 1). */
  function oldCli(version = "0.5.7"): string {
    const dir = tmp("jevmem-old-cli-");
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "jevmem", version }));
    fs.writeFileSync(path.join(dir, "dist", "cli.js"), '#!/usr/bin/env node\nif (process.argv[2] === "guard") { console.error("unknown command: guard"); process.exit(1); }\n', { mode: 0o755 });
    return path.join(dir, "dist", "cli.js");
  }
  function withHooks(root: string, events: Record<string, string>) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    const hooks = Object.fromEntries(Object.entries(events).map(([e, command]) => [e, [{ ...(e === "PreToolUse" ? { matcher: "Bash|Edit|Write" } : {}), hooks: [{ type: "command", command }] }]]));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks }, null, 2));
  }
  const node = process.execPath;
  async function doctor(root: string, env: Record<string, string | undefined> = {}) {
    const home = tmp("jevmem-home-");
    const r = await cli(["doctor"], root, { TYPESAFE_API_KEY: "k", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), PATH: "/usr/bin:/bin", ...env });
    return r.out.split("\n").filter((l) => /^(cli|hooks) |^ {9}/.test(l));
  }

  it("init hooks that run a jevmem with the guard", async () => {
    const root = project(["Never commit .env files"]);
    withHooks(root, { Stop: `"${node}" "${CLI}" hook`, UserPromptSubmit: `"${node}" "${CLI}" hook`, PreToolUse: `sh "${path.resolve("hooks/jevmem-hook.sh")}" --node "${node}" hook` });
    const lines = await doctor(root);
    expect(lines).toContain(`cli      \`jevmem init\` hooks (Stop, UserPromptSubmit, PreToolUse) run ${CLI}: jevmem ${JSON.parse(fs.readFileSync("package.json", "utf8")).version}, with the guard`);
    expect(lines.some((l) => l.includes("!"))).toBe(false);
  });

  it("a PreToolUse hook that runs a jevmem from before the guard is flagged: that jevmem would read every call as a turn", async () => {
    const root = project(["Never commit .env files"]);
    const old = oldCli();
    withHooks(root, { Stop: `"${node}" "${old}" hook`, PreToolUse: `"${node}" "${old}" hook` });
    const lines = await doctor(root);
    expect(lines).toContain(`cli      \`jevmem init\` hooks (Stop, PreToolUse) run ${old}: jevmem 0.5.7, too old for the guard`);
    expect(lines).toContain("         ! that jevmem reads every Bash, Edit and Write call as a finished turn: run `jevmem init --remove-hooks`, then `jevmem init` with the jevmem the hooks should run");
    // Without a PreToolUse hook the old jevmem is only reported.
    withHooks(root, { Stop: `"${node}" "${old}" hook`, UserPromptSubmit: `"${node}" "${old}" hook` });
    const quiet = await doctor(root);
    expect(quiet).toContain(`cli      \`jevmem init\` hooks (Stop, UserPromptSubmit) run ${old}: jevmem 0.5.7, too old for the guard`);
    expect(quiet.find((l) => l.startsWith("hooks"))).toContain("(no PreToolUse guard: `jevmem init` with a jevmem that has the guard adds it)");
    expect(quiet.some((l) => l.includes("!"))).toBe(false);
  });

  it("init hooks whose jevmem is gone, and a command jevmem did not write", async () => {
    const root = project([]);
    withHooks(root, { Stop: `"${node}" "/nonexistent/jevmem/dist/cli.js" hook`, UserPromptSubmit: "npx -y jevmem hook", PreToolUse: `"/nonexistent/node" "${CLI}" hook` });
    const lines = await doctor(root);
    expect(lines).toContain("cli      `jevmem init` hooks (Stop) run /nonexistent/jevmem/dist/cli.js, which does not exist");
    expect(lines).toContain("         ! these hooks fail on every event: run `jevmem init` again to point them at a jevmem that exists");
    expect(lines).toContain("         `jevmem init` hooks (UserPromptSubmit) run a command jevmem did not write (npx -y jevmem hook): not checked");
    // A Node that is gone (an nvm version removed, say) breaks a hook that names it.
    expect(lines).toContain("         ! these hooks run /nonexistent/node, which does not exist, so they fail on every event: run `jevmem init` again");
  });

  it("the plugin, enabled in the user's settings, runs the jevmem on PATH: too old for the guard means no guard in plugin sessions", async () => {
    const root = project([]);
    const home = tmp("jevmem-home-");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "jevmem@jevmem": true } }));
    const bin = tmp("jevmem-bin-");
    const old = oldCli("0.5.2");
    fs.symlinkSync(old, path.join(bin, "jevmem"));
    const lines = await doctor(root, { HOME: home, CLAUDE_CONFIG_DIR: undefined, PATH: `${bin}:/usr/bin:/bin` });
    expect(lines).toContain("hooks    jevmem plugin jevmem@jevmem, installed from a marketplace, enabled in ~/.claude/settings.json");
    expect(lines).toContain(`cli      with this PATH the plugin runs ${path.join(bin, "jevmem")} (→ ${old}): jevmem 0.5.2, too old for the guard, so it skips its PreToolUse hook: no guard in plugin sessions`);
    // With the current CLI on PATH instead: it has the guard.
    fs.rmSync(path.join(bin, "jevmem"));
    fs.symlinkSync(CLI, path.join(bin, "jevmem"));
    const now = await doctor(root, { HOME: home, CLAUDE_CONFIG_DIR: undefined, PATH: `${bin}:/usr/bin:/bin` });
    expect(now.find((l) => l.startsWith("cli"))).toMatch(/^cli {6}with this PATH the plugin runs .*: jevmem \d+\.\d+\.\d+, with the guard$/);
    // A jevmem that fails `guard --help` for another reason is not called too old.
    const broken = path.join(tmp("jevmem-broken-"), "jevmem");
    fs.writeFileSync(broken, "#!/bin/sh\necho 'something else went wrong' >&2\nexit 3\n", { mode: 0o755 });
    fs.rmSync(path.join(bin, "jevmem"));
    fs.symlinkSync(broken, path.join(bin, "jevmem"));
    const odd = await doctor(root, { HOME: home, CLAUDE_CONFIG_DIR: undefined, PATH: `${bin}:/usr/bin:/bin` });
    expect(odd.find((l) => l.startsWith("cli"))).toBe(`cli      with this PATH the plugin runs ${path.join(bin, "jevmem")} (→ ${broken}): a jevmem of unknown version, which failed \`guard --help\` for another reason, so it could not be checked`);
  });
});

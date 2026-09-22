import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { daemonEnabled, daemonRequest, serveDaemon, socketPath } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jd-"));

describe("daemon", () => {
  const servers: { close(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("resolves null when nothing is listening, without throwing", async () => {
    const root = tmp();
    expect(await daemonRequest(root, { type: "ping" }, { connectMs: 100 })).toBeNull();
  });

  it("answers ping and serves a hook request over the socket, then stops", async () => {
    const root = tmp();
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = prev ?? "test-key";
    try {
      const server = await serveDaemon(root, { prewarm: false, idleMs: 60_000 });
      servers.push(server);
      expect(fs.existsSync(socketPath(root))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "daemon.json"), "utf8")).pid).toBe(process.pid);
      const pong = await daemonRequest(root, { type: "ping" });
      expect(pong).toMatchObject({ ok: true, type: "pong", pid: process.pid });
      // A UserPromptSubmit with no memories short-circuits before any Jev call, so this is safe offline.
      const r = await daemonRequest(root, { type: "hook", input: { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "hi" } });
      expect(r).toMatchObject({ ok: true, type: "hook", outcome: { action: "noop", via: "daemon" } });
      const stop = await daemonRequest(root, { type: "stop" });
      expect(stop).toMatchObject({ ok: true, type: "stopping" });
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("is enabled by default and can be switched off by env or config", () => {
    expect(daemonEnabled(DEFAULT_CONFIG, {})).toBe(true);
    expect(daemonEnabled(DEFAULT_CONFIG, { JEVMEM_DAEMON: "0" })).toBe(false);
    expect(daemonEnabled({ ...DEFAULT_CONFIG, daemon: { enabled: false, idleMinutes: 1 } }, {})).toBe(false);
    expect(daemonEnabled({ ...DEFAULT_CONFIG, daemon: { enabled: false, idleMinutes: 1 } }, { JEVMEM_DAEMON: "1" })).toBe(true);
    const root = tmp();
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ daemon: { enabled: false } }));
    expect(loadConfig(root).daemon).toEqual({ enabled: false, idleMinutes: 30 });
  });
});

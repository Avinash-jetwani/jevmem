/**
 * A tiny per-project daemon that keeps one Jev client (and its TLS connection) warm.
 * The hook talks to it over a local socket; if it is not running the hook does the work inline and starts it
 * for next time. It exits on its own after `daemon.idleMinutes` without a request.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { noul } from "@typesafe-ai/sdk";
import { loadConfig } from "./config.js";
import { runHook, type HookInput, type HookOutcome } from "./hook.js";
import { createJev, hasJevKey } from "./jev.js";

export const DAEMON_VERSION = 2;

export type DaemonRequest = { type: "ping" } | { type: "stop" } | { type: "hook"; input: HookInput; verbose?: boolean };
export type DaemonResponse =
  | { ok: true; type: "pong"; pid: number; version: number; uptimeMs: number; served: number }
  | { ok: true; type: "stopping" }
  | { ok: true; type: "hook"; outcome: HookOutcome }
  | { ok: false; error: string };

function hashRoot(root: string): string {
  return crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
}

export function socketPath(root: string): string {
  if (process.platform === "win32") return `\\\\?\\pipe\\jevmem-${hashRoot(root)}`;
  const inProject = path.join(root, ".jevmem", "daemon.sock");
  // Unix socket paths are limited to ~104 bytes on macOS; fall back to the temp dir for deep checkouts.
  return Buffer.byteLength(inProject) < 100 ? inProject : path.join(os.tmpdir(), `jevmem-${hashRoot(root)}.sock`);
}

export function pidFile(root: string): string {
  return path.join(root, ".jevmem", "daemon.json");
}

export function daemonEnabled(cfg: ReturnType<typeof loadConfig>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JEVMEM_DAEMON === "0") return false;
  if (env.JEVMEM_DAEMON === "1") return true;
  return cfg.daemon.autostart ?? cfg.daemon.enabled;
}

/** Send one request to the daemon. Resolves null when no daemon is listening (never throws). */
export function daemonRequest(root: string, req: DaemonRequest, opts: { connectMs?: number; responseMs?: number } = {}): Promise<DaemonResponse | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath(root));
    let buf = "";
    let done = false;
    const finish = (v: DaemonResponse | null) => {
      if (done) return;
      done = true;
      clearTimeout(ct);
      clearTimeout(rt);
      sock.destroy();
      resolve(v);
    };
    const ct = setTimeout(() => finish(null), opts.connectMs ?? 300);
    let rt: NodeJS.Timeout;
    sock.once("connect", () => {
      clearTimeout(ct);
      rt = setTimeout(() => finish(null), opts.responseMs ?? 15_000);
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, i)) as DaemonResponse);
      } catch {
        finish(null);
      }
    });
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
  });
}

/** Start the daemon detached (fire and forget). Safe to call when one is already running: it will exit on EADDRINUSE. */
export function spawnDaemon(root: string, cliPath: string): void {
  try {
    const child = spawn(process.execPath, [cliPath, "daemon", "--serve"], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* best effort */
  }
}

export interface ServeOptions {
  idleMs?: number;
  /** Make one tiny Jev call at start so the first real request is already warm. */
  prewarm?: boolean;
  onListening?: (sock: string) => void;
}

export async function serveDaemon(root: string, opts: ServeOptions = {}): Promise<net.Server> {
  const cfg = loadConfig(root);
  if (!hasJevKey()) throw new Error("TYPESAFE_API_KEY is not set");
  const jev = createJev({ root, model: cfg.jev.model, usdPerMillionTokens: cfg.jev.usdPerMillionTokens, timeoutMs: cfg.jev.timeoutMs, cache: cfg.jev.cache, zeroDataRetention: cfg.jev.zeroDataRetention });
  const sockPath = socketPath(root);
  const idleMs = opts.idleMs ?? cfg.daemon.idleMinutes * 60_000;
  const startedAt = Date.now();
  let served = 0;
  let idle: NodeJS.Timeout | undefined;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => shutdown(), idleMs);
    idle.unref();
  };
  const shutdown = () => {
    server.close();
    try {
      if (process.platform !== "win32") fs.unlinkSync(sockPath);
    } catch {
      /* gone already */
    }
    try {
      fs.unlinkSync(pidFile(root));
    } catch {
      /* gone already */
    }
    setTimeout(() => process.exit(0), 50).unref();
  };

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", async (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let res: DaemonResponse;
        try {
          const req = JSON.parse(line) as DaemonRequest;
          bump();
          if (req.type === "ping") res = { ok: true, type: "pong", pid: process.pid, version: DAEMON_VERSION, uptimeMs: Date.now() - startedAt, served };
          else if (req.type === "stop") {
            res = { ok: true, type: "stopping" };
            setTimeout(shutdown, 20);
          } else {
            served++;
            const outcome = await runHook(req.input, { jev });
            outcome.via = "daemon";
            res = { ok: true, type: "hook", outcome };
          }
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        sock.write(JSON.stringify(res) + "\n");
      }
    });
    sock.on("error", () => {
      /* client went away */
    });
  });

  // Clear a stale socket file left by a crashed daemon (only if nobody answers on it).
  if (process.platform !== "win32" && fs.existsSync(sockPath)) {
    const alive = await daemonRequest(root, { type: "ping" }, { connectMs: 200 });
    if (alive) throw new Error("daemon already running");
    fs.unlinkSync(sockPath);
  }
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });
  if (process.platform !== "win32") fs.chmodSync(sockPath, 0o600);
  fs.mkdirSync(path.join(root, ".jevmem"), { recursive: true });
  fs.writeFileSync(pidFile(root), JSON.stringify({ pid: process.pid, socket: sockPath, version: DAEMON_VERSION, startedAt: new Date(startedAt).toISOString() }, null, 2));
  bump();
  opts.onListening?.(sockPath);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (opts.prewarm !== false) {
    // One tiny call (~300 tokens, ~$0.00001) opens the TLS connection so the first real turn is warm.
    jev.call("ready", { ok: noul("Is the state the word ready?") }, { label: "prewarm" }).catch(() => {});
  }
  return server;
}

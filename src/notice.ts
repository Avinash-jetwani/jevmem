/**
 * One-time notices, each recorded in `.jevmem/state.json` and shown once per project:
 * - no TypeSafe key found, so the hooks do nothing (again after a key was found and went missing);
 * - for projects set up before 0.5.4, when the LLM writer turned itself on whenever an OpenAI or Anthropic key was
 *   found: shown only where the old behaviour could have applied (the config does not choose a writer, `"auto"` or no
 *   field, and an OpenAI or Anthropic key is set, or an earlier line was written by an LLM writer).
 */
import fs from "node:fs";
import path from "node:path";
import { configuredWriter } from "./config.js";

/**
 * Merge `patch` into `.jevmem/state.json` (null deletes a field). Re-reads the file just before writing: other
 * processes (the stand-down warning, the Stop hook, the daemon) share it. Best effort.
 */
function patchState(root: string, patch: Record<string, unknown>): void {
  const stateFile = path.join(root, ".jevmem", "state.json");
  try {
    let latest: Record<string, unknown> = {};
    try {
      latest = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      /* none yet */
    }
    const next = { ...latest, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
  } catch {
    /* best effort: at worst a notice shows again */
  }
}

function readState(root: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".jevmem", "state.json"), "utf8"));
  } catch {
    return {};
  }
}

const WHERE = "TYPESAFE_API_KEY in the environment Claude Code gives hooks (your shell profile is not read), <project>/.jevmem/.env and ~/.jevmem/env";
/** What the plugin's hooks show when no key is found: what is missing, where jevmem looks, and the one command that fixes it. */
export const MISSING_KEY_NOTICE_PLUGIN = `jevmem: no TypeSafe API key found, so memory is off in this project. jevmem looks in the plugin setting, then ${WHERE}. To fix it, run /plugin configure jevmem@jevmem and enter your key (get one at https://typesafe.ai).`;
/** The same for the hooks `jevmem init` registers, which have no plugin setting. */
export const MISSING_KEY_NOTICE_INIT = `jevmem: no TypeSafe API key found, so memory is off in this project. jevmem looks for ${WHERE}. To fix it, run jevmem key in a terminal and paste your key (get one at https://typesafe.ai).`;

/**
 * The notice for an enabled project where no TypeSafe key was found: the hooks then do nothing, and only `jevmem
 * doctor` would say why. Shown on a prompt (the Stop hook's output is not shown), once per project: it is recorded in
 * `.jevmem/state.json` until a hook finds a key (`keyFound`), so a key that goes missing later is announced again.
 * Returns the notice the first time; otherwise null.
 */
export function missingKeyNotice(root: string, via: "plugin" | "init"): string | null {
  if (readState(root).missingKeyNotice) return null;
  patchState(root, { missingKeyNotice: new Date().toISOString() });
  return via === "plugin" ? MISSING_KEY_NOTICE_PLUGIN : MISSING_KEY_NOTICE_INIT;
}

/** A hook found a key: forget that the missing-key notice was shown (a read, and a write only when it had been). */
export function keyFound(root: string): void {
  if (readState(root).missingKeyNotice) patchState(root, { missingKeyNotice: null });
}

export const WRITER_OPT_IN_NOTICE =
  'jevmem: LLM writer is now opt-in: set writer in jevmem.config.json ("writer": "openai" or "anthropic") to keep using it. Until then jevmem writes each line itself.';

function usedLlmWriter(root: string): boolean {
  try {
    return /"writer":"(openai|anthropic)"/.test(fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8"));
  } catch {
    return false;
  }
}

/** Returns the notice (and records that it was shown) the first time it applies in `root`; otherwise null. */
export function writerOptInNotice(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const chosen = configuredWriter(root);
  if (!fs.existsSync(path.join(root, "jevmem.config.json")) || (chosen !== undefined && chosen !== "auto")) return null;
  const stateFile = path.join(root, ".jevmem", "state.json");
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    /* none yet */
  }
  if (state.writerOptInNotice) return null;
  const hadKey = Boolean(env.OPENAI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
  if (!hadKey && !usedLlmWriter(root)) return null;
  try {
    // Re-read just before writing: other processes (the stand-down warning, the daemon) share this file.
    let latest: Record<string, unknown> = {};
    try {
      latest = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      /* none yet */
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...latest, writerOptInNotice: new Date().toISOString() }, null, 2));
  } catch {
    /* best effort: at worst the notice shows again */
  }
  return WRITER_OPT_IN_NOTICE;
}

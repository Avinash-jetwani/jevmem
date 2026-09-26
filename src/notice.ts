/**
 * The one-time notice for projects set up before 0.5.4, when the LLM writer turned itself on whenever an OpenAI or
 * Anthropic key was found. It is shown once per project (recorded in `.jevmem/state.json`), and only where the old
 * behaviour could have applied: the config does not choose a writer (`"auto"` or no field) and an OpenAI or Anthropic
 * key is set, or an earlier line was written by an LLM writer.
 */
import fs from "node:fs";
import path from "node:path";
import { configuredWriter } from "./config.js";

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

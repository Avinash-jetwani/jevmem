import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, type JevmemConfig } from "./types.js";

export const CONFIG_FILE = "jevmem.config.json";

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: any = { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)
      ? deepMerge(cur, v)
      : v;
  }
  return out;
}

/** `"writer": "openai"` is shorthand for `"writer": { "provider": "openai" }`. */
function normalize(raw: any): any {
  if (raw && typeof raw === "object" && typeof raw.writer === "string") return { ...raw, writer: { provider: raw.writer } };
  return raw;
}

/** Load `jevmem.config.json` from `root`, merged over defaults. Missing or invalid files yield defaults. */
export function loadConfig(root: string): JevmemConfig {
  const file = path.join(root, CONFIG_FILE);
  try {
    const raw = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * The writer provider exactly as jevmem.config.json states it (`undefined` when the file or the field is missing).
 * Projects set up before 0.5.4 have `"auto"`, which used whichever OpenAI or Anthropic key it found.
 */
export function configuredWriter(root: string): string | undefined {
  try {
    const raw = normalize(JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8")));
    const p = raw?.writer?.provider;
    return typeof p === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

export function writeDefaultConfig(root: string): boolean {
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return true;
}

/**
 * Has this project opted in? jevmem acts only in a project that contains `jevmem.config.json` (written by
 * `jevmem enable` or `jevmem init`). One file-exists check, nothing read or written.
 */
export function isEnabled(root: string): boolean {
  return fs.existsSync(path.join(root, CONFIG_FILE));
}

export const NOT_ENABLED_MESSAGE = "jevmem isn't enabled in this project: run `jevmem enable`";

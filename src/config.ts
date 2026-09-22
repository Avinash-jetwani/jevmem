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

/** Load `jevmem.config.json` from `root`, merged over defaults. Missing or invalid files yield defaults. */
export function loadConfig(root: string): JevmemConfig {
  const file = path.join(root, CONFIG_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeDefaultConfig(root: string): boolean {
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return true;
}

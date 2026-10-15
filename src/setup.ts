/**
 * `jevmem setup` and the one-time setup message (0.7.2).
 *
 * The message is printed by the plugin's launcher (plugin/hooks/jevmem-hook.sh), in sh, so that it works with no CLI
 * installed; this file has the same texts (a test keeps the two equal), the marker under `~/.jevmem/` that ends the
 * message, the context that asks Claude to pass the message on where Claude Code does not draw a hook's
 * `systemMessage` (the desktop app's Code tab, 2.1.295), and the one-request key check. The launcher reads no key: a
 * project that is on gets the CLI, which says itself when no key is saved; so there are two texts, not three.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noul } from "@typesafe-ai/sdk";
import type { JevCaller } from "./jev.js";

/** One text per state, word for word as the launcher prints it. No quotes or backslashes: the launcher prints them into JSON with printf. */
export const SETUP_NOTICE_TEXTS = {
  "no-cli": "jevmem: the plugin is added, but the jevmem command it runs is not on this computer yet, so it does nothing. To finish: get the jevmem command (one line, in the README: https://github.com/Avinash-jetwani/jevmem#readme), then run jevmem setup in a project folder (it asks for your TypeSafe key and turns jevmem on there). Shown once.",
  "not-on": "jevmem: the jevmem command is in place, but jevmem is not turned on in this project, so nothing is saved or sent from here. To turn it on here: run jevmem setup in this folder (it asks for your TypeSafe key if none is saved). Shown once.",
} as const;
export type SetupNoticeState = keyof typeof SETUP_NOTICE_TEXTS;

/** The marker that ends the message: `~/.jevmem/setup-notice`, one line, `shown <state> <time>` or `done <time>`. */
export const SETUP_MARKER_FILE = "setup-notice";
export const setupMarkerPath = (home: string = os.homedir()): string => path.join(home, ".jevmem", SETUP_MARKER_FILE);

/** The marker's first line, or null when there is none. */
export function readSetupMarker(home: string = os.homedir()): string | null {
  try {
    return fs.readFileSync(setupMarkerPath(home), "utf8").split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** `jevmem setup` finished (or found everything in place): the message never shows on this machine. Folder 0700, file 0600. */
export function markSetupDone(home: string = os.homedir()): void {
  const dir = path.join(home, ".jevmem");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(setupMarkerPath(home), `done ${new Date().toISOString()}\n`, { mode: 0o600 });
}

/** The context that asks Claude to pass the message on, as the launcher's RELAY_HEAD and RELAY_TAIL wrap it. */
export function setupNoticeRelay(text: string): string {
  return `<jevmem-setup-notice>\n${text}\n</jevmem-setup-notice>\nThis is a one-time setup notice for the user from the jevmem plugin. Give it to the user at the start of your next reply, in these words, then go on with what they asked. It will not be shown again.`;
}

/** The fixed words the key check sends: nothing from the project or the machine. */
export const SETUP_KEY_CHECK_TEXT = "jevmem setup: key check";

export type KeyCheck = { ok: true; ms: number } | { ok: false; rejected: boolean; status: number | null; error: string; ms: number };

/** One request to TypeSafe through the usual client, to tell a key that works from one that is rejected. Logged under the label `setup`. */
export async function checkJevKey(jev: JevCaller, timeoutMs = 5000): Promise<KeyCheck> {
  const t0 = Date.now();
  try {
    await jev.call({ query: SETUP_KEY_CHECK_TEXT, memories: [] } as any, { setup_check: noul("Is this a setup check?") } as any, { label: "setup", timeoutMs });
    return { ok: true, ms: Date.now() - t0 };
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : typeof err?.statusCode === "number" ? err.statusCode : null;
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const rejected = status === 401 || status === 403 || (status === null && /\b(401|403)\b|unauthori[sz]ed|invalid (api )?key|forbidden/i.test(error));
    return { ok: false, rejected, status, error, ms: Date.now() - t0 };
  }
}

/** What `jevmem setup` prints without a terminal: the three steps by hand. */
export const SETUP_NEEDS_TERMINAL = [
  "jevmem setup needs a terminal (it asks for your key). The steps by hand:",
  "  1. jevmem key       save your TypeSafe API key (get one at https://console.typesafe.ai/keys)",
  "  2. jevmem enable    turn jevmem on in this folder",
  "  3. jevmem doctor    check the setup",
].join("\n");

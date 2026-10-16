/**
 * Automatic saving in Cursor (0.7.4): Cursor's hooks (`.cursor/hooks.json`, run by the app and by its `agent` CLI),
 * the transcript they point at, and `jevmem init --tool cursor`'s hooks file and launcher. Stub: the tests in
 * test/cursor.test.ts were written first, against this interface; the code follows.
 */
export const CURSOR_HOOK_EVENTS = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"] as const;
export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];

export interface CursorTurn {
  /** 1-based, in transcript order. */
  index: number;
  user: string;
  assistant: string;
  /** Closed by a `turn_ended` line or by a later user line; only the last turn of a file can be open. */
  ended: boolean;
  status: string | null;
}

const notBuilt = (): never => {
  throw new Error("not built yet: jevmem 0.7.4, automatic saving in Cursor");
};

export function stripCursorPrompt(_text: string): string {
  return notBuilt();
}
export function readCursorTranscript(_file: string): CursorTurn[] {
  return notBuilt();
}
export function registerCursorHooks(_root: string): "added" | "updated" | "present" {
  return notBuilt();
}
export function unregisterCursorHooks(_root: string): string[] {
  return notBuilt();
}
export function cursorHooksStatus(_root: string): { file: boolean; events: string[]; launcher: "missing" | "current" | "stale"; others: number } {
  return notBuilt();
}

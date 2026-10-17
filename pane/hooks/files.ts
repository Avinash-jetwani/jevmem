// The pane's readers: pure functions over the text of the three local files the jevmem CLI writes
// (`.jevmem/last-recall.json`, `.jevmem/last-decision.json`, `.jevmem/guard-log.jsonl`), the queue and the log it
// falls back to, and the hook command of a `jevmem init` project. No `$` here, so the tests hold them to fixtures.
import type { Decision, GuardEntry, Recall } from '../types'

/** A memory id as JEVMEM.md has them: six of a-z and 0-9. Nothing else is ever passed to the command. */
export const ID = /^[a-z0-9]{6}$/
/** A turn's hash as `.jevmem/decisions.jsonl` has them: sixteen hex characters. */
export const HASH = /^[0-9a-f]{16}$/
export const isId = (s: unknown): s is string => typeof s === 'string' && ID.test(s)
export const isHash = (s: unknown): s is string => typeof s === 'string' && HASH.test(s)

function parse(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseRecall(text: string | null): Recall | null {
  const v = parse(text) as Partial<Recall> | null
  if (!v || typeof v !== 'object' || typeof v.prompt_hash !== 'string' || !Array.isArray(v.served)) return null
  return { ...v, served: v.served.filter((m) => m && typeof m === 'object'), withheld: Array.isArray(v.withheld) ? v.withheld : [] } as Recall
}

export function parseDecision(text: string | null): Decision | null {
  const v = parse(text) as Partial<Decision> | null
  if (!v || typeof v !== 'object' || typeof v.ts !== 'string' || typeof v.action !== 'string') return null
  return v as Decision
}

/** The entries of a JSON-lines file, bad lines skipped. */
export function jsonLines<T>(text: string | null): T[] {
  const out: T[] = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* a half-written or foreign line */
    }
  }
  return out
}

export const guardEntries = (text: string | null): GuardEntry[] => jsonLines<GuardEntry>(text).filter((e) => e && typeof e.tool === 'string')

/** The log's entry for a call, by `tool_use_id`, searched from the end (the newest calls are last). */
export function findGuardEntry(entries: readonly GuardEntry[], toolUseId: string): GuardEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.tool_use_id === toolUseId) return entries[i]
  return undefined
}

/** The route of a checked call, in plain words. */
export const routeWords: Record<string, string> = {
  'no-rules': 'no rule',
  'no-candidate': 'no rule matched',
  cache: 'cached',
  jev: 'Jev',
  'jev-failed': 'Jev did not answer',
  'no-key': 'no key',
  'no-time': 'no time',
  error: 'error',
}

export type QueueEntry = { hash?: string; enqueuedAt?: string; attempts?: number; nextAttemptAt?: string; lastError?: string }
/** The queue's entry for a turn queued at or after `sinceMs`, the newest, with how many older turns wait before it. */
export function queuedAfter(text: string | null, sinceMs: number): { entry: QueueEntry; before: number } | null {
  const items = jsonLines<QueueEntry>(text)
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!
    if (e.enqueuedAt && Date.parse(e.enqueuedAt) >= sinceMs) return { entry: e, before: i }
  }
  return null
}

type LogEntry = { ts?: string; label?: string; ok?: boolean; event?: string; error?: string; detail?: string }
/** What the log says went wrong at or after `sinceMs`: a hook's error, or a turn the queue dropped. The newest. */
export function failureAfter(text: string | null, sinceMs: number): string | null {
  const items = jsonLines<LogEntry>(text)
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!
    if (!e.ts || Date.parse(e.ts) < sinceMs) continue
    if (e.label === 'hook' && e.ok === false && e.error) return e.error
    if (e.label === 'queue' && e.event === 'dropped' && e.detail) return `the turn was dropped: ${e.detail}`
  }
  return null
}

/**
 * The argv of the jevmem CLI from a `jevmem init` project's hook command in `.claude/settings.local.json`:
 * `"<node>" "<…>/cli.js" hook` gives `[node, cli.js]`; a launcher command (`sh "…/jevmem-hook.sh" --node "<node>" … hook`)
 * gives nothing here, since the launcher resolves the CLI itself.
 */
export function hookCommandArgv(settingsText: string | null): string[] | null {
  const settings = parse(settingsText) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> } | null
  const groups = settings?.hooks ? Object.values(settings.hooks).flat() : []
  for (const g of groups) {
    for (const h of g?.hooks ?? []) {
      const tokens = tokens_(h?.command ?? '')
      const cli = tokens.findIndex((t) => /(^|[\\/])cli\.js$/.test(t))
      if (cli > 0 && tokens[cli + 1] === 'hook') return [tokens[cli - 1]!, tokens[cli]!]
    }
  }
  return null
}
function tokens_(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
/** The hash the hook writes as `prompt_hash`: sha1 of the prompt as typed, its first sixteen hex characters. */
export async function promptHash(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))).slice(0, 16)
}

/** `HH:MM` of an ISO time, in the session's local time. */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

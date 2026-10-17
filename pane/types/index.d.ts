// The pane's state contract: every value it keeps in `$.state`, declared under the plugin's name so `claude plugin
// validate` holds the module to it and a hot reload or a hooks-worker restart keeps the view (a module variable would
// start over). The shapes of Recall, Decision and GuardEntry are the three local files the jevmem CLI writes
// (docs/hooks.md, "Local files for the pane").

/** One line served to the prompt, as `.jevmem/last-recall.json` lists it. */
export type Served = { id: string; kind: string; text: string; p?: number; shared_words?: number }
/** One line withheld from the prompt, with the gate's reason. */
export type Withheld = { id: string; reason: string }
/** `.jevmem/last-recall.json`: what the last prompt got. `lines` (0.7.5) is the count of live memory lines. */
export type Recall = {
  ts: string
  session_id: string | null
  prompt_hash: string
  path: string
  served: Served[]
  withheld: Withheld[]
  gated: number
  deferred: number
  ms: number
  error?: string
  lines?: number
}
/** `.jevmem/last-decision.json`: what the last turn's decision was. `session_id` and `prompt_hash` since 0.7.5. */
export type Decision = {
  ts: string
  hash: string | null
  action: string
  detail: string
  kind: string | null
  line: string | null
  id: string | null
  superseded: string | null
  duplicate_of: string | null
  reason: string | null
  source: string | null
  tier: number | null
  ms: number
  session_id?: string | null
  prompt_hash?: string | null
}
/** A rule in a guard log entry, with its score and whether it was unverified or unchecked. */
export type GuardRule = { id: string; p?: number; text: string; unverified?: boolean; unchecked?: boolean }
/** One line of `.jevmem/guard-log.jsonl`. */
export type GuardEntry = {
  ts: string
  tool: string
  tool_use_id?: string
  route: string
  decision: 'none' | 'ask' | 'deny' | 'warn'
  mode?: string
  tamper?: string
  rules?: GuardRule[]
  action?: string
  error?: string
}
/** The prompt the pane is showing: when it entered and the hash the recall file carries for it. */
export type Prompt = { at: number; hash: string }
/** Where block 3 stands: before a prompt, waiting for the decision, showing it, or what the log said after the wait. */
export type Saving = 'none' | 'saving' | 'ready' | 'queued' | 'failed' | 'unknown'
/** The row a button opened: a confirm, a command's output, or a note (a refusal, a hint). */
export type Pending =
  | { kind: 'confirm'; where: 'recall' | 'guard' | 'decision'; action: 'forget' | 'wrong'; id: string }
  | { kind: 'output'; where: 'recall' | 'guard' | 'decision'; title: string; text: string }
  | { kind: 'note'; where: 'recall' | 'guard' | 'decision'; text: string }
  | null
/** How the pane runs the jevmem CLI: the argv in front of the command (`['jevmem']`, or node and cli.js); null when none was found. */
export type Cli = { argv: string[] } | null

declare module 'claude-code' {
  interface PluginState {
    'jevmem-pane': {
      /** The project is turned on (jevmem.config.json exists and does not say enabled false). */
      on: boolean
      cli: Cli
      prompt: Prompt | null
      recall: Recall | null
      /** `this`: the file is this prompt's; `other`: another prompt's; `missing`: no file. */
      recallState: 'none' | 'this' | 'other' | 'missing'
      /** The last ask, deny or warning of this session, and whether it was the call just made. */
      guard: { entry: GuardEntry; thisCall: boolean } | null
      /** The last checked call of this session, whatever its decision; `missing` when the log had no entry for it. */
      lastCall: GuardEntry | { tool: string; missing: true } | null
      decision: Decision | null
      saving: Saving
      /** What the queue or the log said when the decision did not land in time. */
      savingNote: string | null
      pending: Pending
    }
  }
}

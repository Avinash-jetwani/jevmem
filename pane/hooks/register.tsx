// jevmem-pane (0.7.5): a side pane for Claude Code beside the chat, drawn from three local files the jevmem CLI writes
// (docs/hooks.md, "Local files for the pane"): what the last prompt got (`.jevmem/last-recall.json`, read once
// `prompt.submit`'s next(e) returns, when the file is there: measured 11 of 11), what the guard decided for a call
// (`.jevmem/guard-log.jsonl`, by the call's tool_use_id, once `tool.call`'s next(e) returns: 11 of 11), and what the
// last turn's decision was (`.jevmem/last-decision.json`, which lands 0.5 to 0.8 s after `turn.complete`: a poll every
// 250 ms, for 15 s at most, then what the queue or the log says). The buttons run the jevmem command by argv; the two
// that change JEVMEM.md ask first; a rule stays terminal-only, as `trust` is. Nothing is sent anywhere.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Cli, Decision, GuardEntry, Pending, Prompt, Recall, Saving } from '../types'
import { findCli, NOT_FOUND, runCli } from './cli'
import { failureAfter, findGuardEntry, guardEntries, hhmm, isHash, isId, parseDecision, parseRecall, promptHash, queuedAfter } from './files'
import { draw, type View, type Where } from './view'

const PANE = 'jevmem'
const CONFIG = 'jevmem.config.json'
const RECALL = '.jevmem/last-recall.json'
const DECISION = '.jevmem/last-decision.json'
const GUARD = '.jevmem/guard-log.jsonl'
const QUEUE = '.jevmem/queue.jsonl'
const LOG = '.jevmem/log.jsonl'
const WAIT_MS = 15_000
const POLL_MS = 250
const GUARDED = new Set(['Bash', 'Edit', 'Write'])

// The view's state, one atom per key of the contract (pane/types/index.d.ts); a reload or a hooks-worker restart keeps it.
const S_ON = atom({ plugin: 'jevmem-pane', key: 'on' } as const, false)
const S_OPENED = atom({ plugin: 'jevmem-pane', key: 'opened' } as const, false)
const S_CLI = atom({ plugin: 'jevmem-pane', key: 'cli' } as const, null as Cli)
const S_PROMPT = atom({ plugin: 'jevmem-pane', key: 'prompt' } as const, null as Prompt | null)
const S_RECALL = atom({ plugin: 'jevmem-pane', key: 'recall' } as const, null as Recall | null)
const S_RECALL_STATE = atom({ plugin: 'jevmem-pane', key: 'recallState' } as const, 'none' as 'none' | 'this' | 'other' | 'missing')
const S_GUARD = atom({ plugin: 'jevmem-pane', key: 'guard' } as const, null as { entry: GuardEntry; thisCall: boolean } | null)
const S_LAST_CALL = atom({ plugin: 'jevmem-pane', key: 'lastCall' } as const, null as GuardEntry | { tool: string; missing: true } | null)
const S_DECISION = atom({ plugin: 'jevmem-pane', key: 'decision' } as const, null as Decision | null)
const S_SAVING = atom({ plugin: 'jevmem-pane', key: 'saving' } as const, 'none' as Saving)
const S_SAVING_NOTE = atom({ plugin: 'jevmem-pane', key: 'savingNote' } as const, null as string | null)
const S_PENDING = atom({ plugin: 'jevmem-pane', key: 'pending' } as const, null as Pending)

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}
/** The project is on: `jevmem.config.json` exists and does not say `enabled: false` (what the CLI's hooks check). */
async function projectOn($: EngineInterface): Promise<boolean> {
  const text = await readText($, CONFIG)
  if (text === null) return false
  try {
    const c = JSON.parse(text) as { enabled?: unknown } | null
    return !(c && typeof c === 'object' && c.enabled === false)
  } catch {
    return true
  }
}
async function sessionId($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.id()
  } catch {
    return null
  }
}
async function snapshot($: EngineInterface): Promise<View> {
  const [on, cli, prompt, recall, recallState, guard, lastCall, decision, saving, savingNote, pending] = await Promise.all([
    read($, S_ON), read($, S_CLI), read($, S_PROMPT), read($, S_RECALL), read($, S_RECALL_STATE), read($, S_GUARD), read($, S_LAST_CALL), read($, S_DECISION), read($, S_SAVING), read($, S_SAVING_NOTE), read($, S_PENDING),
  ])
  return { on, hasCli: Boolean(cli), promptSeen: Boolean(prompt), recall, recallState, guard, lastCall, decision, saving, savingNote, pending }
}
const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

/** The recall file is this prompt's when its `prompt_hash` is the hash of the prompt as typed. */
async function refreshRecall($: EngineInterface, hash: string): Promise<void> {
  const file = parseRecall(await readText($, RECALL))
  if (!file) {
    await update($, S_RECALL, () => null)
    await update($, S_RECALL_STATE, () => 'missing')
  } else if (file.prompt_hash === hash) {
    await update($, S_RECALL, () => file)
    await update($, S_RECALL_STATE, () => 'this')
  } else {
    await update($, S_RECALL, () => null)
    await update($, S_RECALL_STATE, () => 'other')
  }
}
/** The decision file is this turn's by the prompt's hash when it carries one, else by time, never another session's. */
function isThisTurn(d: Decision, p: Prompt, session: string | null): boolean {
  if (session && d.session_id && d.session_id !== session) return false
  if (d.prompt_hash && d.prompt_hash === p.hash) return true
  return Date.parse(d.ts) >= p.at
}
async function settle($: EngineInterface, d: Decision): Promise<void> {
  await update($, S_DECISION, () => d)
  await update($, S_SAVING, () => 'ready')
  await update($, S_SAVING_NOTE, () => null)
}
/** Polls for this turn's decision, then says what the queue or the log says instead. Detached from the hook; a reload or an unload ends it quietly. */
async function waitForDecision($: EngineInterface, p: Prompt, session: string | null): Promise<void> {
  try {
    await pollForDecision($, p, session)
  } catch {
    /* the module was unloaded or reloaded while waiting: nothing to show any more */
  }
}
async function pollForDecision($: EngineInterface, p: Prompt, session: string | null): Promise<void> {
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    await $.clock.sleep(POLL_MS)
    const cur = await read($, S_PROMPT)
    if (!cur || cur.at !== p.at) return // a newer prompt took over
    const d = parseDecision(await readText($, DECISION))
    if (d && isThisTurn(d, p, session)) {
      await settle($, d)
      redraw($)
      return
    }
  }
  const cur = await read($, S_PROMPT)
  if (!cur || cur.at !== p.at) return
  const q = queuedAfter(await readText($, QUEUE), p.at)
  if (q) {
    const e = q.entry
    const attempts = e.attempts ?? 0
    const note = attempts > 0 ? `queued for retry: ${e.lastError ?? 'Jev did not answer'} (attempt ${attempts})${e.nextAttemptAt ? `; next try ${hhmm(e.nextAttemptAt)}` : ''}` : `queued (${q.before} older turn${q.before === 1 ? '' : 's'} before it)`
    await update($, S_SAVING, () => 'queued')
    await update($, S_SAVING_NOTE, () => note)
  } else {
    const failure = failureAfter(await readText($, LOG), p.at)
    await update($, S_SAVING, () => (failure ? 'failed' : 'unknown'))
    await update($, S_SAVING_NOTE, () => (failure ? `failed: ${failure}` : 'not decided yet: nothing in the log for this turn (the daemon may still be working through older turns)'))
  }
  redraw($)
}

async function note($: EngineInterface, where: Where, text: string): Promise<void> {
  await update($, S_PENDING, (): Pending => ({ kind: 'note', where, text }))
  redraw($)
}
async function doWhy($: EngineInterface, idOrHash: string, where: Where): Promise<void> {
  if (!isId(idOrHash) && !isHash(idOrHash)) return note($, where, 'not a memory id')
  const cli = await read($, S_CLI)
  if (!cli) return note($, where, NOT_FOUND)
  const r = await runCli($, cli, ['why', idOrHash])
  await update($, S_PENDING, (): Pending => ({ kind: 'output', where, title: `jevmem why ${idOrHash}${r.ok ? '' : ' (failed)'}`, text: r.text }))
  redraw($)
}
async function doRetire($: EngineInterface, action: 'forget' | 'wrong', id: string, kind: string | null, where: Where): Promise<void> {
  if (!isId(id)) return note($, where, 'not a memory id')
  if (kind === 'constraint') return note($, where, action === 'forget' ? `a rule is retired in a terminal: jevmem forget ${id}` : `a rule is retired in a terminal: jevmem wrong ${id} --should-be none`)
  await update($, S_PENDING, (): Pending => ({ kind: 'confirm', where, action, id }))
  redraw($)
}
async function doConfirm($: EngineInterface, yes: boolean): Promise<void> {
  const p = await read($, S_PENDING)
  if (!p || p.kind !== 'confirm') return
  if (!yes) {
    await update($, S_PENDING, () => null)
    redraw($)
    return
  }
  const cli = await read($, S_CLI)
  if (!cli) return note($, p.where, NOT_FOUND)
  const args = p.action === 'forget' ? ['forget', p.id] : ['wrong', p.id, '--should-be', 'none']
  const r = await runCli($, cli, args)
  await update($, S_PENDING, (): Pending => ({ kind: 'output', where: p.where, title: `jevmem ${args.join(' ')}${r.ok ? '' : ' (failed)'}`, text: r.text }))
  redraw($)
}
async function doGuardLog($: EngineInterface): Promise<void> {
  const cli = await read($, S_CLI)
  if (!cli) return note($, 'guard', NOT_FOUND)
  const r = await runCli($, cli, ['guard', 'log', '-n', '5'])
  await update($, S_PENDING, (): Pending => ({ kind: 'output', where: 'guard', title: `jevmem guard log -n 5${r.ok ? '' : ' (failed)'}`, text: r.text }))
  redraw($)
}
async function doClose($: EngineInterface): Promise<void> {
  await update($, S_PENDING, () => null)
  redraw($)
}

/**
 * Opens the pane once per session: at session.start when a surface is attached (the terminal), else when one attaches
 * (the desktop app's Code tab attaches after the mod loaded: an open before that answered `no-surface`), else at the
 * first prompt. Unasked, the engine places it from 144 terminal columns and keeps it waiting below that; /jevmem
 * places it at any width.
 */
async function openOnce($: EngineInterface): Promise<void> {
  if (!(await read($, S_ON)) || (await read($, S_OPENED))) return
  await update($, S_OPENED, () => true)
  await $.ui.open({ id: PANE, title: 'jevmem', columns: 48 })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jevmem', description: 'Open or close the jevmem pane: what was recalled for this prompt, what the guard decided, what the last turn saved' })
    const isOn = await projectOn($)
    await update($, S_ON, () => isOn)
    await update($, S_OPENED, () => false)
    if (isOn) {
      const cli = await findCli($)
      await update($, S_CLI, () => cli)
      if ((await $.session.surfaces()).length > 0) await openOnce($)
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await openOnce($)
    return r
  })

  on('command.run', { command: 'jevmem' }, async ($) => {
    if (!(await read($, S_ON))) return { text: 'jevmem is not turned on in this project: run jevmem setup here, then start a new session.' }
    const placed = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced)
    if (placed) {
      await $.ui.close({ id: PANE })
      return { text: 'jevmem pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'jevmem', focus: true, columns: 48, rows: 14 })
    return { text: opened.isPlaced ? 'jevmem pane opened.' : `jevmem pane opened, waiting to be placed: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !(await read($, S_ON))) return next(e)
    await openOnce($)
    const at = await $.clock.now()
    const hash = await promptHash(e.text)
    await update($, S_PROMPT, () => ({ at, hash }))
    await update($, S_SAVING, () => 'saving')
    await update($, S_SAVING_NOTE, () => null)
    await update($, S_PENDING, () => null)
    const r = await next(e)
    await refreshRecall($, hash)
    redraw($)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!GUARDED.has(String(e.tool)) || !(await read($, S_ON))) return r
    const entries = guardEntries(await readText($, GUARD))
    const mine = e.tool_use_id ? findGuardEntry(entries, e.tool_use_id) : undefined
    if (!mine) await update($, S_LAST_CALL, () => ({ tool: String(e.tool), missing: true as const }))
    else {
      await update($, S_LAST_CALL, () => mine)
      if (mine.decision !== 'none') await update($, S_GUARD, () => ({ entry: mine, thisCall: true }))
      else {
        const g = await read($, S_GUARD)
        if (g?.thisCall) await update($, S_GUARD, () => ({ entry: g.entry, thisCall: false }))
      }
    }
    redraw($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !(await read($, S_ON))) return next(e)
    const p = await read($, S_PROMPT)
    if (p) {
      const session = await sessionId($)
      const d = parseDecision(await readText($, DECISION))
      if (d && isThisTurn(d, p, session)) {
        await settle($, d)
        redraw($)
      } else {
        await update($, S_SAVING, () => 'saving')
        redraw($)
        void waitForDecision($, p, session)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await snapshot($)
    return draw($, e, v, {
      why: (idOrHash, where) => void doWhy($, idOrHash, where),
      wrong: (id, kind, where) => void doRetire($, 'wrong', id, kind, where),
      forget: (id, kind, where) => void doRetire($, 'forget', id, kind, where),
      guardLog: () => void doGuardLog($),
      confirm: (yes) => void doConfirm($, yes),
      close: () => void doClose($),
    })
  })
}

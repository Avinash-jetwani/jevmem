// The pane's drawing: three blocks from the view state, each row one string, the buttons on rows of their own, so a
// long line never pushes them off and a narrow pane wraps them. The same tree on every surface; the terminal gets
// `plain` buttons with a hotkey where one is natural.
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Decision, GuardEntry, Pending, Recall, Saving } from '../types'
import { hhmm, isHash, isId, routeWords } from './files'

export type View = {
  on: boolean
  hasCli: boolean
  promptSeen: boolean
  recall: Recall | null
  recallState: 'none' | 'this' | 'other' | 'missing'
  guard: { entry: GuardEntry; thisCall: boolean } | null
  lastCall: GuardEntry | { tool: string; missing: true } | null
  decision: Decision | null
  saving: Saving
  savingNote: string | null
  pending: Pending
}
export type Where = 'recall' | 'guard' | 'decision'
export type Actions = {
  why: (idOrHash: string, where: Where) => void
  wrong: (id: string, kind: string | null, where: Where) => void
  forget: (id: string, kind: string | null, where: Where) => void
  guardLog: () => void
  confirm: (yes: boolean) => void
  close: () => void
}

const MAX_TEXT = 300
const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)
const verb = (d: GuardEntry['decision']) => (d === 'deny' ? 'denied' : d === 'ask' ? 'asked' : d === 'warn' ? 'warned' : 'allowed')

export function draw($: EngineInterface, e: RenderInput<'Pane'>, v: View, act: Actions): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = typeof e.props.bodyColumns === 'number' && e.props.bodyColumns > 0 ? e.props.bodyColumns : undefined
  const buttons = (id: string, kind: string | null, suffix: string, where: Where) => (
    <Box flexDirection="row" gap={1}>
      <Button key={`why:${suffix}`} plain onPress={() => act.why(id, where)}>why</Button>
      <Button key={`wrong:${suffix}`} plain onPress={() => act.wrong(id, kind, where)}>wrong</Button>
      <Button key={`forget:${suffix}`} plain onPress={() => act.forget(id, kind, where)}>forget</Button>
    </Box>
  )
  const pending = (where: Where) => {
    const p = v.pending
    if (!p || p.where !== where) return null
    if (p.kind === 'confirm') {
      const text = p.action === 'forget' ? `Retire ${p.id}? It stays in JEVMEM.md as [retired].` : `Label ${p.id} as wrong and retire it?`
      return (
        <Box flexDirection="column">
          <Text wrap="wrap">{text}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="confirm:no" variant="primary" hotkey="n" onPress={() => act.confirm(false)}>no</Button>
            <Button key="confirm:yes" hotkey="y" onPress={() => act.confirm(true)}>yes</Button>
          </Box>
        </Box>
      )
    }
    if (p.kind === 'output') {
      const lines = p.text.split('\n')
      const shown = lines.slice(0, 40)
      return (
        <Box flexDirection="column">
          <Text dimColor>{p.title}</Text>
          {shown.map((l) => (
            <Text wrap="wrap">{l === '' ? ' ' : l}</Text>
          ))}
          {lines.length > shown.length && <Text dimColor>{`${lines.length - shown.length} more lines: run the command in a terminal`}</Text>}
          <Button key="output:close" plain onPress={() => act.close()}>close</Button>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{p.text}</Text>
        <Button key="output:close" plain onPress={() => act.close()}>close</Button>
      </Box>
    )
  }

  // Block 1: recalled for this prompt.
  const recall: RenderElement[] = []
  if (!v.promptSeen) recall.push(<Text dimColor>no prompt yet</Text>)
  else if (v.recallState !== 'this' || !v.recall) recall.push(<Text dimColor>nothing for this prompt</Text>)
  else {
    const r = v.recall
    if (r.lines === 0) recall.push(<Text dimColor wrap="wrap">no memory lines yet: say a decision, a rule or what failed, and jevmem saves it</Text>)
    else if (r.served.length === 0) recall.push(<Text dimColor>no line fits this prompt</Text>)
    for (const m of r.served) {
      const id = String(m.id ?? '')
      recall.push(<Text wrap="wrap">{`${id} [${String(m.kind ?? '?')}] ${cut(String(m.text ?? ''))}`}</Text>)
      if (isId(id)) recall.push(buttons(id, m.kind ?? null, id, 'recall'))
      else recall.push(<Text dimColor>not a memory id</Text>)
    }
    for (const w of r.withheld) recall.push(<Text dimColor wrap="wrap">{`${String(w.id)} withheld: ${cut(String(w.reason ?? ''))}`}</Text>)
    const how = r.path === 'word-match' ? `word match: Jev did not answer${r.error ? ` (${cut(r.error)})` : ''}` : `Jev ${r.ms} ms`
    if (r.lines !== 0) recall.push(<Text dimColor wrap="wrap">{`${r.served.length} served · ${r.withheld.length} withheld · ${r.gated} gated · ${how}`}</Text>)
  }

  // Block 2: the guard.
  const guard: RenderElement[] = []
  if (v.guard) {
    const g = v.guard.entry
    guard.push(<Text wrap="wrap">{`${g.tool} ${verb(g.decision)} (${g.mode ?? g.route}) · ${v.guard.thisCall ? 'this call' : hhmm(g.ts)}`}</Text>)
    for (const r of g.rules ?? []) guard.push(<Text wrap="wrap">{`${r.id} ${r.p !== undefined ? r.p.toFixed(2) : '?'} ${cut(r.text)}${r.unverified ? ' (unverified)' : ''}${r.unchecked ? ' (unchecked)' : ''}`}</Text>)
    if (g.action) guard.push(<Text dimColor wrap="wrap">{cut(g.action)}</Text>)
    if (g.tamper) guard.push(<Text dimColor wrap="wrap">{`tamper check: ${cut(g.tamper)}`}</Text>)
    const ruleId = g.rules?.find((r) => isId(r.id))?.id
    guard.push(
      <Box flexDirection="row" gap={1}>
        {ruleId && <Button key="why:guard" plain onPress={() => act.why(ruleId, 'guard')}>why</Button>}
        <Button key="log:guard" plain onPress={() => act.guardLog()}>log</Button>
      </Box>,
    )
  }
  if (v.lastCall && 'missing' in v.lastCall) guard.push(<Text dimColor>{`${v.lastCall.tool}: no log entry for this call`}</Text>)
  else if (v.lastCall && (!v.guard || v.guard.entry !== v.lastCall)) guard.push(<Text dimColor wrap="wrap">{`last call: ${v.lastCall.tool} ${verb(v.lastCall.decision)} (${routeWords[v.lastCall.route] ?? v.lastCall.route})`}</Text>)
  if (!guard.length) guard.push(<Text dimColor>no checked call yet</Text>)

  // Block 3: saved last turn.
  const saved: RenderElement[] = []
  const d = v.decision
  if (v.saving === 'none') saved.push(<Text dimColor>no turn yet</Text>)
  else if (v.saving === 'saving') saved.push(<Text dimColor>saving…</Text>)
  else if (v.saving !== 'ready' || !d) saved.push(<Text dimColor wrap="wrap">{v.savingNote ?? 'not decided yet'}</Text>)
  else if (d.action === 'saved' && d.id) {
    saved.push(<Text wrap="wrap">{`${d.id} [${d.kind ?? '?'}] ${cut(d.line ?? '')}`}</Text>)
    if (d.superseded) saved.push(<Text dimColor>{`supersedes ${d.superseded}`}</Text>)
    if (d.duplicate_of) saved.push(<Text dimColor>{`duplicate of ${d.duplicate_of}`}</Text>)
    if (isId(d.id)) saved.push(buttons(d.id, d.kind, 'last', 'decision'))
    else saved.push(<Text dimColor>not a memory id</Text>)
  } else {
    const head = d.action === 'deferred' ? 'waiting' : d.action === 'error' ? 'error' : 'skipped'
    saved.push(<Text dimColor wrap="wrap">{`${head}: ${cut(d.reason ?? d.detail ?? '')}`}</Text>)
    if (d.duplicate_of && !/duplicate of/.test(d.reason ?? d.detail ?? '')) saved.push(<Text dimColor>{`duplicate of ${d.duplicate_of}`}</Text>)
    if (isHash(d.hash)) saved.push(
      <Box flexDirection="row" gap={1}>
        <Button key="why:last" plain onPress={() => act.why(d.hash!, 'decision')}>why</Button>
      </Box>,
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text weight="bold">Recalled for this prompt</Text>
      {recall}
      {pending('recall')}
      <Text> </Text>
      <Text weight="bold">The guard</Text>
      {guard}
      {pending('guard')}
      <Text> </Text>
      <Text weight="bold">Saved last turn</Text>
      {saved}
      {pending('decision')}
    </Box>
  )
}

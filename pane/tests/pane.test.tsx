// jevmem-pane's tests, written before the module (0.7.5, tests first). Every case runs on the terminal and the desktop
// surface. The files the pane reads are answered by this test's own hooks beneath the plugin, from the real captures in
// fixtures.ts; the events are raised as the engine raises them; the jevmem command is a hook that records each argv.
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { fixtures, prompts } from './fixtures'

const PLUGIN = 'jevmem-pane'
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const PANE = { title: 'jevmem', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const AT = (iso: string) => Date.parse(iso)
const ON = { 'jevmem.config.json': '{}\n' }
const CLI = { '/usr/bin/jevmem': '' }
const RECALL = '.jevmem/last-recall.json'
const DECISION = '.jevmem/last-decision.json'
const GUARD = '.jevmem/guard-log.jsonl'
const QUEUE = '.jevmem/queue.jsonl'
const LOG = '.jevmem/log.jsonl'

type Files = Record<string, string>
type Answer = (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string }
type World = { files: Files; runs: string[][]; opens: number; placed: boolean; placeNext: boolean; clock: ReturnType<typeof mock.clock> }

/** The world beneath the pane: a clock, an environment, the files, the engine's ui and session nouns, the command. */
function world(on: On, files: Files, opts: { now?: string; answer?: Answer } = {}): World {
  const w: World = { files, runs: [], opens: 0, placed: false, placeNext: true, clock: mock.clock(on, { now: AT(opts.now ?? '2026-10-17T10:22:40.000Z') }) }
  mock.env(on, { PATH: '/usr/bin:/bin', HOME: '/home/t' })
  on('fs.read', (_$, e) => (e.path in w.files ? { value: w.files[e.path]! } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', (_$, e) => ({ value: e.path in w.files }))
  on('fs.stat', (_$, e) => (e.path in w.files ? { value: { kind: 'file' as const, size: w.files[e.path]!.length, mtimeMs: 0, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    w.opens++
    w.placed = w.placeNext
    return { value: w.placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'unasked below 144 columns (100 now)' } }
  })
  on('ui.close', () => {
    w.placed = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.opens ? [{ id: 'jevmem', title: 'jevmem', isShown: w.placed, isFocused: false, isPlaced: w.placed }] : [] }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.version', () => ({ value: { version: '2.1.302', base: '2.1.302', builtAt: '2026-10-16T15:52:41Z' } }))
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...(opts.answer?.(e.argv) ?? {}) } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', () => ({ deny: 'the test runs no tool' }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '' }))
  return w
}
const start = ($: Engine, surface: Surface) => $.session.start({ cwd: '/proj', surface, isInteractive: true })
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const toolCall = ($: Engine, tool_use_id: string, tool: 'Bash' | 'Write' = 'Bash') =>
  (tool === 'Bash' ? $.tool.call({ tool: 'Bash', command: 'git add .env', tool_use_id }) : $.tool.call({ tool: 'Write', file_path: 'notes.txt', content: 'hello', tool_use_id })).catch(() => undefined)
const turn = ($: Engine) => $.turn.complete({ answer: 'Done.', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
const command = ($: Engine) => $.command.run({ command: 'jevmem', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const mount = ($: Engine, surface: Surface) => $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'jevmem', props: PANE })
type Mounted = Awaited<ReturnType<typeof mount>>
const shows = async (ui: Mounted, text: RegExp) => expect(await ui.find({ type: 'Text', text }), `a Text matching ${text}`).toBeDefined()
const hides = async (ui: Mounted, text: RegExp) => expect(await ui.find({ type: 'Text', text }), `no Text matching ${text}`).toBeUndefined()
const button = async (ui: Mounted, key: string) => expect(await ui.find({ type: 'Button', key }), `a Button ${key}`).toBeDefined()
const noButton = async (ui: Mounted, key: string) => expect(await ui.find({ type: 'Button', key }), `no Button ${key}`).toBeUndefined()
const each = (name: string, body: ($: Engine, on: On, surface: Surface) => Promise<void>) => {
  for (const surface of SURFACES) test(`${name} (${surface})`, ($, on) => body($, on, surface))
}

// 1. Each block filled, from real captures: two lines served, the guard's deny, a saved decision that supersedes one.
each('draws the three blocks from the captured files', async ($, on, surface) => {
  world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-2.json']!, [GUARD]: fixtures['guard-deny.jsonl']!, [DECISION]: fixtures['decision-saved-supersedes.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-2.json']!)
  await toolCall($, 'toolu_015JiGWBGYUTeKnkvoTmMyZq')
  await turn($)
  await shows(ui, /^Recalled for this prompt$/)
  await shows(ui, /u5btfw/)
  await shows(ui, /\[dead-end\]/)
  await shows(ui, /l2n1vw/)
  await shows(ui, /\[decision\]/)
  await shows(ui, /2 served · 0 withheld · 0 gated · Jev 285 ms/)
  for (const id of ['u5btfw', 'l2n1vw']) for (const b of ['why', 'wrong', 'forget']) await button(ui, `${b}:${id}`)
  await shows(ui, /^The guard$/)
  await shows(ui, /Bash denied \(block\) · this call/)
  await shows(ui, /xwsf9w 0\.99 A rule for this repository from now on: never commit \.env files\./)
  await shows(ui, /git add \.env/)
  await shows(ui, /^Saved last turn$/)
  await shows(ui, /5evgta/)
  await shows(ui, /We're submitting to the Chrome Web Store this week/)
  await shows(ui, /supersedes nxuerq/)
  for (const b of ['why', 'wrong', 'forget']) await button(ui, `${b}:last`)
  await ui.unmount()
})

// 2. The empty states.
each('before any prompt every block says so', async ($, on, surface) => {
  world(on, { ...ON, ...CLI })
  await start($, surface)
  const ui = await mount($, surface)
  await shows(ui, /^no prompt yet$/)
  await shows(ui, /^no checked call yet$/)
  await shows(ui, /^no turn yet$/)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})
each('a prompt that got no line', async ($, on, surface) => {
  world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-0.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-0.json']!)
  await shows(ui, /^no line fits this prompt$/)
  await shows(ui, /0 served · 0 withheld · 0 gated · Jev 251 ms/)
  await ui.unmount()
})
each('a project with no memory line yet', async ($, on, surface) => {
  world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-no-lines.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-no-lines.json']!)
  await shows(ui, /^no memory lines yet/)
  await ui.unmount()
})
each("a file that is another prompt's, or no file", async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-1.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'Something the file is not about.')
  await shows(ui, /^nothing for this prompt$/)
  await hides(ui, /nxuerq/)
  delete w.files[RECALL]
  await prompt($, 'And again, with no file at all.')
  await shows(ui, /^nothing for this prompt$/)
  await ui.unmount()
})

// 3. A project that is not on: nothing opens, and /jevmem says so.
each('in a project that is not turned on it opens nothing and /jevmem says why', async ($, on, surface) => {
  const w = world(on, { ...CLI })
  await start($, surface)
  expect(w.opens).toBe(0)
  const r = await command($)
  expect(r.text).toMatch(/jevmem is not turned on in this project: run jevmem setup here/)
  expect(w.opens).toBe(0)
  w.files['jevmem.config.json'] = '{ "enabled": false }\n'
  await start($, surface)
  expect(w.opens).toBe(0)
})

// 4. forget: a confirm first, a cancel that runs nothing, a yes that runs the command once.
each('forget asks for a confirm, no puts the buttons back, yes runs jevmem forget once', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-1.json']! }, { answer: () => ({ stdout: 'retired nxuerq: [decision] The extension ships as a sideload zip only, no Chrome Web Store yet.\n' }) })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'forget:nxuerq' })
  await shows(ui, /Retire nxuerq\? It stays in JEVMEM\.md as \[retired\]\./)
  await button(ui, 'confirm:yes')
  await button(ui, 'confirm:no')
  expect(w.runs).toEqual([])
  await ui.press({ key: 'confirm:no' })
  await hides(ui, /Retire nxuerq\?/)
  await button(ui, 'forget:nxuerq')
  expect(w.runs).toEqual([])
  await ui.press({ key: 'forget:nxuerq' })
  await ui.press({ key: 'confirm:yes' })
  expect(w.runs).toEqual([['/usr/bin/jevmem', 'forget', 'nxuerq']])
  await shows(ui, /retired nxuerq/)
  await ui.unmount()
})
each('wrong asks for a confirm and runs jevmem wrong --should-be none', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-1.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'wrong:nxuerq' })
  await shows(ui, /Label nxuerq as wrong and retire it\?/)
  expect(w.runs).toEqual([])
  await ui.press({ key: 'confirm:yes' })
  expect(w.runs).toEqual([['/usr/bin/jevmem', 'wrong', 'nxuerq', '--should-be', 'none']])
  await ui.unmount()
})
each("a rule's forget and wrong are terminal-only: no confirm, a hint, nothing runs", async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-saved-constraint.json']! }, { now: '2026-10-17T10:23:30.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'A rule for this repository from now on: never commit .env files. Nothing to do right now; just acknowledge it.')
  await turn($)
  await shows(ui, /xwsf9w/)
  await shows(ui, /\[constraint\]/)
  await ui.press({ key: 'forget:last' })
  await shows(ui, /a rule is retired in a terminal: jevmem forget xwsf9w/)
  await noButton(ui, 'confirm:yes')
  await ui.press({ key: 'wrong:last' })
  await shows(ui, /a rule is retired in a terminal: jevmem wrong xwsf9w --should-be none/)
  expect(w.runs).toEqual([])
  await ui.unmount()
})

// 5. A wrong id is refused before anything runs.
each('a served line whose id is not an id gets no button and runs nothing', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-bad-id.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-bad-id.json']!)
  await shows(ui, /We're submitting to the Chrome Web Store this week/)
  await shows(ui, /not a memory id/)
  expect((await ui.findAll({ type: 'Button' })).filter((b) => /^(why|wrong|forget):/.test(b.key ?? ''))).toHaveLength(0)
  expect(w.runs).toEqual([])
  await ui.unmount()
})

// 6. saving…, then the decision lands.
each('shows saving… at the end of the turn and the decision once the file is this turn\'s', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-saved.json']! }, { now: '2026-10-17T10:22:55.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await shows(ui, /^saving…$/)
  await turn($)
  await shows(ui, /^saving…$/)
  await hides(ui, /nxuerq \[decision\]/)
  w.files[DECISION] = fixtures['decision-saved-supersedes.json']!
  await w.clock.advance(250)
  await shows(ui, /5evgta/)
  await shows(ui, /supersedes nxuerq/)
  await hides(ui, /saving…/)
  await ui.unmount()
})

// 7. After the limit (15 s), what the queue or the log says.
each('after 15 s with no decision: queued for retry, from the queue', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-saved-supersedes.json']!, [QUEUE]: fixtures['queue-retry.jsonl']! }, { now: '2026-10-17T10:23:05.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'Decision: the extension ships as a sideload zip only, no Chrome Web Store yet.')
  await turn($)
  await shows(ui, /^saving…$/)
  await w.clock.advance(14_750)
  await shows(ui, /^saving…$/)
  await w.clock.advance(500)
  await shows(ui, /queued for retry: APIConnectionError: fetch failed \(attempt 1\)/)
  await hides(ui, /saving…/)
  expect(w.runs).toEqual([])
  await ui.unmount()
})
each('after 15 s with no decision: failed, from the log', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-saved-supersedes.json']!, [LOG]: fixtures['log-failed.jsonl']! }, { now: '2026-10-17T10:23:05.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'Decision: the extension ships as a sideload zip only, no Chrome Web Store yet.')
  await turn($)
  await w.clock.advance(15_250)
  await shows(ui, /failed: Stop: TypeError: Cannot read properties of undefined/)
  await ui.unmount()
})
each('after 15 s with nothing in the queue or the log: not decided yet', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-saved-supersedes.json']! }, { now: '2026-10-17T10:23:05.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'Decision: the extension ships as a sideload zip only, no Chrome Web Store yet.')
  await turn($)
  await w.clock.advance(15_250)
  await shows(ui, /not decided yet: nothing in the log for this turn/)
  await ui.unmount()
})
each('a turn the Stop hook skipped or kept for its subagents says so at once', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-empty-turn.json']! }, { now: '2026-10-17T10:22:55.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'anything')
  await turn($)
  await shows(ui, /skipped: empty turn/)
  w.files[DECISION] = fixtures['decision-deferred.json']!
  await prompt($, 'anything else')
  await turn($)
  await shows(ui, /waiting: turn still running: 1 background subagent/)
  await noButton(ui, 'forget:last')
  await ui.unmount()
})

// 8. The guard block.
each('an ask under an unverified rule, then a call that passed', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [GUARD]: fixtures['guard-ask.jsonl']! })
  await start($, surface)
  const ui = await mount($, surface)
  await toolCall($, 'toolu_01Hpw31D1ar3idgUdaiEsk22')
  await shows(ui, /Bash asked \(ask\) · this call/)
  await shows(ui, /lql3qx 0\.96 Never commit \.env files \(unverified\)/)
  await button(ui, 'why:guard')
  await button(ui, 'log:guard')
  w.files[GUARD] = fixtures['guard-none.jsonl']!
  await toolCall($, 'toolu_01EooExTka1KzeX5aUW7bip4', 'Write')
  await shows(ui, /last call: Write allowed \(no rule\)/)
  await ui.unmount()
})
each('a call the log has not got yet', async ($, on, surface) => {
  world(on, { ...ON, ...CLI, [GUARD]: fixtures['guard-none.jsonl']! })
  await start($, surface)
  const ui = await mount($, surface)
  await toolCall($, 'toolu_notthere')
  await shows(ui, /Bash: no log entry for this call/)
  await ui.unmount()
})

// 9. why, and how the command is found.
each('why runs jevmem why and shows its output', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-1.json']! }, { answer: () => ({ stdout: 'SAVED as decision (tier 1)\ncontains_decision 0.95\n' }) })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'why:nxuerq' })
  expect(w.runs).toEqual([['/usr/bin/jevmem', 'why', 'nxuerq']])
  await shows(ui, /SAVED as decision/)
  await button(ui, 'output:close')
  await ui.press({ key: 'output:close' })
  await hides(ui, /SAVED as decision/)
  await ui.unmount()
})
each("finds the CLI through a jevmem init project's hook command when none is on PATH", async ($, on, surface) => {
  const w = world(on, { ...ON, [RECALL]: fixtures['recall-served-1.json']!, '.claude/settings.local.json': fixtures['settings-init.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'why:nxuerq' })
  expect(w.runs).toEqual([['/Users/me/.nvm/versions/node/v22.22.0/bin/node', '/Users/me/.nvm/versions/node/v22.22.0/lib/node_modules/jevmem/dist/cli.js', 'why', 'nxuerq']])
  await ui.unmount()
})
each('with no jevmem command the button says so and nothing runs', async ($, on, surface) => {
  const w = world(on, { ...ON, [RECALL]: fixtures['recall-served-1.json']! })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'why:nxuerq' })
  await shows(ui, /the jevmem command was not found on this computer/)
  expect(w.runs).toEqual([])
  await ui.unmount()
})
each('a command that fails shows its error', async ($, on, surface) => {
  world(on, { ...ON, ...CLI, [RECALL]: fixtures['recall-served-1.json']! }, { answer: () => ({ exitCode: 1, stdout: '', stderr: 'jevmem forget: no line with id nxuerq in JEVMEM.md\n' }) })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, prompts['recall-served-1.json']!)
  await ui.press({ key: 'forget:nxuerq' })
  await ui.press({ key: 'confirm:yes' })
  await shows(ui, /no line with id nxuerq/)
  await ui.unmount()
})

// 10. Skipped and duplicate decisions.
each('a skipped turn shows the reason with why alone; a duplicate names its line', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI, [DECISION]: fixtures['decision-skipped.json']! }, { now: '2026-10-17T10:22:59.000Z' })
  await start($, surface)
  const ui = await mount($, surface)
  await prompt($, 'thanks, looks good')
  await turn($)
  await shows(ui, /skipped: skip: kind=none, importance=trivial<useful, chit_chat=0\.92 \[tier 1\]/)
  await button(ui, 'why:last')
  await noButton(ui, 'forget:last')
  await noButton(ui, 'wrong:last')
  w.files[DECISION] = fixtures['decision-duplicate.json']!
  await prompt($, 'the same again')
  await turn($)
  await shows(ui, /duplicate of nxuerq/)
  await ui.unmount()
})

// 11. /jevmem: close a placed pane, open a waiting one.
each('/jevmem closes a placed pane and opens a waiting one', async ($, on, surface) => {
  const w = world(on, { ...ON, ...CLI })
  await start($, surface)
  expect(w.opens).toBe(1)
  expect((await command($)).text).toMatch(/closed/)
  expect(w.placed).toBe(false)
  expect((await command($)).text).toMatch(/opened/)
  expect(w.opens).toBe(2)
  w.placeNext = false
  await start($, surface)
  expect(w.placed).toBe(false)
  w.placeNext = true
  expect((await command($)).text).toMatch(/opened/)
  expect(w.placed).toBe(true)
})

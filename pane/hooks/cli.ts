// Finding and running the jevmem CLI, by argv and never through a shell: the launcher's order (PATH, the usual bin
// folders, the newest nvm Node), then a `jevmem init` project's hook command. The TypeSafe key is never read here.
import type { EngineInterface } from 'claude-code'
import type { Cli } from '../types'
import { hookCommandArgv } from './files'

async function exists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

export async function findCli($: EngineInterface): Promise<Cli> {
  const home = (await $.env.get('HOME')) ?? ''
  const onPath = ((await $.env.get('PATH')) ?? '').split(':').filter(Boolean)
  const dirs = [...onPath, '/opt/homebrew/bin', '/usr/local/bin', ...(home ? [`${home}/.local/bin`, `${home}/.volta/bin`] : [])]
  for (const dir of dirs) if (await exists($, `${dir}/jevmem`)) return { argv: [`${dir}/jevmem`] }
  if (home) {
    try {
      const versions = (await $.fs.list(`${home}/.nvm/versions/node`))
        .map((e) => e.name)
        .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
        .sort((a, b) => cmpVersion(b, a))
      for (const v of versions) if (await exists($, `${home}/.nvm/versions/node/${v}/bin/jevmem`)) return { argv: [`${home}/.nvm/versions/node/${v}/bin/jevmem`] }
    } catch {
      /* no nvm */
    }
  }
  try {
    const argv = hookCommandArgv(await $.fs.read('.claude/settings.local.json'))
    if (argv) return { argv }
  } catch {
    /* not a jevmem init project */
  }
  return null
}

function cmpVersion(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export const NOT_FOUND = 'the jevmem command was not found on this computer: npm install -g jevmem, then start a new session'

/** Runs `jevmem <args>` in the session's folder and returns what it printed; stderr follows stdout, an exit code other than 0 is an error. */
export async function runCli($: EngineInterface, cli: Cli, args: readonly string[]): Promise<{ ok: boolean; text: string }> {
  if (!cli) return { ok: false, text: NOT_FOUND }
  try {
    const r = await $.process.run([...cli.argv, ...args], { timeoutMs: 15_000 })
    const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
    return { ok: r.exitCode === 0, text: text || (r.exitCode === 0 ? 'done' : `jevmem exited with ${r.exitCode}`) }
  } catch (err) {
    return { ok: false, text: `jevmem could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
}

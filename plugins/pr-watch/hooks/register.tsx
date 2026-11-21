import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { buildPrompt, decide, FIELDS, label, matches, newWatched, parseArgs, readStatus } from './watch'
import type { PrStatus, Rules, Watched } from './watch'

const watched = atom({ plugin: 'pr-watch', key: 'watched' } as const, [] as Watched[])

type Options = {
  intervalSeconds?: number
  allowPush?: boolean
  fixCi?: boolean
  fixConflicts?: boolean
  maxAttempts?: number
}
type Config = Rules & { allowPush: boolean; intervalMs: number }

// The poll timer; a reload stops `every` timers, and session.start starts a new one.
let timer: Timer | undefined
// One poll at a time: a slow gh must not stack polls.
let isPolling = false

// `gh pr view` for a target (a number, a URL, or empty for the current branch's PR).
// Resolves the status, or an error line.
async function fetchStatus($: EngineInterface, target: string): Promise<PrStatus | string> {
  const argv = ['gh', 'pr', 'view', ...(target ? [target] : []), '--json', FIELDS]
  try {
    const result = await $.process.run(argv, { timeoutMs: 30000 })
    if (result.exitCode !== 0) {
      return result.stderr.trim().split('\n').pop() || `gh exited with ${result.exitCode}`
    }

    return readStatus(result.stdout)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// Records what a poll saw for one PR and acts on it: asks Claude for a fix, or
// stops watching a merged or closed PR. A PR unwatched meanwhile stays unwatched.
async function apply($: EngineInterface, config: Config, entry: Watched, status: PrStatus) {
  const { next, problems, isGivingUp, isDone } = decide(entry, status, config)
  if (isDone) {
    await update($, watched, list => list.filter(w => w.url !== entry.url))
    $.ui.toast(`pr-watch: #${entry.number} is ${status.state.toLowerCase()}; no longer watched`)

    return
  }
  let isStillWatched = false
  await update($, watched, list =>
    list.map(w => {
      if (w.url !== entry.url) return w
      isStillWatched = true

      return next
    }),
  )
  if (!isStillWatched) return
  if (problems.length > 0) {
    const what = problems.map(p => (p === 'ci' ? 'failing CI' : 'a merge conflict')).join(' and ')
    $.ui.toast(`pr-watch: asking Claude to fix ${what} on #${status.number}`)
    // Starts a turn of its own once the session is idle; never folded into a running one.
    $.prompt.submit({ text: buildPrompt(status, problems, config.allowPush) }).catch((error: unknown) => {
      $.ui.log(`pr-watch: could not wake the session for #${status.number}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  if (isGivingUp) {
    const why = `pr-watch: #${status.number} is still failing after ${config.maxAttempts} fixes; not asking again until it is green`
    $.ui.log(why)
    $.ui.toast(why)
  }
}

async function poll($: EngineInterface, config: Config) {
  if (isPolling) return
  isPolling = true
  try {
    // One PR at a time, in order: a handful of gh calls, never a burst.
    for (const entry of await read($, watched)) {
      const status = await fetchStatus($, entry.url)
      // what the list holds now: a fix asked for meanwhile is kept
      const current = (await read($, watched)).find(w => w.url === entry.url)
      if (!current) continue
      if (typeof status === 'string') {
        await update($, watched, list => list.map(w => (w.url === entry.url ? { ...w, error: status } : w)))
        continue
      }
      await apply($, config, current, status)
    }
  } finally {
    isPolling = false
  }
}

function describe(entry: Watched): string {
  return `${label(entry).text}  ${entry.repo}: ${entry.title}`
}

async function listText($: EngineInterface): Promise<string> {
  const list = await read($, watched)
  if (list.length === 0) return 'No PRs watched. /pr-watch watches the current branch\'s PR; /pr-watch <number|url> another.'

  return ['Watching:', ...list.map(w => `  ${describe(w)}`)].join('\n')
}

// The actions /pr-watch and the panel share; each resolves its reply text.

// Starts watching a PR (a number, a URL, or empty for this branch's PR).
async function watchTarget($: EngineInterface, config: Config, target: string): Promise<string> {
  const status = await fetchStatus($, target)
  if (typeof status === 'string') return `Couldn't read ${target || "this branch's PR"} with gh: ${status}`
  if (status.state !== 'OPEN') return `#${status.number} is ${status.state.toLowerCase()}; nothing to watch.`
  const existing = (await read($, watched)).find(w => w.url === status.url)
  const entry = existing ?? newWatched(status)
  if (!existing) await update($, watched, list => [...list, { ...entry, status }])
  // Acts on what it sees now, so a PR already failing is fixed right away;
  // from a timer, since a command or press handler can't submit a prompt (it
  // would wait on the turn the handler holds).
  $.clock.after(0, () => void apply($, config, entry, status))

  return `${existing ? 'Already watching' : 'Watching'} ${describe({ ...entry, status })}\nChecks every ${Math.round(config.intervalMs / 1000)} s; /pr-watch stop ${status.number} ends it.`
}

// Stops watching `target`: 'all', a number or a URL.
async function unwatchTarget($: EngineInterface, target: string): Promise<string> {
  const before = await read($, watched)
  const kept = target === 'all' ? [] : before.filter(w => !matches(w, target))
  await update($, watched, () => kept)
  const gone = before.length - kept.length
  if (gone === 0) return `Not watching ${target}.`

  return `Stopped watching ${gone === 1 ? 'one PR' : `${gone} PRs`}.`
}

async function checkNow($: EngineInterface, config: Config): Promise<string> {
  await poll($, config)

  return listText($)
}

export const register: Register = (on, options) => {
  const {
    intervalSeconds = 90,
    allowPush = true,
    fixCi = true,
    fixConflicts = true,
    maxAttempts = 3,
  } = options as Options
  const config: Config = {
    intervalMs: Math.max(30, intervalSeconds) * 1000,
    allowPush,
    fixCi,
    fixConflicts,
    maxAttempts: Math.max(1, Math.round(maxAttempts)),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-watch',
      description: 'Watch a PR: fix failing CI and merge conflicts in this session',
      argumentHint: '[number | url] | stop [number | all] | list | check',
    })
    timer?.cancel()
    timer = $.clock.every(config.intervalMs, () => void poll($, config))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined

    return next(e)
  })

  on('command.run', { command: 'pr-watch' }, async ($, e) => {
    // A throwing hook is skipped and the command then says nothing useful: say why.
    try {
      const parsed = parseArgs(e.args)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'list') return { text: await listText($) }
      if (parsed.kind === 'check') return { text: await checkNow($, config) }
      if (parsed.kind === 'unwatch') return { text: await unwatchTarget($, parsed.target) }
      if (parsed.kind === 'panel') return { text: 'The panel arrives in the next step.' }

      return { text: await watchTarget($, config, parsed.target) }
    } catch (error) {
      return { text: `pr-watch failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  buildPrompt,
  decide,
  FIELDS,
  label,
  matches,
  newWatched,
  parseArgs,
  parseInterval,
  readStatus,
  summary,
  USAGE,
} from './watch'
import type { PrStatus, Rules, Watched } from './watch'
import { refusal } from './fence'

const watched = atom({ plugin: 'pr-watch', key: 'watched' } as const, [] as Watched[])
const isOpen = atom({ plugin: 'pr-watch', key: 'isOpen' } as const, false)
const notice = atom({ plugin: 'pr-watch', key: 'notice' } as const, '')
// Kept in state, not a module variable, so a reload mid-turn keeps the fence up.
const fence = atom({ plugin: 'pr-watch', key: 'fence' } as const, null as { branch: string; number: number } | null)

// The first line of every prompt pr-watch submits: its turn opens with it.
const PROMPT_HEAD = /^pr-watch: PR #(\d+) in \S+ needs a fix\.\n\S+\nBranch `([^`]+)`/

const PANE = 'pr-watch'
const TITLE = 'PR watch'

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
  const { next, problems, isGivingUp, isDone, reason } = decide(entry, status, config, await $.clock.now())
  if (isDone) {
    await update($, watched, list => list.filter(w => w.url !== entry.url))
    const why = `pr-watch: #${entry.number} is ${reason}; no longer watched`
    $.ui.toast(why)
    // In the panel, in place of the last reply (say "Watching #12 …", which
    // would otherwise stay up with its row gone).
    await update($, notice, () => `#${entry.number} is ${reason}; no longer watched.`)
    if (status.state === 'OPEN') $.ui.log(why)

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
// `isLive`: the reply stands in the panel above the PR's own row, which keeps
// updating; a status there would go stale beside it, so it names the PR alone.
async function watchTarget($: EngineInterface, config: Config, target: string, isLive = false): Promise<string> {
  const status = await fetchStatus($, target)
  if (typeof status === 'string') return `Couldn't read ${target || "this branch's PR"} with gh: ${status}`
  if (status.state !== 'OPEN') return `#${status.number} is ${status.state.toLowerCase()}; nothing to watch.`
  // Added inside the update, so two watches of one PR in flight together (a
  // double press, the panel and /pr-watch) add one row.
  let isAdded = false
  await update($, watched, list => {
    if (list.some(w => w.url === status.url)) return list
    isAdded = true

    return [...list, newWatched(status)]
  })
  // The watch that added it acts on what it sees now, so a PR already failing
  // is fixed right away; from a timer, since a command or press handler can't
  // submit a prompt (it would wait on the turn the handler holds). A PR
  // already watched is left to the polls: asking here too could ask twice.
  if (isAdded) {
    $.clock.after(0, async () => {
      const current = (await read($, watched)).find(w => w.url === status.url)
      if (current) await apply($, config, current, status)
    })
  }
  const shown = (await read($, watched)).find(w => w.url === status.url) ?? newWatched(status)

  const what = isLive ? `#${status.number} ${status.repo}: ${status.title}` : describe({ ...shown, status })

  return `${isAdded ? 'Watching' : 'Already watching'} ${what}\nChecks every ${Math.round(config.intervalMs / 1000)} s; /pr-watch stop ${status.number} ends it.`
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

// The panel's Stop: the PR with exactly this URL.
async function unwatchUrl($: EngineInterface, entry: Watched): Promise<string> {
  await update($, watched, list => list.filter(w => w.url !== entry.url))

  return `Stopped watching #${entry.number}.`
}

async function checkNow($: EngineInterface, config: Config): Promise<string> {
  await poll($, config)

  return listText($)
}

// Opens the panel, or closes it if it is up; shared by /pr-watch panel and the footer button.
async function toggle($: EngineInterface): Promise<'opened' | 'closed'> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    await update($, isOpen, () => false)

    return 'closed'
  }
  await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => true)

  return 'opened'
}

const every = (seconds: number) => (seconds % 60 ? `${seconds} s` : `${seconds / 60} min`)

// Writes one of this plugin's options as /config would, which reloads the plugin
// with it. Resolves '' once saved, else why not (the change then holds for this session).
async function saveOption($: EngineInterface, field: keyof Options, value: number | boolean): Promise<string> {
  try {
    const { deny } = await $.config.set({ key: `${$.plugin.name}.${field}`, value })

    return deny ?? ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const cut = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

export const register: Register = (on, options) => {
  const {
    intervalSeconds = 90,
    allowPush = true,
    fixCi = true,
    fixConflicts = true,
    maxAttempts = 3,
  } = options as Options
  const config: Config = {
    intervalMs: Math.min(3600, Math.max(30, intervalSeconds)) * 1000,
    allowPush,
    fixCi,
    fixConflicts,
    maxAttempts: Math.max(1, Math.round(maxAttempts)),
  }

  on('session.start', async ($, e, next) => {
    // Terminal (TUI) only: in the desktop app and other surfaces the mod stays idle.
    if (e.surface !== 'terminal') return next(e)
    await $.command.register({
      name: 'pr-watch',
      description: 'Watch a PR: fix failing CI and merge conflicts in this session',
      argumentHint: '[number | url] | stop [number | all] | list | check | panel',
    })
    // A pane kept up across a reload is still the engine's; match the label to it.
    const isUp = await $.ui
      .panes()
      .then(panes => panes.some(pane => pane.id === PANE))
      .catch(() => false)
    await update($, isOpen, () => isUp)
    timer?.cancel()
    timer = $.clock.every(config.intervalMs, () => void poll($, config))

    return next(e)
  })

  // A turn that a pr-watch prompt opens is fenced until it ends; the user's own
  // turns are not. A subagent's turn inside it is covered by the main turn's fence.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const head = PROMPT_HEAD.exec(e.text)
      await update($, fence, () => (head ? { number: Number(head[1]), branch: head[2]! } : null))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, fence, () => null)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const up = await read($, fence)
    if (up !== null) {
      const why = refusal(e as unknown as { tool: string } & Record<string, unknown>, up)
      if (why !== null) return { deny: why }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After /clear (or a resume) the process goes on with no session.start to
    // restart the timer, and the watched PRs are still listed: keep polling.
    if (e.reason === 'clear' || e.reason === 'resume') return next(e)
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
      if (parsed.kind === 'panel') return { text: `PR watch panel ${await toggle($)}.` }

      return { text: await watchTarget($, config, parsed.target) }
    } catch (error) {
      return { text: `pr-watch failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // Keep the button's label in step however the pane opens or closes,
  // the person's own close mark included.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    const opened = await next(e)
    await update($, isOpen, () => true)

    return opened
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)

    return closed
  })

  // A button at the right of the prompt footer, after the engine's own labels:
  // what needs a look while the panel is closed; pressing it opens or closes it.
  on('ui.render', { component: 'SessionMode', surface: 'terminal' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const open = await read($, isOpen)
    const list = await read($, watched)

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button key="pr-watch-toggle" label={open ? 'Hide PRs' : summary(list)} onPress={() => toggle($)} />
      </Box>
    )
  })

  // The panel: every pr-watch action, and each watched PR with its failing checks.
  on('ui.render', { component: 'Pane', requestId: PANE, surface: 'terminal' }, async ($, e) => {
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const list = await read($, watched)
    const said = await read($, notice)
    const width = Math.max(20, e.props.bodyColumns)
    // Each action's reply shows in the panel: there is no command reply here.
    const act = async (work: () => Promise<string>) => {
      let reply: string
      try {
        reply = await work()
      } catch (error) {
        reply = `pr-watch failed: ${error instanceof Error ? error.message : String(error)}`
      }
      await update($, notice, () => reply)
    }
    // Applied at once, then saved: saving reloads the plugin with the new value.
    const setEvery = (seconds: number) =>
      act(async () => {
        config.intervalMs = seconds * 1000
        timer?.cancel()
        timer = $.clock.every(config.intervalMs, () => void poll($, config))
        const why = await saveOption($, 'intervalSeconds', seconds)

        return `Checks every ${every(seconds)}${why ? ` for this session (not saved: ${why})` : ''}.`
      })
    const togglePush = () =>
      act(async () => {
        config.allowPush = !config.allowPush
        const why = await saveOption($, 'allowPush', config.allowPush)

        return `Push fixes: ${config.allowPush ? 'on' : 'off'}${why ? ` for this session (not saved: ${why})` : ''}.`
      })
    const seconds = Math.round(config.intervalMs / 1000)
    const submitEvery = (value: string) => {
      const parsed = parseInterval(value)
      if (typeof parsed === 'string') return act(async () => parsed)
      if (parsed === seconds) return act(async () => `Checks every ${every(seconds)} already.`)

      return setEvery(parsed)
    }
    const submit = (value: string) =>
      act(async () => {
        const parsed = parseArgs(value)

        return parsed.kind === 'watch' && parsed.target ? watchTarget($, config, parsed.target, true) : USAGE
      })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="watch-branch" label="Watch this branch's PR" onPress={() => act(() => watchTarget($, config, '', true))} />
          <Button
            key="check"
            label="Check now"
            onPress={() =>
              act(async () => {
                await poll($, config)
                const n = (await read($, watched)).length

                return `Checked ${n} PR${n === 1 ? '' : 's'}.`
              })
            }
          />
        </Box>
        <Input key="target" placeholder="PR number or URL" submitLabel="watch" onSubmit={submit} />
        {/* in full, wrapped: the reason at the end of a gh error is the useful part */}
        {said !== '' && <Text dimColor>{said}</Text>}
        {list.length === 0 && <Text dimColor>No PRs watched.</Text>}
        {list.map(w => {
          const { text, tone } = label(w)
          const failing = w.status?.failing ?? []

          return (
            <Box key={w.url} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={tone === 'subtle' ? undefined : tone} dimColor={tone === 'subtle'}>
                  {text}
                </Text>
                {/* keyed and stopped by URL: two repos can each have a #12, and a
                    GitHub Enterprise URL is no target `matches` reads */}
                <Button key={`stop-${w.url}`} label="Stop" onPress={() => act(() => unwatchUrl($, w))} />
                <Link href={w.url} label="open" />
              </Box>
              <Text dimColor>{cut(`${w.repo}: ${w.title}`, width)}</Text>
              {failing.map(check =>
                check.url ? (
                  <Link key={check.url} href={check.url} label={cut(`  ${check.name}`, width)} />
                ) : (
                  <Text dimColor>{cut(`  ${check.name}`, width)}</Text>
                ),
              )}
            </Box>
          )
        })}
        <Input
          key="every"
          label="Check every (s)"
          value={String(seconds)}
          submitLabel="set"
          onSubmit={submitEvery}
        />
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Push fixes</Text>
          <Button key="push" label={config.allowPush ? 'on' : 'off'} onPress={togglePush} />
        </Box>
      </Box>
    )
  })
}

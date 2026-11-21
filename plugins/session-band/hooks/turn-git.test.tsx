import { expect, test } from 'claude-code/testing'

const BAND = (isWorking: boolean, bodyColumns = 120) =>
  ({
    plugin: 'session-band',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as const

const RUN = (args: string) =>
  ({ command: 'session_data', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

const NOW = Date.parse('2026-11-20T10:00:00Z')

const seed = (extra: Record<string, unknown>) =>
  ({
    stats: { turn: 4, speed: 80, turnCost: 0.12, total: 1.5, context: 40, costAtStart: 1.38 },
    cache: { expiresAt: null, secondsLeft: null },
    isHidden: false,
    ...extra,
  }) as Record<string, unknown>

test('a running turn shows its elapsed minutes; an idle band shows the last turn\'s', async ($, on) => {
  const state = seed({ turnClock: { startedAt: NOW - 83_000, seconds: 60 } })
  on('state.get', (_, e) => (e.key in state ? { value: { value: state[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

  for (const columns of [120, 40]) {
    const working = await $.ui.mount(BAND(true, columns))
    expect((await working.find({ type: 'Text', text: '1m' }))?.text).toBe('1m')
    await working.unmount()
  }

  state.turnClock = { startedAt: null, seconds: 7 * 60 + 40 }
  const idle = await $.ui.mount(BAND(false))
  expect((await idle.find({ type: 'Text', text: '7m' }))?.text).toBe('7m')
  await idle.unmount()

  // Before the first turn there is nothing to show.
  state.turnClock = { startedAt: null, seconds: 0 }
  const fresh = await $.ui.mount(BAND(false))
  expect(await fresh.find({ type: 'Text', text: /^(<1m|\d+m)$/ })).toBe(undefined)
  await fresh.unmount()
})

test('the band shows the git branch, marked when dirty, and drops it when narrow', async ($, on) => {
  const state = seed({ git: { branch: 'feature/band', isDirty: true } })
  on('state.get', (_, e) => (e.key in state ? { value: { value: state[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

  const wide = await $.ui.mount(BAND(false, 120))
  expect((await wide.find({ type: 'Text', text: 'feature/band*' }))?.text).toBe('feature/band*')
  await wide.unmount()

  const narrow = await $.ui.mount(BAND(false, 70))
  expect(await narrow.find({ type: 'Text', text: /feature/ })).toBe(undefined)
  await narrow.unmount()
})

test('session start reads the branch and dirty state from git status', async ($, on) => {
  const runs: string[][] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'session_data' } }))
  // A limits reading lets the band draw before the session's first turn.
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-11-20T12:00:00Z' }],
    },
  }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return {
      value: {
        exitCode: 0,
        stdout: '# branch.oid abc1234def\n# branch.head main\n1 .M N... 100644 100644 100644 a b hooks/register.tsx\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(runs[0]?.slice(0, 5)).toEqual(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status'])

  const ui = await $.ui.mount(BAND(false))
  expect((await ui.find({ type: 'Text', text: 'main*' }))?.text).toBe('main*')
  await ui.unmount()

  // Hidden, the band reads no git status; shown again, it reads it at once.
  const before = runs.length
  await $.command.run(RUN(''))
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(runs.length).toBe(before)
  await $.command.run(RUN(''))
  expect(runs.length).toBe(before + 1)
})

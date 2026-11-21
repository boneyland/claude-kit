import { expect, test } from 'claude-code/testing'

const RUN = (args: string) =>
  ({ command: 'turn-gauge', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const NOW = Date.parse('2026-11-20T10:00:00Z')

// Every warning dismissed, as the buttons leave the state.
const dismissed = () =>
  ({
    stats: { turn: 4, speed: 80, turnCost: 0.12, total: 1.5, context: 40, costAtStart: 1.38 },
    cache: { expiresAt: null, secondsLeft: null },
    isHidden: false,
    spend: { dismissedAt: 90_000, context: 90_000 },
    tokens: { dismissedTurn: 4 },
    pace: { windows: {}, prev: {}, profile: null, dismissed: 'seven_day:123' },
  }) as Record<string, unknown>

const engine = (on: On, state: Record<string, unknown>) => {
  let version = 1
  on('state.get', (_, e) => ({ value: { value: state[e.key], version: state[e.key] === undefined ? 0 : version } }))
  on('state.set', (_, e) => ((state[e.key] = e.value), { value: { isSet: true, version: ++version } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'turn-gauge' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
}

const brought = (state: Record<string, unknown>) => [
  (state.spend as { dismissedAt: number | null }).dismissedAt,
  (state.tokens as { dismissedTurn: number }).dismissedTurn,
  (state.pace as { dismissed: string }).dismissed,
]

test('a reload brings every dismissed warning back', async ($, on) => {
  const state = dismissed()
  engine(on, state)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(brought(state)).toEqual([null, -1, ''])
})

test('hiding the band and showing it again brings the dismissed warnings back', async ($, on) => {
  const state = dismissed()
  engine(on, state)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  Object.assign(state, dismissed())

  await $.command.run(RUN(''))
  expect(state.isHidden).toBe(true)
  // Hidden: the dismissals stand until it shows again.
  expect(brought(state)).toEqual([90_000, 4, 'seven_day:123'])

  await $.command.run(RUN(''))
  expect(state.isHidden).toBe(false)
  expect(brought(state)).toEqual([null, -1, ''])
})

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://example.com/live'
const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const

// Each player prints one status line, then runs until `end` gives its exit.
function engine(on: On, store: Record<string, unknown> = {}) {
  const world = {
    spawned: 0,
    toasts: [] as string[],
    end: (_code: number | null, _signal: string | null = null) => undefined as void,
  }
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', (_$, e) => (world.toasts.push(e.text), { value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'null', stderr: '' } }) as never)
  on('process.spawn', async function* () {
    world.spawned += 1
    yield { stream: 'stdout', text: 'NP\tLofi radio\t\t\tno\t\t\tEND' } as never
    const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      world.end = (code, signal = null) => resolve({ code, signal })
    })
    return { value: exit } as never
  })
  return world
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never
type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const footer = async ($: Api) => {
  const ui = await $.ui.mount(FOOTER)
  const label = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}

test('a stream that drops starts again after a wait', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(world.spawned).toBe(1)

  world.end(2)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ reconnecting in 2 s…')
  await clock.advance(2000)
  expect(world.spawned).toBe(2)
  expect(await footer($)).toBe('♪ Lofi radio')

  world.end(null, 'SIGTERM')
  await clock.advance(20_000)
  expect(world.spawned).toBe(2)
})

test('three drops in a row and it gives up', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  for (const wait of [2000, 5000, 15_000]) {
    world.end(2)
    await clock.advance(wait + 10)
  }
  expect(world.spawned).toBe(4)
  world.end(2)
  await clock.advance(30_000)
  expect(world.spawned).toBe(4)
  expect(world.toasts.at(-1)).toBe('stream stopped; gave up after 3 tries')
})

test('a minute of steady playing starts the tries over', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end(2)
  await clock.advance(2010)
  world.end(2)
  await clock.advance(5010)
  expect(world.spawned).toBe(3)
  // Playing steadily for a minute, then a drop: the first, short wait again.
  await clock.advance(61_000)
  world.end(2)
  await clock.advance(2010)
  expect(world.spawned).toBe(4)
  world.end(null, 'SIGTERM')
  await clock.advance(10)
})

test('stopping while it waits, or a playlist finishing with repeat off, does not reconnect', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { repeat: 'off' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end(0)
  await clock.advance(20_000)
  expect(world.spawned).toBe(1)

  await $.command.run({ command: 'stream', args: 'repeat all' } as never)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end(2)
  await clock.advance(10)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(20_000)
  expect(world.spawned).toBe(2)
  expect(await footer($)).toBe('▶ Play radio')
})

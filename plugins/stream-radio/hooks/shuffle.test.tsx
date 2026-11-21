import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SONGS = ['A', 'B', 'C']

// mpv with a three-song playlist that shuffle reverses and unshuffle restores.
function engine(on: On, store: Record<string, unknown>) {
  const world = { sent: [] as unknown[][], spawned: [] as string[][], order: [...SONGS], release: () => undefined as void }
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'python3') return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const command = JSON.parse(argv[5]!) as unknown[]
    world.sent.push(command)
    if (command[0] === 'playlist-shuffle') world.order = [...SONGS].reverse()
    if (command[0] === 'playlist-unshuffle') world.order = [...SONGS]
    const data =
      command[1] === 'playlist'
        ? world.order.map(title => ({ filename: `https://example.com/${title}`, title, ...(title === 'A' ? { current: true } : {}) }))
        : command[1] === 'playlist-count'
          ? SONGS.length
          : null
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '' } } as never
  })
  on('process.spawn', async function* (_$, e) {
    world.spawned.push([...e.argv])
    yield { stream: 'stdout', text: 'NP\tA\t\t\tno\t3\t\tEND' } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  return world
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never
const labelOf = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], key: string) => {
  const pane = await $.ui.mount(PANE)
  const label = (await pane.find({ type: 'Button', key }))?.props.label as string | undefined
  await pane.unmount()
  return label
}

test('shuffle reorders the playlist and the panel shows the new order; again puts it back', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, {})
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')

  let pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-shuffle'])
  expect(await labelOf($, 'shuffle')).toBe('🔀 Shuffle: on')
  expect(await labelOf($, 'item-0')).toBe('  1. C')
  expect(await labelOf($, 'item-2')).toBe('▶ 3. A')

  pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-unshuffle'])
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('repeat cycles all, one, off, reaches the player, and is remembered', async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  const world = engine(on, store)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--loop-playlist=inf')
  expect(await labelOf($, 'repeat')).toBe('🔁 Repeat: all')

  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'repeat' })
  await pane.unmount()
  expect(await labelOf($, 'repeat')).toBe('🔂 Repeat: one')
  expect(world.sent).toContainEqual(['set_property', 'loop-file', 'inf'])

  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'repeat off' } as never))).toContain('Repeat off')
  expect(world.sent).toContainEqual(['set_property', 'loop-playlist', 'no'])
  expect(store.repeat).toBe('off')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'repeat sometimes' } as never))).toContain('Usage: /stream repeat')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a new session plays with the saved repeat', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { repeat: 'one' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--loop-file=inf')
  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

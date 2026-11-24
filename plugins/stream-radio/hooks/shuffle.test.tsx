import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SONGS = ['A', 'B', 'C']

// mpv with a three-song playlist that shuffle reverses and unshuffle restores.
function engine(on: On, saved?: Record<string, unknown>) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  let order = [...SONGS]
  const world = fakeMpv(on, {
    title: 'A',
    props: { 'time-pos': 3, duration: true },
    saved,
    playlist: () => order.map(title => ({ filename: `https://example.com/${title}`, title })),
    onCommand: command => {
      // mpv keeps the song playing where it is: A moves, and the position with it.
      if (command[0] === 'playlist-shuffle') order = [...SONGS].reverse()
      if (command[0] === 'playlist-unshuffle') order = [...SONGS]
      if (command[0] === 'playlist-shuffle' || command[0] === 'playlist-unshuffle') {
        world.set('playlist-pos', order.indexOf('A'))
        return { data: null }
      }
      return undefined
    },
  })
  // Another session's shuffle: the list reversed, marked on the player.
  const shuffledElsewhere = () => {
    order = [...SONGS].reverse()
    world.set('playlist-pos', order.indexOf('A'))
    world.set('user-data/stream-radio/shuffled', true)
  }
  return Object.assign(world, { spawned: world.launches, shuffledElsewhere })
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
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')

  let pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-shuffle'])
  // Marked on the player, for the other sessions to read the list again.
  expect(world.sent).toContainEqual(['set_property', 'user-data/stream-radio/shuffled', true])
  expect(await labelOf($, 'shuffle')).toBe('🔀 Shuffle: on (s)')
  expect(await labelOf($, 'item-0')).toBe('  1. C')
  expect(await labelOf($, 'item-2')).toBe('▶ 3. A')

  pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-unshuffle'])
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a shuffle made in another session shows here', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  const before = world.sent.filter(c => c[1] === 'playlist').length

  world.shuffledElsewhere()
  await clock.advance(10)
  // Read whole again: its order changed.
  expect(world.sent.filter(c => c[1] === 'playlist').length).toBe(before + 1)
  expect(await labelOf($, 'shuffle')).toBe('🔀 Shuffle: on (s)')
  expect(await labelOf($, 'item-0')).toBe('  1. C')
  expect(await labelOf($, 'item-2')).toBe('▶ 3. A')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('repeat cycles all, one, off, reaches the player, and is remembered', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--loop-playlist=inf')
  expect(await labelOf($, 'repeat')).toBe('🔁 Repeat: all (r)')

  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'repeat' })
  await pane.unmount()
  expect(await labelOf($, 'repeat')).toBe('🔂 Repeat: one (r)')
  expect(world.sent).toContainEqual(['set_property', 'loop-file', 'inf'])

  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'repeat off' } as never))).toContain('Repeat off')
  expect(world.sent).toContainEqual(['set_property', 'loop-playlist', 'no'])
  expect(world.saved()?.repeat).toBe('off')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'repeat sometimes' } as never))).toContain('Usage: /stream repeat')

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
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

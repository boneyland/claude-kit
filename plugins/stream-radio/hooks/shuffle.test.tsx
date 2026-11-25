import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, QUEUE_JSON } from './fake-mpv'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SONGS = ['A', 'B', 'C']
const urlOf = (title: string) => `https://example.com/${title}`
// The queue the songs were played from: A, B, C, as an earlier play left it.
const QUEUE = JSON.stringify({
  version: 1,
  rev: 1,
  entries: SONGS.map((title, i) => ({ id: `1.${i}`, path: urlOf(title), title })),
  arrangement: { kind: 'none' },
  root: '',
  source: 'https://example.com/list',
})
// The queue's titles in the order shown and played.
const storedTitles = (text: string): string[] => {
  const q = JSON.parse(text) as { entries: { title: string }[]; arrangement: { kind: string; order?: number[] } }
  return (q.arrangement.order ?? q.entries.map((_, i) => i)).map(i => q.entries[i]!.title)
}

// mpv with a three-song playlist that moves its entries as asked, the song
// playing (A) playing on wherever it goes.
function engine(on: On, saved?: Record<string, unknown>) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  let order = [...SONGS]
  const world = fakeMpv(on, {
    title: 'A',
    props: { 'time-pos': 3, duration: true },
    saved,
    playlist: () => order.map(title => ({ filename: urlOf(title), title })),
    onCommand: command => {
      if (command[0] !== 'playlist-move') return undefined
      // mpv's playlist-move j i: entry j to before entry i
      const [j, i] = [command[1] as number, command[2] as number]
      const [moved] = order.splice(j, 1)
      order.splice(j < i ? i - 1 : i, 0, moved!)
      world.set('playlist-pos', order.indexOf('A'))
      return { data: null }
    },
  })
  world.files[QUEUE_JSON] = QUEUE
  // Another session's shuffle: the queue file and mpv's list reversed, and the
  // player marked edited.
  const shuffledElsewhere = () => {
    const q = JSON.parse(QUEUE) as Record<string, unknown>
    world.files[QUEUE_JSON] = JSON.stringify({ ...q, rev: 2, arrangement: { kind: 'shuffle', order: [2, 1, 0] } })
    order = [...SONGS].reverse()
    world.set('playlist-pos', order.indexOf('A'))
    world.set('user-data/stream-radio/edited', 1)
  }
  return Object.assign(world, { spawned: world.launches, shuffledElsewhere, order: () => order })
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never
const labelOf = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], key: string) => {
  const pane = await $.ui.mount(PANE)
  const label = (await pane.find({ type: 'Button', key }))?.props.label as string | undefined
  await pane.unmount()
  return label
}

test('shuffle puts the playing song first and the rest in random order, in the file and in mpv; again puts it back', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'last' } as never)
  await clock.advance(10)
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')

  let pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  const shuffled = storedTitles(world.files[QUEUE_JSON]!)
  expect(JSON.parse(world.files[QUEUE_JSON]!).arrangement.kind).toBe('shuffle')
  expect(shuffled[0]).toBe('A')
  // mpv's list is the file's played order; nothing restarts the song playing
  expect(world.order()).toEqual(shuffled)
  expect(world.sent.some(c => c[0] === 'playlist-shuffle' || c[0] === 'playlist-play-index')).toBe(false)
  expect(world.sent.some(c => c[1] === 'user-data/stream-radio/shuffled')).toBe(false)
  expect(world.sent).toContainEqual(['set_property', 'user-data/stream-radio/rev', 2])
  expect(await labelOf($, 'shuffle')).toBe('🔀 Shuffle: on (s)')
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')
  expect(await labelOf($, 'item-1')).toBe(`  2. ${shuffled[1]}`)

  pane = await $.ui.mount(PANE)
  await pane.press({ key: 'shuffle' })
  await pane.unmount()
  expect(storedTitles(world.files[QUEUE_JSON]!)).toEqual(SONGS)
  expect(world.order()).toEqual(SONGS)
  expect(world.sent.some(c => c[0] === 'playlist-unshuffle')).toBe(false)
  expect(await labelOf($, 'shuffle')).toBe('🔀 Shuffle: off (s)')
  expect(await labelOf($, 'item-0')).toBe('▶ 1. A')
  expect(await labelOf($, 'item-1')).toBe('  2. B')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a shuffle made in another session shows here', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'last' } as never)
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

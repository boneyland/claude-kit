import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, PLACE, QUEUE_JSON } from './fake-mpv'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const

const SONGS = ['Santa Claus Is Comin\' To Town', 'Santa Baby', 'Winter Wonderland']

// The shared player beneath the plugin, with a three-song playlist; the fake
// records every command sent to it.
function engine(on: On) {
  const panes = { open: [] as string[] }
  on('ui.panes', () => ({ value: panes.open.map(id => ({ id, title: 'Radio', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', (_$, e) => ((panes.open = [e.id]), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((panes.open = []), { value: undefined }) as never)
  const world = fakeMpv(on, {
    title: SONGS[0],
    props: { 'time-pos': 42, duration: true },
    playlist: SONGS.map((title, i) => ({ filename: `https://example.com/${i}`, title, ...(i === 0 ? { current: true } : {}) })),
  })
  return Object.defineProperty(world, 'panes', { get: () => panes.open }) as typeof world & { readonly panes: string[] }
}

test('the footer opens the panel, which lists the playlist and picks, skips and pauses', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never).catch(() => undefined)
  // mpv expands the URL into its three songs; they are written to the queue
  // once its list has settled
  await clock.advance(1100)

  // The footer button opens the panel; pressed again, closes it.
  const footer = await $.ui.mount(FOOTER)
  await footer.press({ key: 'stream-radio' })
  expect(world.panes).toEqual(['stream-radio'])
  await footer.unmount()

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: SONGS[0] }))?.text).toBe(SONGS[0])
  // What plays is the last URL: no button to play it again.
  expect(await pane.find({ type: 'Button', key: 'play-last' })).toBe(undefined)
  // No time in the panel: the footer has it, and it would redraw the panel each second.
  expect((await pane.find({ type: 'Text', text: /1 of 3/ }))?.text).toBe('1 of 3')
  expect(await pane.find({ type: 'Text', text: /0:42/ })).toBe(undefined)
  expect((await pane.find({ type: 'Button', key: 'item-0' }))?.props.label).toBe(`▶ 1. ${SONGS[0]}`)
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe(`  3. ${SONGS[2]}`)

  await pane.press({ key: 'item-2' })
  expect(world.sent).toContainEqual(['playlist-play-index', 2])
  expect(world.sent).toContainEqual(['set_property', 'pause', false])
  await pane.press({ key: 'next' })
  expect(world.sent).toContainEqual(['playlist-next'])
  await pane.press({ key: 'prev' })
  expect(world.sent).toContainEqual(['playlist-prev'])
  await pane.press({ key: 'pause' })
  expect(world.sent).toContainEqual(['set_property', 'pause', true])
  await pane.unmount()

  const again = await $.ui.mount(FOOTER)
  await again.press({ key: 'stream-radio' })
  expect(world.panes).toEqual([])
  await again.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never).catch(() => undefined)
  await clock.advance(1000)
})

test('/stream next, prev and panel reach the player and the panel', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never).catch(() => undefined)
  await clock.advance(10)

  await $.command.run({ command: 'stream', args: 'next' } as never)
  expect(world.sent).toContainEqual(['playlist-next'])
  await $.command.run({ command: 'stream', args: 'prev' } as never)
  expect(world.sent).toContainEqual(['playlist-prev'])
  await $.command.run({ command: 'stream', args: 'panel' } as never)
  expect(world.panes).toEqual(['stream-radio'])

  await $.command.run({ command: 'stream', args: 'stop' } as never).catch(() => undefined)
  await clock.advance(1000)
})

test('every control button has a key, shown in its label, for when the panel has the keyboard', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never).catch(() => undefined)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  const keys: [string, string, string][] = [
    ['prev', 'p', '⏮ Prev (p)'],
    ['pause', 'k', '⏸ Pause (k)'],
    ['next', 'n', '(n) Next ⏭'],
    ['stop', 'x', '⏹ Stop (x)'],
    ['vol-down', '9', '🔉 − (9)'],
    ['vol-up', '0', '(0) 🔊 +'],
    ['shuffle', 's', '🔀 Shuffle: off (s)'],
    ['repeat', 'r', '🔁 Repeat: all (r)'],
  ]
  for (const [key, hotkey, label] of keys) {
    const button = await pane.find({ type: 'Button', key })
    expect([key, button?.props.hotkey, button?.props.label]).toEqual([key, hotkey, label])
  }
  await pane.unmount()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('with nothing playing the panel offers what to play', async ($, on) => {
  mock.clock(on)
  engine(on)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Nothing playing.' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'prev' })).toBe(undefined)
  expect(await pane.find({ type: 'Input', key: 'url' })).toBeTruthy()
  await pane.unmount()
})

// A queue of three songs as an earlier session left it, nothing playing.
const STORED = JSON.stringify({
  version: 1,
  rev: 1,
  entries: SONGS.map((title, i) => ({ id: `1.${i}`, path: `https://example.com/${i}`, title })),
  arrangement: { kind: 'none' },
  root: '',
  source: 'https://example.com/list',
})
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

test('panel keeps the list after stop and plays a clicked song from its start', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  const world = engine(on)
  world.files[QUEUE_JSON] = STORED
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.1', seconds: 80 })
  await $.session.start(START)
  await $.command.run({ command: 'stream', args: 'last' } as never)
  await clock.advance(10)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(1000)

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: 'Nothing playing.' }))?.text).toBe('Nothing playing.')
  expect((await pane.find({ type: 'Button', key: 'item-0' }))?.props.label).toContain(SONGS[0])
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toContain(SONGS[2])

  world.sent = []
  await pane.press({ key: 'item-2' })
  await clock.advance(10)
  await clock.advance(10)
  expect(world.launches.at(-1)).toContain('--playlist-start=2')
  expect(world.launches.at(-1)!.some(a => a.startsWith('--start'))).toBe(false)
  expect(world.sent.some(c => c[0] === 'seek')).toBe(false)
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(1000)
})

test('shuffle works while stopped', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  const world = engine(on)
  world.files[QUEUE_JSON] = STORED
  await $.session.start(START)
  await clock.advance(10)
  const reply = await $.command.run({ command: 'stream', args: 'shuffle' } as never)
  expect(JSON.stringify(reply)).not.toContain('Nothing is playing')
  expect(JSON.parse(world.files[QUEUE_JSON]!).arrangement.kind).toBe('shuffle')
})

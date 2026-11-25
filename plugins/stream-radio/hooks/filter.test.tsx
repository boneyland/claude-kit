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
const PLAYLIST = [
  { filename: '/m/Album/01 Intro.flac', title: 'Intro', current: true },
  { filename: '/m/Album/Disc 2/01 Snow.flac', title: 'Snow' },
  { filename: '/m/Album/Disc 2/02 Rain.flac', title: 'Rain' },
  { filename: '/m/Album/Live/01 Snowfall.flac', title: 'Snowfall' },
]

// The queue of the folder's songs, as an earlier play left it.
function engine(on: On) {
  const world = fakeMpv(on, { title: 'Intro', props: { 'time-pos': 3, duration: true }, playlist: PLAYLIST, exists: () => true })
  const entries = PLAYLIST.map((e, i) => ({ id: `1.${i}`, path: e.filename, title: e.title }))
  world.files[QUEUE_JSON] = JSON.stringify({ version: 1, rev: 1, entries, arrangement: { kind: 'none' }, root: '/m/Album', source: '/m/Album' })
  return world
}

test('typing in the filter narrows the list; Enter plays the first match', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'last' } as never)
  await clock.advance(10)

  let pane = await $.ui.mount(PANE)
  await pane.input({ key: 'filter', text: 'snow', kind: 'change' })
  await pane.unmount()

  pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /match/ }))?.text).toBe('2 of 4 songs match')
  expect((await pane.find({ type: 'Button', key: 'item-1' }))?.props.label).toBe('  2. Snow · Disc 2')
  expect((await pane.find({ type: 'Button', key: 'item-3' }))?.props.label).toBe('  4. Snowfall · Live')
  expect(await pane.find({ type: 'Button', key: 'item-2' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'folder-/m/Album/Disc 2' })).toBe(undefined)
  await pane.input({ key: 'filter', text: 'snow' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-play-index', 1])

  // Cleared, the tree is back.
  pane = await $.ui.mount(PANE)
  await pane.input({ key: 'filter', text: '', kind: 'change' })
  await pane.unmount()
  pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'folder-/m/Album/Disc 2' })).toBeTruthy()
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

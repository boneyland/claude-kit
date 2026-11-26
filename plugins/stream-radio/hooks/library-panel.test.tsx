// The panel's library: the ★ button, Add to playlist's checklist, and the
// picker of the queue, Favourites, Recently played and each saved playlist.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { DATA, fakeMpv, PLACE, QUEUE_JSON } from './fake-mpv'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const LIB = '/home/me/.local/share/stream-radio/playlists'
const FAV = `${LIB}/★ Favourites.m3u`
const ROAD = `${LIB}/Road trip.m3u`
const HISTORY = `${DATA}/history.jsonl`
const A = '/home/me/Music/a.mp3'
const B = '/home/me/Music/b.mp3'

const queue = (...paths: string[]) =>
  JSON.stringify({ version: 1, rev: 1, entries: paths.map((path, i) => ({ id: `1.${i}`, path })), arrangement: { kind: 'none' }, root: '', source: '' })

// A stopped player whose queue is kept: a and b, b the current song. Files
// the test names in `times` answer that mtime; other playlists 1.
function engine(on: On, playlists: string[] = ['Road trip']) {
  const panes = { open: [] as string[] }
  const times: Record<string, number> = {}
  const stats: string[] = []
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: panes.open.map(id => ({ id, title: 'Radio', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', (_$, e) => ((panes.open = [e.id]), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((panes.open = []), { value: undefined }) as never)
  const world = fakeMpv(on, {
    title: 'Song',
    list: path => (path === LIB ? playlists.map(name => ({ name: `${name}.m3u`, kind: 'file' })) : undefined) as never,
    stat: path => (path === LIB ? { kind: 'dir', mtimeMs: times[LIB] ?? 0 } : undefined) as never,
    mtime: path => (stats.push(path), times[path] ?? (path.startsWith(`${LIB}/`) ? 1 : undefined)),
  })
  return Object.assign(world, { times, stats, panes })
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

async function stopped($: Api, world: ReturnType<typeof engine>, clock: { advance(ms: number): Promise<void> }) {
  world.files[QUEUE_JSON] = queue(A, B)
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.1', seconds: 3 })
  await $.session.start(start)
  await clock.advance(10)
}

test('★ toggles the queue\'s song in Favourites, filled when it is one', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await stopped($, world, clock)
  const pane = await $.ui.mount(PANE)
  const fav = async () => (await pane.find({ type: 'Button', key: 'fav' }))?.props
  expect([(await fav())?.label, (await fav())?.hotkey]).toEqual(['☆ Favourite (8)', '8'])
  await pane.press({ key: 'fav' })
  expect(world.files[FAV]).toBe(`#EXTM3U\n${B}\n`)
  await clock.advance(10)
  expect((await fav())?.label).toBe('★ Favourite (8)')
  expect((await pane.find({ type: 'Text', text: 'Added to ★ Favourites.' }))).toBeTruthy()
  await pane.press({ key: 'fav' })
  expect(world.files[FAV]).not.toContain(B)
  await clock.advance(10)
  expect((await fav())?.label).toBe('☆ Favourite (8)')
  await pane.unmount()
})

test('with an empty queue ★ and Add to playlist show, and do nothing', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start(start)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'fav' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'add-to' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /Favourite.*Add to playlist/ })).toBeTruthy()
  await pane.unmount()
})

test('Add to playlist opens a checklist on the song at that time, which stays open', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[ROAD] = '#EXTM3U\n'
  await stopped($, world, clock)
  const pane = await $.ui.mount(PANE)
  const add = await pane.find({ type: 'Button', key: 'add-to' })
  expect([add?.props.label, add?.props.hotkey]).toEqual(['Add to playlist… (a)', 'a'])
  await pane.press({ key: 'add-to' })
  const label = async (name: string) => (await pane.find({ type: 'Button', key: `check-${name}` }))?.props.label
  expect(await label('★ Favourites')).toBe('  ★ Favourites')
  expect(await label('Road trip')).toBe('  Road trip')

  await pane.press({ key: 'check-Road trip' })
  expect(world.files[ROAD]).toBe(`#EXTM3U\n${B}\n`)
  expect(await label('Road trip')).toBe('✓ Road trip')
  expect(await pane.find({ type: 'Text', text: 'Added to Road trip.' })).toBeTruthy()

  // the queue moves on to a: the open checklist still acts on b
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.0', seconds: 0 })
  await pane.press({ key: 'check-★ Favourites' })
  expect(world.files[FAV]).toBe(`#EXTM3U\n${B}\n`)
  expect(await label('★ Favourites')).toBe('✓ ★ Favourites')

  // + New playlist… makes a list with the song in it
  await pane.input({ key: 'new-playlist', text: 'Late night' })
  expect(world.files[`${LIB}/Late night.m3u`]).toBe(`#EXTM3U\n${B}\n`)
  expect(await pane.find({ type: 'Text', text: 'Made the playlist "Late night".' })).toBeTruthy()

  // deleted elsewhere while open: not made again
  delete world.files[ROAD]
  await pane.press({ key: 'check-Road trip' })
  expect(world.files[ROAD]).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: 'That playlist is gone.' })).toBeTruthy()

  const close = await pane.find({ type: 'Button', key: 'check-close' })
  expect(close?.props.hotkey).toBe('c')
  await pane.press({ key: 'check-close' })
  expect(await pane.find({ type: 'Button', key: 'check-★ Favourites' })).toBe(undefined)
  await pane.unmount()
})

test('the picker shows a playlist, Favourites or Recently played; a click plays that list from the song', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[ROAD] = `#EXTM3U\n#EXTINF:-1,Xylo\n/m/x.mp3\n/m/y.mp3\n/m/z.mp3\n`
  world.files[FAV] = `#EXTM3U\n${A}\n`
  const now = Math.floor(clock.now() / 1000)
  world.files[HISTORY] = [{ at: now - 7200, path: '/m/old.mp3', title: 'Old' }, { at: now - 120, path: '/m/new.mp3', title: 'New' }].map(p => JSON.stringify(p)).join('\n') + '\n'
  await stopped($, world, clock)
  const pane = await $.ui.mount(PANE)
  const picker = await pane.find({ type: 'Select', key: 'list' })
  expect(picker?.props.value).toBe('queue')
  expect((picker?.props.options as { value: string; label?: string }[]).map(o => o.label ?? o.value)).toEqual(['Queue', '★ Favourites', 'Recently played', 'Road trip'])

  await pane.select({ key: 'list', value: 'list:Road trip' })
  await clock.advance(10)
  expect(await pane.find({ type: 'Button', key: 'item-0' })).toBe(undefined)
  expect((await pane.find({ type: 'Button', key: 'song-0' }))?.props.label).toBe('1. Xylo')
  expect((await pane.find({ type: 'Button', key: 'song-1' }))?.props.label).toBe('2. y.mp3')

  await pane.press({ key: 'song-1' })
  await clock.advance(10)
  const q = JSON.parse(world.files[QUEUE_JSON]!) as { entries: { path: string }[]; source: string }
  expect(q.entries.map(e => e.path)).toEqual(['/m/x.mp3', '/m/y.mp3', '/m/z.mp3'])
  expect(q.source).toBe(ROAD)
  expect(world.launches.at(-1)).toContain('--playlist-start=1')

  await pane.select({ key: 'list', value: 'fav' })
  await clock.advance(10)
  expect((await pane.find({ type: 'Button', key: 'song-0' }))?.props.label).toBe('1. a.mp3')

  await pane.select({ key: 'list', value: 'history' })
  await clock.advance(10)
  expect((await pane.find({ type: 'Button', key: 'song-0' }))?.props.label).toBe('1. New')
  expect(await pane.find({ type: 'Text', text: '2 min ago' })).toBeTruthy()
  await pane.unmount()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('the panel polls its lists every 2 s while open, and starts at the queue each time', async ($, on) => {
  const clock = mock.clock(on)
  const lists = ['Road trip']
  const world = engine(on, lists)
  world.files[FAV] = `#EXTM3U\n${A}\n`
  await stopped($, world, clock)
  await $.command.run({ command: 'stream', args: 'panel' } as never)
  const pane = await $.ui.mount(PANE)
  await pane.select({ key: 'list', value: 'fav' })
  await clock.advance(10)
  expect(await pane.find({ type: 'Button', key: 'song-1' })).toBe(undefined)
  expect((await pane.find({ type: 'Button', key: 'fav' }))?.props.label).toBe('☆ Favourite (8)')

  // another session favourites b
  world.files[FAV] = `#EXTM3U\n${A}\n${B}\n`
  world.times[FAV] = 5
  await clock.advance(2000)
  expect((await pane.find({ type: 'Button', key: 'song-1' }))?.props.label).toBe('2. b.mp3')
  expect((await pane.find({ type: 'Button', key: 'fav' }))?.props.label).toBe('★ Favourite (8)')

  // a playlist made elsewhere joins the picker
  lists.push('Gym')
  world.files[`${LIB}/Gym.m3u`] = '#EXTM3U\n'
  world.times[LIB] = 7
  await clock.advance(2000)
  const options = (await pane.find({ type: 'Select', key: 'list' }))?.props.options as { value: string; label?: string }[]
  expect(options.map(o => o.label ?? o.value)).toEqual(['Queue', '★ Favourites', 'Recently played', 'Gym', 'Road trip'])

  await $.command.run({ command: 'stream', args: 'panel' } as never)
  expect(world.panes.open).toEqual([])
  await pane.unmount()

  // closed: nothing is looked at
  const lookedAt = () => world.stats.filter(p => p.startsWith(LIB)).length
  const looks = lookedAt()
  await clock.advance(6000)
  expect(lookedAt()).toBe(looks)

  await $.command.run({ command: 'stream', args: 'panel' } as never)
  const again = await $.ui.mount(PANE)
  expect((await again.find({ type: 'Select', key: 'list' }))?.props.value).toBe('queue')
  await again.unmount()
  await $.command.run({ command: 'stream', args: 'panel' } as never)
})

test('the panel reads the queue only when the song or favourites changed', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await stopped($, world, clock)
  await $.command.run({ command: 'stream', args: 'panel' } as never)
  const pane = await $.ui.mount(PANE)
  await clock.advance(2000)
  await clock.advance(2000)
  const reads = () => world.reads.filter(p => p === QUEUE_JSON).length
  const before = reads()
  await clock.advance(2000)
  await clock.advance(2000)
  expect(reads()).toBeLessThanOrEqual(before)
  // the queue moves on to a: read again, and only then
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.0', seconds: 0 })
  await clock.advance(2000)
  expect(reads()).toBeGreaterThan(before)
  const after = reads()
  await clock.advance(2000)
  expect(reads()).toBe(after)
  await pane.unmount()
})

test('an open checklist shows a list edited in place within a poll', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[ROAD] = '#EXTM3U\n'
  await stopped($, world, clock)
  await $.command.run({ command: 'stream', args: 'panel' } as never)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'add-to' })
  await clock.advance(10)
  const label = async () => (await pane.find({ type: 'Button', key: 'check-Road trip' }))?.props.label
  expect(await label()).toBe('  Road trip')
  // an editor writes the file in place: its mtime moves, the folder's does not
  world.files[ROAD] = `#EXTM3U\n${B}\n`
  world.times[ROAD] = 9
  await clock.advance(2000)
  expect(await label()).toBe('✓ Road trip')
  await pane.unmount()
  await $.command.run({ command: 'stream', args: 'panel' } as never)
})

test('a long playlist draws 200 rows, then says how many more', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[ROAD] = '#EXTM3U\n' + [...Array(205).keys()].map(i => `/m/s${i}.mp3\n`).join('')
  await stopped($, world, clock)
  const pane = await $.ui.mount(PANE)
  await pane.select({ key: 'list', value: 'list:Road trip' })
  await clock.advance(10)
  expect((await pane.find({ type: 'Button', key: 'song-199' }))?.props.label).toBe('200. s199.mp3')
  expect(await pane.find({ type: 'Button', key: 'song-200' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: 'and 5 more' })).toBeTruthy()
  await pane.unmount()
})

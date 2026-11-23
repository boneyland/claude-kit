import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { type Entry, fakeMpv, type FakeOptions } from './fake-mpv'

const FILES = ['/home/me/Music/Album', '/home/me/Music/one.flac']
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: On, options: FakeOptions = {}) {
  on('env.get', () => ({ value: '/home/me' }) as never)
  on('session.cwd', () => ({ value: '/home/me/Music' }) as never)
  return fakeMpv(on, { title: 'one.flac', props: { 'time-pos': 3, duration: true }, exists: path => FILES.includes(path), ...options })
}

test('/stream plays a local folder, skipping its pictures', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  const reply = await $.command.run({ command: 'stream', args: '~/Music/Album' } as never)
  expect(JSON.stringify(reply)).toContain('Starting /home/me/Music/Album')
  await clock.advance(10)
  const argv = world.launches[0]!
  expect(argv.at(-1)).toBe('/home/me/Music/Album')
  expect(argv.at(-2)).toBe('--')
  expect(argv).toContain('--directory-filter-types=audio,video,playlist')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a relative path reads from the session folder; a missing one says so', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  const missing = await $.command.run({ command: 'stream', args: 'nope.mp3' } as never)
  expect(JSON.stringify(missing)).toContain('No such file or folder: /home/me/Music/nope.mp3')
  expect(world.launches).toEqual([])

  await $.command.run({ command: 'stream', args: 'one.flac' } as never)
  await clock.advance(10)
  expect(world.launches[0]!.at(-1)).toBe('/home/me/Music/one.flac')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a YouTube URL does not get the folder filter', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never)
  await clock.advance(10)
  expect(world.launches[0]).not.toContain('--directory-filter-types=audio,video,playlist')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('the panel marks a folder listed in a playlist file', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, {
    title: 'Intro',
    exists: () => true,
    stat: path => ({ kind: path.endsWith('Live') ? 'dir' : 'file' }),
    playlist: [{ filename: '/m/Album/01 Intro.flac', title: 'Intro', current: true }, { filename: '/m/Album/02 Song.flac' }, { filename: '/m/Album/Live' }],
  })

  // A playlist file can name a folder, which mpv opens only when it gets there.
  await $.command.run({ command: 'stream', args: '/m/mix.m3u' } as never)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'item-0' }))?.props.label).toBe('▶ 1. Intro')
  expect((await pane.find({ type: 'Button', key: 'item-1' }))?.props.label).toBe('  2. 02 Song.flac')
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe('  3. 📁 Live/')
  expect((await pane.find({ type: 'Input', key: 'url' }))?.props.submitLabel).toBe('Enter to play')
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test("subfolders fold: the current song's opens by itself, a click shuts and opens one", async ($, on) => {
  const clock = mock.clock(on)
  const playlist: Entry[] = [
    { filename: '/m/Album/01 Intro.flac', title: 'Intro' },
    { filename: '/m/Album/Disc 2/01 A.flac', title: 'A', current: true },
    { filename: '/m/Album/Disc 2/02 B.flac', title: 'B' },
    { filename: '/m/Album/Live/01 C.flac', title: 'C' },
  ]
  const world = engine(on, { title: 'A', exists: () => true, playlist })

  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)
  expect(world.launches[0]).toContain('--directory-mode=recursive')
  const label = async (key: string) => {
    const pane = await $.ui.mount(PANE)
    const text = (await pane.find({ type: 'Button', key }))?.props.label as string | undefined
    await pane.unmount()
    return text
  }

  // The current song's folder is open; the other is shut.
  expect(await label('folder-/m/Album/Disc 2')).toBe('  ▾ 📁 Disc 2/ · 2')
  expect(await label('item-1')).toBe('▶   1. A')
  expect(await label('item-2')).toBe('    2. B')
  expect(await label('folder-/m/Album/Live')).toBe('  ▸ 📁 Live/ · 1')
  expect(await label('item-3')).toBe(undefined)

  // Shut by hand, the playing folder carries the mark.
  let pane = await $.ui.mount(PANE)
  await pane.press({ key: 'folder-/m/Album/Disc 2' })
  await pane.unmount()
  expect(await label('folder-/m/Album/Disc 2')).toBe('▶ ▸ 📁 Disc 2/ · 2')
  expect(await label('item-1')).toBe(undefined)

  pane = await $.ui.mount(PANE)
  await pane.press({ key: 'folder-/m/Album/Live' })
  await pane.unmount()
  expect(await label('item-3')).toBe('    1. C')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a song change asks mpv nothing, and files under the folder are not looked at', async ($, on) => {
  const clock = mock.clock(on)
  let stats = 0
  const playlist: Entry[] = ['/m/Album/01 A.flac', '/m/Album/Disc 2/01 B.flac', '/m/Album/Disc 2/02 C.flac'].map(filename => ({ filename }))
  const world = engine(on, {
    title: '01 A.flac',
    exists: () => true,
    stat: () => ((stats += 1), { kind: 'file' }),
    playlist,
  })

  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)
  // The watcher tells the new position; the list stays as read.
  world.set('playlist-pos', 1)
  world.set('media-title', '01 B.flac')
  world.load()
  await clock.advance(10)
  world.set('playlist-pos', 2)
  world.set('media-title', '02 C.flac')
  world.load()
  await clock.advance(10)

  // The whole list once, at the start; nothing asked at each song.
  expect(world.sent.filter(c => c[1] === 'playlist').length).toBe(1)
  expect(world.sent.filter(c => c[1] === 'playlist-pos').length).toBe(0)
  expect(stats).toBe(0)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe('▶   2. 02 C.flac')
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

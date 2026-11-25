import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { type Entry, fakeMpv, type FakeOptions, QUEUE_JSON, QUEUE_M3U } from './fake-mpv'

const FILES = ['/home/me/Music/Album', '/home/me/Music/one.flac']
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: On, options: FakeOptions = {}) {
  on('session.cwd', () => ({ value: '/home/me/Music' }) as never)
  return fakeMpv(on, { title: 'one.flac', props: { 'time-pos': 3, duration: true }, exists: path => FILES.includes(path), ...options })
}

test('/stream plays a local folder, skipping its pictures', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, {
    stat: path => ({ kind: path === '/home/me/Music/Album' ? 'dir' : 'file' }),
    list: () => [
      { name: '01 a.flac', kind: 'file' },
      { name: 'cover.jpg', kind: 'file' },
      { name: '02 b.flac', kind: 'file' },
    ],
  })
  const reply = await $.command.run({ command: 'stream', args: '~/Music/Album' } as never)
  expect(JSON.stringify(reply)).toContain('Starting /home/me/Music/Album')
  await clock.advance(10)
  // The app lists the folder's songs; mpv is handed them as a playlist file.
  const argv = world.launches[0]!
  expect(argv.slice(-2)).toEqual(['--', QUEUE_M3U])
  expect(world.files[QUEUE_M3U]).toBe('#EXTM3U\n/home/me/Music/Album/01 a.flac\n/home/me/Music/Album/02 b.flac\n')
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
  expect(world.urls[0]).toBe('/home/me/Music/one.flac')

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
  const world = engine(on, {
    title: 'Intro',
    exists: () => true,
    stat: path => ({ kind: path.endsWith('Live') ? 'dir' : 'file' }),
    playlist: [{ filename: '/m/Album/01 Intro.flac', title: 'Intro', current: true }, { filename: '/m/Album/02 Song.flac' }, { filename: '/m/Album/Live' }],
  })

  // A queue can hold a folder (mpv opens it only when it gets there), as one
  // an earlier version played from a playlist file did.
  const entries = [{ id: '1.0', path: '/m/Album/01 Intro.flac', title: 'Intro' }, { id: '1.1', path: '/m/Album/02 Song.flac' }, { id: '1.2', path: '/m/Album/Live' }]
  world.files[QUEUE_JSON] = JSON.stringify({ version: 1, rev: 1, entries, arrangement: { kind: 'none' }, root: '', source: '/m/mix.m3u' })
  await $.command.run({ command: 'stream', args: 'last' } as never)
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
    // the folder played is looked at to list it; its files never
    stat: path => {
      if (path.startsWith('/m/Album/')) stats += 1
      return { kind: path === '/m/Album' || path.endsWith('Disc 2') ? 'dir' : 'file' }
    },
    list: path =>
      path === '/m/Album'
        ? [
            { name: '01 A.flac', kind: 'file' },
            { name: 'Disc 2', kind: 'dir' },
          ]
        : [
            { name: '01 B.flac', kind: 'file' },
            { name: '02 C.flac', kind: 'file' },
          ],
    playlist,
  })

  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)
  const reads = () => world.sent.filter(c => c[1] === 'playlist').length
  const atStart = reads()
  // The watcher tells the new position; the list stays as read.
  world.set('playlist-pos', 1)
  world.set('media-title', '01 B.flac')
  world.load()
  await clock.advance(10)
  world.set('playlist-pos', 2)
  world.set('media-title', '02 C.flac')
  world.load()
  await clock.advance(10)

  // The whole list at most once, at the start; nothing asked at each song.
  expect(atStart).toBeLessThanOrEqual(1)
  expect(reads()).toBe(atStart)
  expect(world.sent.filter(c => c[1] === 'playlist-pos').length).toBe(0)
  expect(stats).toBe(0)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe('▶   2. 02 C.flac')
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

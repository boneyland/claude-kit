import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addToQueue, removeFromQueue, reorderQueue, setRepeat, stopPlaying } from '@core/player'
import { loopsFor, repeatOf } from '@core/nowplaying'
import { openSession, type Session } from '../src/session'
import { fakeMpv, type Fake } from './fake-mpv-socket'

// The core keeps the data folder for the process, so one for the whole file.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-queue-'))
const dir = path.join(state, 'stream-radio')
const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(state, 'config'), HOME: state }
const run = async () => ({ exitCode: 0, stdout: '', stderr: '' })

let fake: Fake | undefined
let session: Session | undefined

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise(r => setTimeout(r, 50))
  expect(await cond()).toBe(true)
}
const commands = () => fake!.received.map(m => (m as { command: unknown[] }).command)
const asked = (prop: string) => commands().filter(c => c[0] === 'get_property' && c[1] === prop).length

// A session following a fake player that has loaded `playlist`.
async function loaded(props: Record<string, unknown>) {
  fake = await fakeMpv(dir, props)
  session = await openSession([], { env, run })
  await until(() => commands().some(c => c[0] === 'observe_property'))
  const count = Array.isArray(props.playlist) ? props.playlist.length : 1
  fake.push(
    { event: 'property-change', name: 'playlist-count', data: count },
    { event: 'property-change', name: 'playlist-pos', data: 0 },
    { event: 'property-change', name: 'chapter', data: -1 },
    { event: 'file-loaded' },
  )
  return session.host
}

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
// Each test starts with no stored queue: what it shows comes from the player.
beforeEach(() => {
  for (const f of ['queue.json', 'queue-place.json']) fs.rmSync(path.join(dir, f), { force: true })
})
afterEach(async () => {
  session?.close()
  session = undefined
  await fake?.close()
  fake = undefined
})

const ONE = [{ filename: '/m/a.flac', current: true }]

test('one song without chapters is a playlist of one', async () => {
  const h = await loaded({ playlist: ONE, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  expect((await h.vars.read('queue')).paths).toEqual(['/m/a.flac'])
})

test('one video with chapters still lists its chapters', async () => {
  const chapters = [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]
  const h = await loaded({ playlist: ONE, 'chapter-list': chapters, chapter: 0 })
  await until(async () => (await h.vars.read('queue')).kind === 'chapters')
  expect((await h.vars.read('queue')).items).toEqual(['One', 'Two', 'Three'])
})

test("another session's edit mark makes this one read the playlist again", async () => {
  const two = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }]
  const h = await loaded({ playlist: two, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  const before = asked('playlist')
  fake!.push({ event: 'property-change', name: 'user-data/stream-radio/edited', data: 1 })
  await until(() => asked('playlist') > before)
})

// --- adding, the queue file, resuming by path ---

const QUEUE_FILE = path.join(dir, 'queue.m3u')
const ADD_FILE = `${QUEUE_FILE}.add`
const TWO = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }]
const sent = (verb: string) => commands().filter(c => c[0] === verb)

test('add to the end appends, and the queue file becomes what plays', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  expect(await addToQueue(h, session!.config, [{ path: '/n/c.flac' }], 'end')).toBe('')
  expect(sent('loadfile')).toEqual([])
  expect(sent('loadlist')).toEqual([['loadlist', ADD_FILE, 'append']])
  expect(fs.readFileSync(ADD_FILE, 'utf8')).toBe('#EXTM3U\n/n/c.flac\n')
  expect(await h.vars.read('lastUrl')).toBe(QUEUE_FILE)
  expect(commands()).toContainEqual(['set_property', 'user-data/stream-radio/url', QUEUE_FILE])
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toContain('/m/a.flac')
})

test('play next puts the songs after the playing one, in their order', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  await addToQueue(h, session!.config, [{ path: '/n/c.flac' }, { path: '/n/d.flac' }], 'next')
  expect(sent('loadlist')).toEqual([['loadlist', ADD_FILE, 'insert-at', 1]])
  expect(fs.readFileSync(ADD_FILE, 'utf8')).toBe('#EXTM3U\n/n/c.flac\n/n/d.flac\n')
  expect(sent('playlist-move')).toEqual([])
})

test('play next on an mpv without insert-at appends, then moves the songs up', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  fake!.refuse = c => c[0] === 'loadlist' && c[2] === 'insert-at'
  await addToQueue(h, session!.config, [{ path: '/n/c.flac' }, { path: '/n/d.flac' }], 'next')
  expect(sent('loadlist')).toEqual([
    ['loadlist', ADD_FILE, 'insert-at', 1],
    ['loadlist', ADD_FILE, 'append'],
  ])
  expect(sent('playlist-move')).toEqual([
    ['playlist-move', 2, 1],
    ['playlist-move', 3, 2],
  ])
})

test('a folder adds all its songs in one command', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-add-'))
  fs.writeFileSync(path.join(folder, 'x.flac'), '')
  fs.writeFileSync(path.join(folder, 'w.flac'), '')
  fs.writeFileSync(path.join(folder, 'y.jpg'), '')
  await addToQueue(h, session!.config, [{ path: folder }], 'end')
  expect(sent('loadfile')).toEqual([])
  expect(sent('loadlist')).toEqual([['loadlist', ADD_FILE, 'append']])
  expect(fs.readFileSync(ADD_FILE, 'utf8')).toBe(`#EXTM3U\n${path.join(folder, 'w.flac')}\n${path.join(folder, 'x.flac')}\n`)
  fs.rmSync(folder, { recursive: true, force: true })
})

test('adding while nothing plays writes the queue file and starts it', async () => {
  const ran: string[][] = []
  // the queue's files are written whole, moved over the old ones
  const recording = async (argv: readonly string[]) => {
    ran.push([...argv])
    if (argv[0] === 'mv') fs.renameSync(argv[2]!, argv[3]!)
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  session = await openSession([], { env, run: recording })
  const h = session.host
  expect(await addToQueue(h, session.config, [{ path: '/n/c.flac', title: 'C' }], 'end')).toBe('')
  await until(() => ran.some(argv => argv.at(-1) === QUEUE_FILE))
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toBe('#EXTM3U\n#EXTINF:-1,C\n/n/c.flac\n')
  // no player comes up: the start waiting for one gives up
  await stopPlaying(h, session.config)
})

// --- removing and reordering ---

const THREE = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }, { filename: '/m/c.flac' }]

test('a reorder moves entries in mpv, the playing one with them, and turns shuffle off', async () => {
  const h = await loaded({ playlist: THREE, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  await h.vars.change('isShuffled', () => true)
  expect(await reorderQueue(h, [2, 0, 1])).toBe('')
  expect(sent('playlist-move')).toEqual([['playlist-move', 2, 0]])
  expect(await h.vars.read('isShuffled')).toBe(false)
  expect(commands()).toContainEqual(['set_property', 'user-data/stream-radio/shuffled', false])
  expect(await h.vars.read('lastUrl')).toBe(QUEUE_FILE)
})

test('a sort of many songs rebuilds the list around the playing one, not a move per song', async () => {
  const many = [...Array(20).keys()].map(i => ({ filename: `/m/${String(i).padStart(2, '0')}.flac`, title: i === 3 ? 'Three' : undefined, current: i === 5 }))
  const h = await loaded({ playlist: many, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  const order = [...Array(20).keys()].reverse()
  expect(await reorderQueue(h, order)).toBe('')
  const part = `${QUEUE_FILE}.part`
  // after: entries 4..0, read in last
  expect(fs.readFileSync(part, 'utf8')).toBe('#EXTM3U\n/m/04.flac\n#EXTINF:-1,Three\n/m/03.flac\n/m/02.flac\n/m/01.flac\n/m/00.flac\n')
  expect(sent('playlist-move')).toEqual([['playlist-move', 0, 15]])
  const verbs = commands().map(c => c[0]).filter(v => ['playlist-clear', 'loadlist', 'playlist-move'].includes(v as string))
  expect(verbs).toEqual(['playlist-clear', 'loadlist', 'playlist-move', 'loadlist'])
  expect(sent('loadlist')).toEqual([
    ['loadlist', part, 'append'],
    ['loadlist', part, 'append'],
  ])
})

test("an edit while mpv doesn't answer for the playlist leaves the queue file as it was", async () => {
  fs.writeFileSync(QUEUE_FILE, '#EXTM3U\n/m/a.flac\n/m/b.flac\n')
  const props: Record<string, unknown> = { playlist: THREE, 'chapter-list': [] }
  const h = await loaded(props)
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  // mpv busy: the playlist read comes back empty-handed from now on
  delete props.playlist
  expect(await reorderQueue(h, [1, 0, 2])).toBe('')
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toBe('#EXTM3U\n/m/a.flac\n/m/b.flac\n')
  expect((await h.vars.read('queue')).items).toHaveLength(3)
})

test('removing takes the highest first; removing the playing song leaves mpv to play the next', async () => {
  const h = await loaded({ playlist: THREE, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  expect(await removeFromQueue(h, session!.config, [0, 2])).toBe('')
  expect(sent('playlist-remove')).toEqual([
    ['playlist-remove', 2],
    ['playlist-remove', 0],
  ])
})

test('removing every song stops on purpose: no reconnect', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  expect(await removeFromQueue(h, session!.config, [0, 1])).toBe('Stopped: the queue is empty.')
  const intent = JSON.parse(fs.readFileSync(path.join(dir, 'player.json'), 'utf8'))
  expect(intent.isStopped).toBe(true)
  expect(sent('playlist-remove')).toEqual([])
})

test('a position that moved against a list already read still finds the song playing', async () => {
  // a sort elsewhere left the length as it was; only the new position came
  const props: Record<string, unknown> = {
    playlist: [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }, { filename: '/m/c.flac' }],
    'chapter-list': [],
  }
  const h = await loaded(props)
  await until(async () => (await h.vars.read('queue')).paths.length === 3)
  props.playlist = [{ filename: '/m/b.flac' }, { filename: '/m/c.flac' }, { filename: '/m/a.flac', current: true }]
  props['playlist/2/filename'] = '/m/a.flac'
  fake!.push({ event: 'property-change', name: 'playlist-pos', data: 2 })
  await until(async () => (await h.vars.read('queue')).current === 2)
  const q = await h.vars.read('queue')
  expect(q.paths[q.current]).toBe('/m/a.flac')
})

test('changing repeat never passes through a third mode on the way', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  const modes = ['all', 'one', 'off'] as const
  for (const from of modes) {
    for (const to of modes) {
      if (from === to) continue
      const state = { ...loopsFor(from) }
      const start = fake!.received.length
      await setRepeat(h, to)
      const sets = commands()
        .slice(start)
        .filter(c => c[0] === 'set_property' && (c[1] === 'loop-file' || c[1] === 'loop-playlist'))
      // each property as mpv tells it once set: never a mode neither old nor new
      for (const [, prop, value] of sets) {
        if (prop === 'loop-file') state.file = value as string
        else state.playlist = value as string
        expect([from, to]).toContain(repeatOf(state.file, state.playlist))
      }
      expect(repeatOf(state.file, state.playlist)).toBe(to)
    }
  }
})

test("this session's repeat change shows the new mode throughout, not what mpv tells halfway", async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  fake!.push(
    { event: 'property-change', name: 'loop-file', data: 'inf' },
    { event: 'property-change', name: 'loop-playlist', data: 'inf' },
  )
  await until(async () => (await h.vars.read('repeat')) === 'one')
  await setRepeat(h, 'off')
  // halfway: loop-playlist off, loop-file still on, which alone reads as one
  fake!.push({ event: 'property-change', name: 'loop-playlist', data: 'no' })
  await new Promise(r => setTimeout(r, 200))
  expect(await h.vars.read('repeat')).toBe('off')
  fake!.push({ event: 'property-change', name: 'loop-file', data: 'no' })
  await new Promise(r => setTimeout(r, 200))
  expect(await h.vars.read('repeat')).toBe('off')
  // done: a change made elsewhere shows again
  fake!.push({ event: 'property-change', name: 'loop-playlist', data: 'inf' })
  await until(async () => (await h.vars.read('repeat')) === 'all')
})

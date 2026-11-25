import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addToQueue,
  clearQueue,
  removeFromQueue,
  reorderQueue,
  resumeQueue,
  setRepeat,
  sortQueue,
  stopPlaying,
  toggleShuffle,
  unsortQueue,
} from '@core/player'
import { loopsFor, repeatOf } from '@core/nowplaying'
import { openSession, type Session } from '../src/session'
import { actAsMpv, fakeMpv, type Fake } from './fake-mpv-socket'

// The core keeps the data folder for the process, so one for the whole file.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-queue-'))
const dir = path.join(state, 'stream-radio')
const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(state, 'config'), HOME: state }
// Every command run, for spawns; the queue's files are written whole, moved
// over the old ones.
let ran: string[][] = []
const run = async (argv: readonly string[]) => {
  ran.push([...argv])
  if (argv[0] === 'mv') fs.renameSync(argv[2]!, argv[3]!)
  return { exitCode: 0, stdout: '', stderr: '' }
}
const spawned = () => ran.filter(argv => argv[0] === 'sh' && argv[2]?.includes('setsid'))

let fake: Fake | undefined
let session: Session | undefined

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise(r => setTimeout(r, 50))
  expect(await cond()).toBe(true)
}
const commands = () => fake!.received.map(m => (m as { command: unknown[] }).command)
const asked = (prop: string) => commands().filter(c => c[0] === 'get_property' && c[1] === prop).length

// A session following a fake player that has loaded `playlist`.
async function loaded(props: Record<string, unknown>, pos = 0) {
  fake = await fakeMpv(dir, props)
  session = await openSession([], { env, run })
  await until(() => commands().some(c => c[0] === 'observe_property'))
  const count = Array.isArray(props.playlist) ? props.playlist.length : 1
  fake.push(
    { event: 'property-change', name: 'playlist-count', data: count },
    { event: 'property-change', name: 'playlist-pos', data: pos },
    { event: 'property-change', name: 'chapter', data: -1 },
    { event: 'file-loaded' },
  )
  return session.host
}

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
// Each test starts with none of the player's files: no queue, no saved repeat.
beforeEach(() => {
  ran = []
  for (const f of ['queue.json', 'queue-place.json', 'queue.prev.json', 'player.json', 'state.json']) fs.rmSync(path.join(dir, f), { force: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
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

test("another session's edit mark makes this one read the queue's file again", async () => {
  const songs = ['/m/a.flac', '/m/b.flac']
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, rev: 1, entries: songs.map((p, i) => ({ id: `1.${i}`, path: p })), arrangement: { kind: 'none' }, root: '', source: '/src' }))
  const h = await loaded({ playlist: TWO, 'chapter-list': [], 'user-data/stream-radio/rev': 1 })
  await until(async () => (await h.vars.read('queue')).paths.length === 2)
  // another session added a song to the file; mpv has not got it yet
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ version: 1, rev: 2, entries: [...songs, '/m/c.flac'].map((p, i) => ({ id: `1.${i}`, path: p })), arrangement: { kind: 'none' }, root: '', source: '/src' }))
  fake!.push({ event: 'property-change', name: 'user-data/stream-radio/edited', data: 1 })
  await until(async () => (await h.vars.read('queue')).paths.length === 3)
  expect((await h.vars.read('queue')).paths).toEqual([...songs, '/m/c.flac'])
})

// --- edits: the file first, then mpv ---

const QUEUE_JSON = path.join(dir, 'queue.json')
const PLACE = path.join(dir, 'queue-place.json')
const PREV = path.join(dir, 'queue.prev.json')
const QUEUE_FILE = path.join(dir, 'queue.m3u')
const ADD_FILE = `${QUEUE_FILE}.add`
const TWO = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }]
const THREE = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }, { filename: '/m/c.flac' }]
const sent = (verb: string) => commands().filter(c => c[0] === verb)
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const storedPaths = () => {
  const q = readJson(QUEUE_JSON)
  const order: number[] = q.arrangement.kind === 'none' ? q.entries.map((_: unknown, i: number) => i) : q.arrangement.order
  return order.map(i => q.entries[i].path as string)
}
const revSet = () => commands().filter(c => c[0] === 'set_property' && c[1] === 'user-data/stream-radio/rev').map(c => c[2])

// A stored queue of `songs` (ids 1.0, 1.1…), at rev 1, its place on `current`.
function stored(songs: readonly string[], current = 0, arrangement: unknown = { kind: 'none' }) {
  const entries = songs.map((p, i) => ({ id: `1.${i}`, path: p }))
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 1, entries, arrangement, root: '', source: '/src' }))
  fs.writeFileSync(PLACE, JSON.stringify({ rev: 1, current: `1.${current}`, seconds: 20 }))
}
// A session following a fake mpv whose list is the stored queue `songs`, playing `pos`.
// mpv's list after the edits, by path, as the live fake has it.
let mpvProps: Record<string, unknown> = {}
const mpvPaths = () => (mpvProps.playlist as { filename: string }[]).map(e => e.filename)
async function playing(songs: readonly string[], pos = 0, arrangement?: unknown) {
  stored(songs, pos, arrangement)
  const playlist = songs.map((filename, i) => ({ filename, ...(i === pos ? { current: true } : {}) }))
  // handed the stored queue at its rev
  mpvProps = { playlist, 'chapter-list': [], 'user-data/stream-radio/rev': 1 }
  const h = await loaded(mpvProps, pos)
  actAsMpv(fake!, mpvProps)
  await until(async () => (await h.vars.read('queue')).current === pos)
  return h
}
test('add to the end appends to the file, then to mpv', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
  expect(await addToQueue(h, session!.config, [{ path: '/n/c.flac' }], 'end')).toBe('')
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac', '/n/c.flac'])
  expect(sent('loadfile')).toEqual([])
  expect(sent('loadlist')).toEqual([['loadlist', ADD_FILE, 'append']])
  expect(fs.readFileSync(ADD_FILE, 'utf8')).toBe('#EXTM3U\n/n/c.flac\n')
  // what was played to make the queue stays its source
  expect(await h.vars.read('lastUrl')).toBe('/src')
  expect(revSet()).toEqual([2])
  // mpv's new rev tells the other sessions; no second mark on top of it
  expect(commands().filter(c => c[1] === 'user-data/stream-radio/edited')).toEqual([])
})

test('play next puts the songs after the playing one, in their order', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
  await addToQueue(h, session!.config, [{ path: '/n/c.flac' }, { path: '/n/d.flac' }], 'next')
  expect(storedPaths()).toEqual(['/m/a.flac', '/n/c.flac', '/n/d.flac', '/m/b.flac'])
  expect(sent('loadlist')).toEqual([['loadlist', ADD_FILE, 'insert-at', 1]])
  expect(fs.readFileSync(ADD_FILE, 'utf8')).toBe('#EXTM3U\n/n/c.flac\n/n/d.flac\n')
  expect(sent('playlist-move')).toEqual([])
})

test('play next on an mpv without insert-at appends, then moves the songs up', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
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
  expect(mpvPaths()).toEqual(storedPaths())
})

test('play next of many songs on an mpv without insert-at rebuilds, not a move per song', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
  fake!.refuse = c => c[0] === 'loadlist' && c[2] === 'insert-at'
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `/n/${i}.flac` }))
  expect(await addToQueue(h, session!.config, many, 'next')).toBe('')
  expect(sent('playlist-move').length).toBeLessThanOrEqual(1)
  expect(sent('playlist-clear')).toHaveLength(1)
  expect(mpvPaths()).toEqual(storedPaths())
  expect(storedPaths()).toEqual(['/m/a.flac', ...many.map(e => e.path), '/m/b.flac'])
})

test('adding a playlist file adds its songs, as playing it does', async () => {
  const h = await playing(['/m/a.flac'])
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-add-'))
  fs.writeFileSync(path.join(folder, 'list.m3u'), '#EXTM3U\nx.flac\ny.flac\n')
  expect(await addToQueue(h, session!.config, [{ path: path.join(folder, 'list.m3u') }], 'end')).toBe('')
  expect(storedPaths()).toEqual(['/m/a.flac', path.join(folder, 'x.flac'), path.join(folder, 'y.flac')])
  fs.rmSync(folder, { recursive: true, force: true })
})

test("an edit does not write over a queue file it can't read", async () => {
  // a later version's queue
  const newer = JSON.stringify({ version: 2, rev: 7, entries: [{ id: '7.0', path: '/m/a.flac' }] })
  fs.writeFileSync(QUEUE_JSON, newer)
  session = await openSession([], { env, run })
  expect(await toggleShuffle(session.host)).toBe('Could not save the queue.')
  expect(fs.readFileSync(QUEUE_JSON, 'utf8')).toBe(newer)
})

test('a broken queue file is moved aside before an edit starts over', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
  fs.writeFileSync(QUEUE_JSON, '{"version":1,"rev":3,"entries":[{"id":"x","path":"/m/a.flac"},{"id":"x","path":"/m/b.flac"}]}')
  await addToQueue(h, session!.config, [{ path: '/n/c.flac' }], 'end')
  expect(fs.readFileSync(`${QUEUE_JSON}.broken`, 'utf8')).toContain('"id":"x"')
  expect(readJson(QUEUE_JSON).entries.map((e: { path: string }) => e.path)).toEqual(['/n/c.flac'])
  fs.rmSync(`${QUEUE_JSON}.broken`, { force: true })
})

test('a folder adds all its songs in one command', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac'])
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

test('adding to an empty queue while nothing plays starts it', async () => {
  session = await openSession([], { env, run })
  const h = session.host
  expect(await addToQueue(h, session.config, [{ path: '/n/c.flac', title: 'C' }], 'end')).toBe('')
  await until(() => ran.some(argv => argv.at(-1) === `--playlist=${QUEUE_FILE}`))
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toBe('#EXTM3U\n#EXTINF:-1,C\n/n/c.flac\n')
  // no player comes up: the start waiting for one gives up
  await stopPlaying(h, session.config)
})

test('edits work stopped', async () => {
  stored(['/m/a.flac', '/m/b.flac', '/m/c.flac'], 1)
  session = await openSession([], { env, run })
  const h = session.host
  const shown = async () => (await h.vars.read('queue')).paths
  await until(async () => (await shown()).length === 3)

  expect(await removeFromQueue(h, session.config, [0])).toBe('')
  expect(storedPaths()).toEqual(['/m/b.flac', '/m/c.flac'])
  expect(await shown()).toEqual(['/m/b.flac', '/m/c.flac'])

  expect(await reorderQueue(h, [1, 0])).toBe('')
  expect(storedPaths()).toEqual(['/m/c.flac', '/m/b.flac'])
  expect(await shown()).toEqual(['/m/c.flac', '/m/b.flac'])

  expect(await toggleShuffle(h)).toBe('Shuffled.')
  expect(readJson(QUEUE_JSON).arrangement.kind).toBe('shuffle')
  expect(await h.vars.read('isShuffled')).toBe(true)
  // the current song (b) first
  expect(storedPaths()[0]).toBe('/m/b.flac')

  // a kept queue is added to, not replaced
  expect(await addToQueue(h, session.config, [{ path: '/n/d.flac' }], 'end')).toBe('')
  expect(storedPaths()).toEqual(['/m/b.flac', '/m/c.flac', '/n/d.flac'])
  expect(await shown()).toEqual(['/m/b.flac', '/m/c.flac', '/n/d.flac'])

  expect(readJson(QUEUE_JSON).rev).toBe(5)
  expect(fake).toBeUndefined()
  expect(spawned()).toEqual([])
})

test('shuffle round trip while playing', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  // the rest in an order that moves something: c, b
  vi.spyOn(Math, 'random').mockReturnValue(0)
  expect(await toggleShuffle(h)).toBe('Shuffled.')
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/c.flac', '/m/b.flac'])
  expect(sent('playlist-move')).toEqual([['playlist-move', 2, 1]])
  expect(await h.vars.read('isShuffled')).toBe(true)

  expect(await toggleShuffle(h)).toBe('Back in order.')
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  expect(sent('playlist-move')).toEqual([
    ['playlist-move', 2, 1],
    ['playlist-move', 2, 1],
  ])
  expect(await h.vars.read('isShuffled')).toBe(false)
  expect(sent('playlist-play-index')).toEqual([])
  expect(sent('playlist-shuffle')).toEqual([])
  expect(sent('playlist-unshuffle')).toEqual([])
  expect(commands().some(c => c[1] === 'user-data/stream-radio/shuffled')).toBe(false)
  expect(revSet()).toEqual([2, 3])
})

test('sort keeps the playing copy by id', async () => {
  // a, b and a again, the second a playing
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/a.flac'], 2)
  await until(() => fs.existsSync(PLACE) && readJson(PLACE).current === '1.2')
  expect(await sortQueue(h, 'title', false, [0, 2, 1])).toBe('')
  expect(readJson(QUEUE_JSON).arrangement).toEqual({ kind: 'sort', field: 'title', isReversed: false, order: [0, 2, 1] })
  expect(readJson(PLACE).current).toBe('1.2')
  expect(sent('playlist-move')).toEqual([['playlist-move', 2, 1]])
  expect(mpvPaths()).toEqual(['/m/a.flac', '/m/a.flac', '/m/b.flac'])
  // mpv tells where the song playing went: the place stays on that copy
  fake!.push({ event: 'property-change', name: 'playlist-pos', data: 1 })
  await until(async () => (await h.vars.read('queue')).current === 1)
  await new Promise(r => setTimeout(r, 200))
  expect(readJson(PLACE).current).toBe('1.2')
  expect(sent('playlist-play-index')).toEqual([])
})

test('edits not waited for land in order, in the file and in mpv', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac', '/m/d.flac'])
  // two hand moves in a row, as a held key sends them
  const first = reorderQueue(h, [1, 0, 2, 3])
  const second = reorderQueue(h, [0, 1, 3, 2])
  expect(await Promise.all([first, second])).toEqual(['', ''])
  expect(storedPaths()).toEqual(['/m/b.flac', '/m/a.flac', '/m/d.flac', '/m/c.flac'])
  expect(mpvPaths()).toEqual(storedPaths())
  expect(mpvProps['user-data/stream-radio/rev']).toBe(readJson(QUEUE_JSON).rev)
})

test("mpv at another rev than the queue edited is left for the rebuild", async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  // another program edited the queue and has not brought mpv along yet
  mpvProps['user-data/stream-radio/rev'] = 7
  expect(await reorderQueue(h, [2, 0, 1])).toBe('')
  expect(storedPaths()).toEqual(['/m/c.flac', '/m/a.flac', '/m/b.flac'])
  expect(sent('playlist-move')).toEqual([])
  expect(revSet()).toEqual([])
})

test('sort then unsort returns the queued order', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  expect(await sortQueue(h, 'title', true, [2, 1, 0])).toBe('')
  expect(storedPaths()).toEqual(['/m/c.flac', '/m/b.flac', '/m/a.flac'])
  expect(await unsortQueue(h)).toBe('')
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  expect(readJson(QUEUE_JSON).arrangement).toEqual({ kind: 'none' })
  expect(sent('playlist-play-index')).toEqual([])
  // already as queued: nothing more
  const rev = readJson(QUEUE_JSON).rev
  expect(await unsortQueue(h)).toBe('')
  expect(readJson(QUEUE_JSON).rev).toBe(rev)
})

test('a stale order from a UI changes nothing', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  const before = fs.readFileSync(QUEUE_JSON, 'utf8')
  expect(await reorderQueue(h, [1, 0])).toBe('The queue changed meanwhile; try again.')
  expect(await sortQueue(h, 'title', false, [3, 2, 1, 0])).toBe('The queue changed meanwhile; try again.')
  expect(fs.readFileSync(QUEUE_JSON, 'utf8')).toBe(before)
  expect(sent('playlist-move')).toEqual([])
})

test('a hand move while shuffled moves entries in mpv and turns the shuffle off', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'], 0, { kind: 'shuffle', order: [0, 1, 2] })
  await h.vars.change('isShuffled', () => true)
  expect(await reorderQueue(h, [2, 0, 1])).toBe('')
  expect(sent('playlist-move')).toEqual([['playlist-move', 2, 0]])
  expect(readJson(QUEUE_JSON).arrangement).toEqual({ kind: 'none' })
  expect(storedPaths()).toEqual(['/m/c.flac', '/m/a.flac', '/m/b.flac'])
  expect(await h.vars.read('isShuffled')).toBe(false)
})

test('a sort of many songs rebuilds the list around the playing one, not a move per song', async () => {
  const many = [...Array(20).keys()].map(i => ({ filename: `/m/${String(i).padStart(2, '0')}.flac`, title: i === 3 ? 'Three' : undefined, current: i === 5 }))
  stored(many.map(e => e.filename), 5)
  const h = await loaded({ playlist: many, 'chapter-list': [], 'user-data/stream-radio/rev': 1 }, 5)
  await until(async () => (await h.vars.read('queue')).current === 5)
  const order = [...Array(20).keys()].reverse()
  expect(await reorderQueue(h, order)).toBe('')
  const part = `${QUEUE_FILE}.part`
  // after: the file's entries 4..0, read in last
  expect(fs.readFileSync(part, 'utf8')).toBe('#EXTM3U\n/m/04.flac\n/m/03.flac\n/m/02.flac\n/m/01.flac\n/m/00.flac\n')
  expect(sent('playlist-move')).toEqual([['playlist-move', 0, 15]])
  const verbs = commands().map(c => c[0]).filter(v => ['playlist-clear', 'loadlist', 'playlist-move'].includes(v as string))
  expect(verbs).toEqual(['playlist-clear', 'loadlist', 'playlist-move', 'loadlist'])
  expect(sent('loadlist')).toEqual([
    ['loadlist', part, 'append'],
    ['loadlist', part, 'append'],
  ])
})

test('a player without a rev (an older build) is brought to the file around the song playing', async () => {
  stored(['/m/a.flac', '/m/b.flac'])
  // three songs, and no rev: the file is what it is brought to
  mpvProps = { playlist: THREE.map(e => ({ ...e })), 'chapter-list': [] }
  const h = await loaded(mpvProps)
  actAsMpv(fake!, mpvProps)
  await until(() => revSet().length > 0)
  expect(revSet()).toEqual([1])
  expect(mpvPaths()).toEqual(['/m/a.flac', '/m/b.flac'])
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac'])
  expect(sent('playlist-play-index')).toEqual([])
  expect((await h.vars.read('queue')).paths).toEqual(['/m/a.flac', '/m/b.flac'])
})

test('a song playing that the file lacks plays on first; the file is not changed, and the song goes once it has played', async () => {
  // another program removed a; its sync never reached mpv
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 2, entries: [{ id: '1.1', path: '/m/b.flac' }, { id: '2.0', path: '/n/d.flac' }], arrangement: { kind: 'none' }, root: '', source: '/src' }))
  const before = fs.readFileSync(QUEUE_JSON, 'utf8')
  mpvProps = { playlist: TWO.map(e => ({ ...e })), 'chapter-list': [], 'user-data/stream-radio/rev': 1 }
  await loaded(mpvProps)
  actAsMpv(fake!, mpvProps)
  await until(() => sent('playlist-clear').length > 0)
  await until(() => mpvPaths().length === 3)
  expect(mpvPaths()).toEqual(['/m/a.flac', '/m/b.flac', '/n/d.flac'])
  expect(fs.readFileSync(QUEUE_JSON, 'utf8')).toBe(before)
  // a plays on, so mpv is not at the file's rev yet
  expect(revSet()).toEqual([])
  expect(sent('playlist-play-index')).toEqual([])
  expect(sent('playlist-remove')).toEqual([])

  // a ended: mpv plays b; a goes, and mpv is at the file's rev
  const list = mpvProps.playlist as { filename: string; current?: boolean }[]
  list.forEach((e, i) => (e.current = i === 1 ? true : undefined))
  fake!.push({ event: 'property-change', name: 'playlist-pos', data: 1 })
  await until(() => revSet().length > 0)
  expect(sent('playlist-remove')).toEqual([['playlist-remove', 0]])
  expect(revSet()).toEqual([2])
  expect(mpvPaths()).toEqual(storedPaths())
  expect(fs.readFileSync(QUEUE_JSON, 'utf8')).toBe(before)
})

test("an empty queue takes the older player's list", async () => {
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 2, entries: [], arrangement: { kind: 'none' }, root: '', source: '' }))
  mpvProps = { playlist: TWO.map(e => ({ ...e })), 'chapter-list': [] }
  const h = await loaded(mpvProps)
  actAsMpv(fake!, mpvProps)
  await until(() => revSet().length > 0)
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac'])
  expect(readJson(QUEUE_JSON).rev).toBe(3)
  expect(revSet()).toEqual([3])
  for (const verb of ['playlist-clear', 'loadlist', 'playlist-remove', 'playlist-play-index']) expect(sent(verb)).toEqual([])
  await until(async () => (await h.vars.read('queue')).paths.length === 2)
})

test("an edit holds the queue lock until mpv has its moves and rev: no other program's mend comes between", async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac', '/m/d.flac'])
  // mpv slow to answer, as the mod's process per command is
  fake!.delay = c => (c[0] === 'playlist-remove' ? 300 : 0)
  const lock = path.join(dir, 'queue.lock')
  // the lock taken (created) and not yet let go (removed)
  const isLocked = () =>
    ran.filter(a => a[0] === 'sh' && a[2]?.includes('set -C') && a[5] === lock).length > ran.filter(a => a[0] === 'rm' && a.at(-1) === lock).length
  const removing = removeFromQueue(h, session!.config, [1, 3])
  await until(() => sent('playlist-remove').length > 0)
  // mid-sync: the file has the edit, and the lock is still held
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/c.flac'])
  expect(isLocked()).toBe(true)
  expect(revSet()).toEqual([])
  await until(() => sent('playlist-remove').length > 1)
  expect(isLocked()).toBe(true)
  expect(await removing).toBe('')
  expect(isLocked()).toBe(false)
  expect(sent('playlist-remove')).toEqual([
    ['playlist-remove', 3],
    ['playlist-remove', 1],
  ])
  expect(revSet()).toEqual([2])
  expect(mpvPaths()).toEqual(['/m/a.flac', '/m/c.flac'])
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/c.flac'])
})

test('remove the playing song plays the next; remove all clears and stops (no reconnect)', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  expect(await removeFromQueue(h, session!.config, [0, 2])).toBe('')
  expect(storedPaths()).toEqual(['/m/b.flac'])
  // highest first; mpv plays the next by itself
  expect(sent('playlist-remove')).toEqual([
    ['playlist-remove', 2],
    ['playlist-remove', 0],
  ])
  expect(sent('playlist-play-index')).toEqual([])
  expect(readJson(PLACE)).toMatchObject({ rev: 2, current: '1.1', seconds: 0 })

  expect(await removeFromQueue(h, session!.config, [0])).toBe('Cleared the playlist. l brings it back.')
  expect(readJson(path.join(dir, 'player.json')).isStopped).toBe(true)
  expect(readJson(QUEUE_JSON).entries).toEqual([])
  expect(sent('playlist-remove')).toHaveLength(2)
})

test('clear backs up; l brings it back', async () => {
  stored(['/m/a.flac', '/m/b.flac', '/m/c.flac'], 2)
  session = await openSession([], { env, run })
  const h = session.host
  expect(await clearQueue(h, session.config)).toBe('Cleared the playlist. l brings it back.')
  expect(readJson(QUEUE_JSON).entries).toEqual([])
  expect(readJson(PREV).entries.map((e: { path: string }) => e.path)).toEqual(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  expect((await h.vars.read('queue')).kind).toBe('none')

  expect(await resumeQueue(h, session.config, '')).toBe('')
  expect(storedPaths()).toEqual(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  // back at the place it had
  await until(() => spawned().length > 0)
  expect(spawned()[0]).toContain('--playlist-start=2')
  await stopPlaying(h, session.config)
})

test('clear stops the player before it empties the file, so no mend writes the player\'s list back', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  // when the emptied queue lands, whether the player had been told to quit
  let quitFirst: boolean | undefined
  const was = session!.host.run
  vi.spyOn(session!.host, 'run').mockImplementation(async (argv, opts) => {
    if (argv[0] === 'mv' && argv[3] === QUEUE_JSON && JSON.parse(fs.readFileSync(argv[2]!, 'utf8')).entries.length === 0) {
      quitFirst = commands().some(c => c[0] === 'quit')
    }
    return was(argv, opts)
  })
  expect(await clearQueue(h, session!.config)).toBe('Cleared the playlist. l brings it back.')
  expect(quitFirst).toBe(true)
  expect(readJson(QUEUE_JSON).entries).toEqual([])
  expect(readJson(path.join(dir, 'player.json')).isStopped).toBe(true)
})

// each waits QUEUE_LOCK_WAIT_MS for the lock before it says so
test('a busy queue says so', { timeout: 30_000 }, async () => {
  stored(['/m/a.flac', '/m/b.flac'])
  session = await openSession([], { env, run: async (argv: readonly string[]) => {
    // the queue lock is held elsewhere
    if (argv[0] === 'sh' && argv[2]?.includes('set -C')) return { exitCode: 1, stdout: '', stderr: '' }
    return run(argv)
  } })
  fs.writeFileSync(path.join(dir, 'queue.lock'), String(Date.now()))
  const h = session.host
  expect(await removeFromQueue(h, session.config, [0])).toBe('The queue is busy; try again.')
  expect(await clearQueue(h, session.config)).toBe('The queue is busy; try again.')
  fs.rmSync(path.join(dir, 'queue.lock'), { force: true })
})

test('a position that comes before the sort it follows from still ends on the song playing', async () => {
  const h = await playing(['/m/a.flac', '/m/b.flac', '/m/c.flac'])
  // the session has taken its place from mpv (a, from its start)
  await until(() => readJson(PLACE).seconds === 0)
  // a sort elsewhere left the length as it was: the file (the same ids, in a
  // new order), mpv's list and rev change, and the new position comes before the rev
  const sorted = [{ id: '1.1', path: '/m/b.flac' }, { id: '1.2', path: '/m/c.flac' }, { id: '1.0', path: '/m/a.flac' }]
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 2, entries: sorted, arrangement: { kind: 'none' }, root: '', source: '/src' }))
  mpvProps.playlist = [{ filename: '/m/b.flac' }, { filename: '/m/c.flac' }, { filename: '/m/a.flac', current: true }]
  mpvProps['playlist/2/filename'] = '/m/a.flac'
  fake!.push({ event: 'property-change', name: 'playlist-pos', data: 2 })
  await new Promise(r => setTimeout(r, 300))
  // not taken against the list shown (c is at 2 there): the place stays on a
  expect(readJson(PLACE).current).toBe('1.0')
  const q = await h.vars.read('queue')
  expect(q.paths[q.current]).toBe('/m/a.flac')

  mpvProps['user-data/stream-radio/rev'] = 2
  fake!.push({ event: 'property-change', name: 'user-data/stream-radio/rev', data: 2 })
  await until(async () => {
    const q = await h.vars.read('queue')
    return q.current === 2 && q.paths[2] === '/m/a.flac'
  })
  expect(readJson(PLACE).current).toBe('1.0')
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

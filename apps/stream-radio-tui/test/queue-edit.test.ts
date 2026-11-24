import { afterEach, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addToQueue, removeFromQueue, reorderQueue, resume } from '../../../plugins/stream-radio/core/player'
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
const TWO = [{ filename: '/m/a.flac', current: true }, { filename: '/m/b.flac' }]
const sent = (verb: string) => commands().filter(c => c[0] === verb)

test('add to the end appends, and the queue file becomes what plays', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  expect(await addToQueue(h, session!.config, [{ path: '/n/c.flac' }], 'end')).toBe('')
  expect(sent('loadfile')).toEqual([['loadfile', '/n/c.flac', 'append']])
  expect(await h.vars.read('lastUrl')).toBe(QUEUE_FILE)
  expect(commands()).toContainEqual(['set_property', 'user-data/stream-radio/url', QUEUE_FILE])
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toContain('/m/a.flac')
})

test('play next puts the songs after the playing one, in their order', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  await addToQueue(h, session!.config, [{ path: '/n/c.flac' }, { path: '/n/d.flac' }], 'next')
  expect(sent('loadfile')).toHaveLength(2)
  expect(sent('playlist-move')).toEqual([
    ['playlist-move', 2, 1],
    ['playlist-move', 3, 2],
  ])
})

test('a folder adds its songs one by one', async () => {
  const h = await loaded({ playlist: TWO, 'chapter-list': [] })
  await until(async () => (await h.vars.read('queue')).kind === 'playlist')
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-add-'))
  fs.writeFileSync(path.join(folder, 'x.flac'), '')
  fs.writeFileSync(path.join(folder, 'y.jpg'), '')
  await addToQueue(h, session!.config, [{ path: folder }], 'end')
  expect(sent('loadfile')).toEqual([['loadfile', path.join(folder, 'x.flac'), 'append']])
  fs.rmSync(folder, { recursive: true, force: true })
})

test('adding while nothing plays writes the queue file and starts it', async () => {
  const ran: string[][] = []
  const recording = async (argv: readonly string[]) => (ran.push([...argv]), { exitCode: 0, stdout: '', stderr: '' })
  session = await openSession([], { env, run: recording })
  const h = session.host
  expect(await addToQueue(h, session.config, [{ path: '/n/c.flac', title: 'C' }], 'end')).toBe('')
  await until(() => ran.some(argv => argv.at(-1) === QUEUE_FILE))
  expect(fs.readFileSync(QUEUE_FILE, 'utf8')).toBe('#EXTM3U\n#EXTINF:-1,C\n/n/c.flac\n')
})

test('resume finds the song by path after a reorder', async () => {
  const props = { playlist: TWO, 'chapter-list': [] }
  fake = await fakeMpv(dir, props)
  session = await openSession([], { env, run })
  const h = session.host
  resume(h, session.config, QUEUE_FILE, { url: QUEUE_FILE, index: 0, path: '/m/b.flac', seconds: 30, title: 'B' })
  await until(() => commands().some(c => c[0] === 'observe_property'))
  fake.push(
    { event: 'property-change', name: 'playlist-count', data: 2 },
    { event: 'property-change', name: 'playlist-pos', data: 0 },
    { event: 'property-change', name: 'chapter', data: -1 },
    { event: 'file-loaded' },
  )
  await until(() => sent('playlist-play-index').length > 0)
  expect(sent('playlist-play-index')).toEqual([['playlist-play-index', 1]])
  fake.push({ event: 'property-change', name: 'playlist-pos', data: 1 }, { event: 'file-loaded' })
  await until(() => sent('seek').length > 0)
  expect(sent('seek')).toEqual([['seek', 30, 'absolute']])
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

import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { checkDefault, playAt, playSource, resumeQueue, stopPlaying } from '@core/player'
import { openSession, type Session } from '../src/session'
import { fakeMpv, type Fake } from './fake-mpv-socket'

// The queue the app owns, played from its file. The core keeps the data folder
// for the process, so one for the whole file.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-store-'))
const dir = path.join(state, 'stream-radio')
const music = path.join(state, 'm')
const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(state, 'config'), HOME: state }
const QUEUE_JSON = path.join(dir, 'queue.json')
const PLACE = path.join(dir, 'queue-place.json')
const PREV = path.join(dir, 'queue.prev.json')

type Result = { exitCode: number; stdout: string; stderr: string }
const ok: Result = { exitCode: 0, stdout: '', stderr: '' }

// Each player start's argv; mpv itself never runs.
let launches: string[][] = []
// The system, but a start of the player is only recorded (the test brings up a
// fake mpv on its socket) and `mpv --version` and `kill` are answered.
const run = async (argv: readonly string[]): Promise<Result> => {
  if (argv[0] === 'sh' && argv[2]?.includes('setsid')) return (launches.push(argv.slice(5)), ok)
  if (argv[1] === '--version' || argv[0] === 'kill') return ok
  return new Promise(resolve =>
    execFile(argv[0]!, argv.slice(1), (error, stdout, stderr) => resolve({ exitCode: error ? 1 : 0, stdout, stderr })),
  )
}

let fake: Fake | undefined
let session: Session | undefined

const until = async (cond: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise(r => setTimeout(r, 50))
  expect(await cond()).toBe(true)
}
const commands = () => (fake?.received ?? []).map(m => (m as { command: unknown[] }).command)
const sent = (verb: string) => commands().filter(c => c[0] === verb)
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

const SONGS = ['a', 'b', 'c'].map(n => path.join(music, 'X', `${n}.flac`))

// Once a start was asked for, a fake mpv that has loaded `songs` at `pos`.
async function playerUp(songs: string[], pos: number) {
  await until(() => launches.length > 0)
  const playlist = songs.map((filename, i) => ({ filename, ...(i === pos ? { current: true } : {}) }))
  fake = await fakeMpv(dir, { playlist, 'chapter-list': [] })
  await until(() => commands().some(c => c[0] === 'observe_property'))
  fake.push(
    { event: 'property-change', name: 'playlist-count', data: songs.length },
    { event: 'property-change', name: 'playlist-pos', data: pos },
    { event: 'property-change', name: 'chapter', data: -1 },
    { event: 'file-loaded' },
  )
}

// A stored queue of SONGS, as earlier play left it.
function stored(source = path.join(music, 'X')) {
  const entries = SONGS.map((p, i) => ({ id: `1.${i}`, path: p }))
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 1, entries, arrangement: { kind: 'none' }, root: source, source }))
}

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(music, 'X'), { recursive: true })
  for (const s of SONGS) fs.writeFileSync(s, '')
  for (const folder of ['A', 'Y']) {
    fs.mkdirSync(path.join(music, folder), { recursive: true })
    for (const n of ['a', 'b']) fs.writeFileSync(path.join(music, folder, `${n}.flac`), '')
  }
})
beforeEach(() => {
  launches = []
  for (const f of [QUEUE_JSON, PLACE, PREV, path.join(dir, 'state.json'), path.join(dir, 'player.json')]) fs.rmSync(f, { force: true })
})
afterEach(async () => {
  // a start still waiting for its player gives up
  if (session && !fake) await stopPlaying(session.host, session.config)
  session?.close()
  session = undefined
  await fake?.close()
  fake = undefined
})

test('stop keeps the queue', { timeout: 20_000 }, async () => {
  session = await openSession([], { env, run })
  const h = session.host
  expect(await playSource(h, session.config, path.join(music, 'X'))).toBe('')
  await playerUp(SONGS, 1)
  await until(async () => readJson(PLACE).current === '1.1')
  const before = fs.readFileSync(QUEUE_JSON, 'utf8')
  await stopPlaying(h, session.config)
  const q = await h.vars.read('queue')
  expect([q.kind, q.items.length, q.current]).toEqual(['playlist', 3, 1])
  expect(fs.readFileSync(QUEUE_JSON, 'utf8')).toBe(before)
  expect(readJson(path.join(dir, 'player.json')).isStopped).toBe(true)
})

test('play after stop starts the song from 0:00', { timeout: 20_000 }, async () => {
  stored()
  fs.writeFileSync(PLACE, JSON.stringify({ rev: 1, current: '1.0', seconds: 70 }))
  session = await openSession([], { env, run })
  const h = session.host
  expect(await playAt(h, session.config, 1)).toBe('')
  await until(() => launches.length > 0)
  expect(launches[0]).toContain('--playlist-start=1')
  await playerUp(SONGS, 1)
  await until(async () => readJson(PLACE).current === '1.1')
  await new Promise(r => setTimeout(r, 300))
  expect(sent('seek')).toEqual([])
  expect(sent('playlist-play-index')).toEqual([])
})

test('l resumes at the place', { timeout: 20_000 }, async () => {
  stored()
  fs.writeFileSync(PLACE, JSON.stringify({ rev: 1, current: '1.2', seconds: 42 }))
  session = await openSession([], { env, run })
  const h = session.host
  expect(await resumeQueue(h, session.config, '')).toBe('')
  await until(() => launches.length > 0)
  expect(launches[0]).toContain('--playlist-start=2')
  await playerUp(SONGS, 2)
  await until(() => sent('seek').length > 0)
  expect(sent('seek')).toEqual([['seek', 42, 'absolute']])
  expect(sent('playlist-play-index')).toEqual([])
})

test('resume finds the song by path when mpv starts on another', { timeout: 20_000 }, async () => {
  stored()
  fs.writeFileSync(PLACE, JSON.stringify({ rev: 1, current: '1.1', seconds: 30 }))
  session = await openSession([], { env, run })
  const h = session.host
  await resumeQueue(h, session.config, '')
  await playerUp(SONGS, 0)
  await until(() => sent('playlist-play-index').length > 0)
  expect(sent('playlist-play-index')).toEqual([['playlist-play-index', 1]])
  fake!.push({ event: 'property-change', name: 'playlist-pos', data: 1 }, { event: 'file-loaded' })
  await until(() => sent('seek').length > 0)
  expect(sent('seek')).toEqual([['seek', 30, 'absolute']])
})

test('empty queue: l brings back the cleared one, else the default', { timeout: 20_000 }, async () => {
  const entries = SONGS.slice(0, 2).map((p, i) => ({ id: `4.${i}`, path: p }))
  fs.writeFileSync(PREV, JSON.stringify({ version: 1, rev: 4, entries, arrangement: { kind: 'none' }, root: '', source: '/prev' }))
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 5, entries: [], arrangement: { kind: 'none' }, root: '', source: '' }))
  session = await openSession([], { env, run })
  const h = session.host
  expect(await resumeQueue(h, session.config, 'https://example.com/radio')).toBe('')
  expect(readJson(QUEUE_JSON).entries.map((e: { path: string }) => e.path)).toEqual(SONGS.slice(0, 2))
  await until(() => launches.length > 0)
  expect(await h.vars.read('lastUrl')).toBe('/prev')

  // nothing to bring back: the default plays
  await stopPlaying(h, session.config)
  launches = []
  fs.rmSync(PREV)
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 9, entries: [], arrangement: { kind: 'none' }, root: '', source: '' }))
  expect(await resumeQueue(h, session.config, 'https://example.com/radio')).toBe('')
  expect(readJson(QUEUE_JSON)).toMatchObject({ source: 'https://example.com/radio', entries: [{ path: 'https://example.com/radio' }] })
  await until(() => launches.length > 0)

  // nothing at all
  await stopPlaying(h, session.config)
  launches = []
  fs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 12, entries: [], arrangement: { kind: 'none' }, root: '', source: '' }))
  expect(await resumeQueue(h, session.config, '')).toBe('Nothing has played yet, and there is no default stream.')
  expect(launches).toEqual([])
})

test('a changed default leaves the queue', async () => {
  stored()
  fs.writeFileSync(PLACE, JSON.stringify({ rev: 1, current: '1.2', seconds: 42 }))
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, knownDefault: { tui: 'https://example.com/old' } }))
  session = await openSession([], { env, run })
  const h = session.host
  // the queue is read in the background
  await until(async () => (await h.vars.read('lastUrl')) !== '')
  const [queue, place] = [fs.readFileSync(QUEUE_JSON, 'utf8'), fs.readFileSync(PLACE, 'utf8')]
  await checkDefault(h, 'https://example.com/new')
  expect([fs.readFileSync(QUEUE_JSON, 'utf8'), fs.readFileSync(PLACE, 'utf8')]).toEqual([queue, place])
  expect(await h.vars.read('lastUrl')).toBe(path.join(music, 'X'))
  expect(readJson(path.join(dir, 'state.json')).knownDefault.tui).toBe('https://example.com/new')
})

test("migration from state.json's last", async () => {
  const A = path.join(music, 'A')
  const b = path.join(A, 'b.flac')
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ version: 1, last: { url: A, resumeAt: { url: A, index: 1, seconds: 30, title: 'b', path: b } } }),
  )
  session = await openSession([], { env, run })
  // in the background: the session is up before it is done
  await until(async () => (await session!.host.vars.read('queue')).items.length === 2)
  const q = readJson(QUEUE_JSON)
  expect(q.entries.map((e: { path: string }) => e.path)).toEqual([path.join(A, 'a.flac'), b])
  expect(q.source).toBe(A)
  const place = readJson(PLACE)
  expect([place.current, place.seconds]).toEqual([q.entries[1].id, 30])
  // shown at once, stopped
  const queue = await session.host.vars.read('queue')
  expect([queue.kind, queue.items.length, queue.current]).toEqual(['playlist', 2, 1])
  expect(launches).toEqual([])
})

test('a migration that comes to nothing writes the empty queue, so it is not tried again', async () => {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, last: { url: '/nowhere/list.m3u', resumeAt: { url: '/nowhere/list.m3u', index: 0, seconds: 0, title: '' } } }))
  session = await openSession([], { env, run })
  await until(() => fs.existsSync(QUEUE_JSON))
  expect(readJson(QUEUE_JSON)).toMatchObject({ rev: 1, entries: [] })
  expect((await session.host.vars.read('queue')).kind).toBe('none')
})

test('a new play while a player is followed shows its list at once, and keeps it if the start fails', { timeout: 30_000 }, async () => {
  session = await openSession([], { env, run })
  const h = session.host
  await playSource(h, session.config, path.join(music, 'X'))
  await playerUp(SONGS, 0)
  await until(async () => (await h.vars.read('queue')).paths.length === 3)
  const Y = ['a', 'b'].map(n => path.join(music, 'Y', `${n}.flac`))
  expect(await playSource(h, session.config, path.join(music, 'Y'))).toBe('')
  expect((await h.vars.read('queue')).paths).toEqual(Y)
  // no player comes up for it (the old one is gone, and nothing answers)
  for (let i = 0; i < 200 && !session.status(); i++) await new Promise(r => setTimeout(r, 100))
  expect(session.status()).not.toBe('')
  const q = await h.vars.read('queue')
  expect([q.kind, q.paths]).toEqual(['playlist', Y])
})

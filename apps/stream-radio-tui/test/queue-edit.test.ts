import { afterEach, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

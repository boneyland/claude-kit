import { afterEach, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seek } from '@core/player'
import { openSession, type Session } from '../src/session'
import { fakeMpv, type Fake } from './fake-mpv-socket'

// The core keeps the data folder for the process, so one for the whole file.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-seek-'))
const dir = path.join(state, 'stream-radio')
const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(state, 'config'), HOME: state }
const run = async () => ({ exitCode: 0, stdout: '', stderr: '' })

let fake: Fake | undefined
let session: Session | undefined

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 50))
  expect(cond()).toBe(true)
}
const commands = () => fake!.received.map(m => (m as { command: unknown[] }).command)
const seeks = () => commands().filter(c => c[0] === 'seek')

// A session following a fake player that plays a file 1:00 in.
async function playing(props: Record<string, unknown>, elapsed = 60) {
  fake = await fakeMpv(dir, props)
  session = await openSession([], { env, run })
  await until(() => commands().some(c => c[0] === 'observe_property'))
  const v = session.host.vars
  await v.change('lastUrl', () => '/m/song.mp3')
  await v.change('playing', () => 'Song')
  await v.change('elapsed', () => elapsed)
  return session.host
}

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
afterEach(async () => {
  session?.close()
  session = undefined
  await fake?.close()
  fake = undefined
})

test('seeks there, and the time and the resume point follow at once', async () => {
  const h = await playing({ duration: 245 })
  expect(await seek(h, 90)).toBe('')
  expect(seeks()).toEqual([['seek', 90, 'absolute']])
  expect(await h.vars.read('elapsed')).toBe(90)
  expect((await h.vars.read('resumeAt')).seconds).toBe(90)
})

test('kept within the song: a second short of the end, and not before the start', async () => {
  const h = await playing({ duration: 245 })
  await seek(h, 500)
  await seek(h, -5)
  expect(seeks()).toEqual([
    ['seek', 244, 'absolute'],
    ['seek', 0, 'absolute'],
  ])
})

test('a live stream, or nothing playing: nothing to seek in', async () => {
  const h = await playing({ duration: 245 }, -1)
  expect(await seek(h, 90)).toBe('Nothing to seek in.')
  expect(seeks()).toEqual([])
})

test('the length unknown: seeks where asked', async () => {
  const h = await playing({})
  await seek(h, 300)
  expect(seeks()).toEqual([['seek', 300, 'absolute']])
})

test('a relative seek counts from where mpv is to the fraction, not the whole second shown', async () => {
  const h = await playing({ duration: 245, 'time-pos': 60.9 })
  await seek(h, 10, true)
  await seek(h, -10, true)
  expect(seeks()).toEqual([
    ['seek', 70.9, 'absolute'],
    ['seek', 50.9, 'absolute'],
  ])
  // the clock shows whole seconds, as the watcher gives them
  expect(await h.vars.read('elapsed')).toBe(50)
})

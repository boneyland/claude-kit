import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { openSession, type Session } from '../src/session'
import { fakeMpv, type Fake } from './fake-mpv-socket'

// The core keeps the data folder for the process, so one for the whole file.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-session-'))
const dir = path.join(state, 'stream-radio')
const sock = path.join(dir, 'mpv.sock')
const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(state, 'config'), HOME: state }

type Result = { exitCode: number; stdout: string; stderr: string }
const ok: Result = { exitCode: 0, stdout: '', stderr: '' }

let fake: Fake | undefined
let session: Session | undefined
let ran: string[][] = []

// Records every argv. Stands in for the system: `rm -f` removes the socket, and
// the detached start brings up a fake mpv on it; mpv itself never runs.
// `missing`: the player is not installed.
function recorder(missing = false) {
  return async (argv: readonly string[]): Promise<Result> => {
    ran.push([...argv])
    if (argv.includes('--version')) {
      if (missing) throw Object.assign(new Error('spawn mpv ENOENT'), { code: 'ENOENT' })
      return ok
    }
    if (argv[0] === 'rm') fs.rmSync(argv[2], { force: true })
    if (argv[0] === 'sh') fake = await fakeMpv(dir)
    return ok
  }
}

// A socket file nothing listens on (connecting gives ECONNREFUSED): its owner dies without cleaning up.
const orphanSocket = () => {
  const code = `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`
  spawnSync(process.execPath, ['-e', code])
  expect(fs.existsSync(sock)).toBe(true)
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 50))
  expect(cond()).toBe(true)
}

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
afterEach(async () => {
  session?.close()
  session = undefined
  await fake?.close()
  fake = undefined
  fs.rmSync(sock, { force: true })
  ran = []
})

describe('openSession', () => {
  test('attaches to a live player without starting one', async () => {
    fake = await fakeMpv(dir)
    session = await openSession([], { env, run: recorder() })
    await until(() => fake!.received.some(m => (m as { command: unknown[] }).command[0] === 'observe_property'))
    expect(ran.some(a => a.join(' ').includes('setsid'))).toBe(false)
  })

  test('a stale socket is removed and one detached mpv is started', async () => {
    orphanSocket()
    const music = fs.mkdtempSync(path.join(state, 'music-'))
    session = await openSession([music], { env, run: recorder() })
    await until(() => ran.some(a => a[0] === 'sh'))
    const rm = ran.findIndex(a => a.join(' ') === `rm -f ${sock}`)
    const starts = ran.filter(a => a.join(' ').includes('setsid'))
    expect(starts).toHaveLength(1)
    expect(ran.indexOf(starts[0])).toBeGreaterThan(rm)
    expect(rm).toBeGreaterThanOrEqual(0)
    expect(starts[0].slice(0, 3)).toEqual(['sh', '-c', expect.stringContaining('exec setsid -f "$@"')])
    expect(starts[0]).toContain(`--input-ipc-server=${sock}`)
    expect(starts[0]).toContain('mpv')
    expect(starts[0].at(-1)).toBe(music)
  })

  test('close sends no quit and no stop to mpv', async () => {
    fake = await fakeMpv(dir)
    session = await openSession([], { env, run: recorder() })
    await until(() => fake!.received.length > 0)
    session.close()
    await new Promise(r => setTimeout(r, 200))
    const sent = fake.received.map(m => (m as { command: unknown[] }).command[0])
    expect(sent).not.toContain('quit')
    expect(sent).not.toContain('stop')
  })

  test('a missing mpv shows in status and does not throw', async () => {
    orphanSocket()
    const music = fs.mkdtempSync(path.join(state, 'music-'))
    session = await openSession([music], { env, run: recorder(true) })
    await until(() => session!.status() !== '')
    expect(session.status()).toContain(`Can't start "mpv"`)
  })

  test('a path that does not exist shows in status', async () => {
    session = await openSession([path.join(state, 'nope')], { env, run: recorder() })
    expect(session.status()).toContain('No such file or folder')
    expect(ran.some(a => a.join(' ').includes('setsid'))).toBe(false)
  })
})

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { openSession, type Session } from '../src/session'
import { fakeMpv, type Fake } from './fake-mpv-socket'
import * as player from '@core/player'

// playSource is the real one, watched: the test asks what session.ts handed it.
vi.mock('@core/player', async original => {
  const real = await original<typeof import('@core/player')>()
  return { ...real, playSource: vi.fn(real.playSource) }
})

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
// the fake mpv a detached start is bringing up, so cleanup can wait for it
let starting: Promise<unknown> | undefined

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
    if (argv[0] === 'sh' && argv[2]?.includes('setsid')) fake = await (starting = fakeMpv(dir))
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
  vi.restoreAllMocks()
  await starting?.catch(() => undefined)
  starting = undefined
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
    fs.writeFileSync(path.join(music, 'a.flac'), '')
    session = await openSession([music], { env, run: recorder() })
    await until(() => fake !== undefined && fake.received.length > 0)
    const rm = ran.findIndex(a => a.join(' ') === `rm -f ${sock}`)
    const starts = ran.filter(a => a.join(' ').includes('setsid'))
    expect(starts).toHaveLength(1)
    expect(ran.indexOf(starts[0])).toBeGreaterThan(rm)
    expect(rm).toBeGreaterThanOrEqual(0)
    expect(starts[0].slice(0, 3)).toEqual(['sh', '-c', expect.stringContaining('exec setsid -f "$@"')])
    expect(starts[0]).toContain(`--input-ipc-server=${sock}`)
    expect(starts[0]).toContain('mpv')
    // the folder's songs became the queue, handed to mpv as a playlist file
    expect(starts[0].slice(-2)).toEqual(['--playlist-start=0', `--playlist=${path.join(dir, 'queue.m3u')}`])
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
    fs.writeFileSync(path.join(music, 'a.flac'), '')
    session = await openSession([music], { env, run: recorder(true) })
    await until(() => session!.status() !== '')
    expect(session.status()).toContain(`Can't start "mpv"`)
  })

  test('a play whose queue cannot be saved shows in status and does not throw', async () => {
    const music = fs.mkdtempSync(path.join(state, 'music-'))
    fs.writeFileSync(path.join(music, 'a.flac'), '')
    const rec = recorder()
    // the state folder refuses the move that saves the queue
    const run = async (argv: readonly string[]) => (argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'read-only' } : rec(argv))
    session = await openSession([music], { env, run })
    await until(() => session!.status() !== '')
    expect(session.status()).toContain(`Could not play ${music}`)
    expect(ran.some(a => a.join(' ').includes('setsid'))).toBe(false)
  })

  test('a path that does not exist shows in status', async () => {
    session = await openSession([path.join(state, 'nope')], { env, run: recorder() })
    expect(session.status()).toContain('No such file or folder')
    expect(session.statusSeq()).toBe(1)
    expect(ran.some(a => a.join(' ').includes('setsid'))).toBe(false)
  })

  test('a setup step that rejects shows in status; the session still closes', async () => {
    const broken = { ...env }
    Object.defineProperty(broken, 'XDG_CONFIG_HOME', {
      get() {
        throw new Error('config unreadable')
      },
    })
    session = await openSession([], { env: broken, run: recorder() })
    expect(session.status()).toContain('config unreadable')
    expect(() => session!.close()).not.toThrow()
  })

  test('close during a missing-mpv start leaves no timer armed', async () => {
    orphanSocket()
    const music = fs.mkdtempSync(path.join(state, 'music-'))
    let release!: () => void
    const gate = new Promise<void>(res => (release = res))
    const run = recorder(true)
    session = await openSession([music], {
      env,
      run: async argv => {
        if (argv.includes('--version')) await gate
        return run(argv)
      },
    })
    session.close()
    const spy = vi.spyOn(globalThis, 'setInterval')
    release()
    await new Promise(r => setTimeout(r, 300))
    expect(spy).not.toHaveBeenCalled()
    expect(session.status()).toBe('')
  })

  test('after close a watch on a live player ends at once and never reaches it', async () => {
    session = await openSession([], { env, run: recorder() })
    session.close()
    // A player that answers: an open watch would get its events.
    fake = await fakeMpv(dir)
    const watch = session.host.watch(sock, ['pause'])
    expect(await watch.next()).toEqual({ done: true, value: undefined })
    expect(fake.received).toEqual([])
  })

  test('an argument starts the queue with playSource, given that argument', async () => {
    orphanSocket()
    const music = fs.mkdtempSync(path.join(state, 'music-'))
    fs.writeFileSync(path.join(music, 'a.flac'), '')
    vi.mocked(player.playSource).mockClear()
    session = await openSession([music], { env, run: recorder() })
    await until(() => vi.mocked(player.playSource).mock.calls.length > 0)
    expect(player.playSource).toHaveBeenCalledTimes(1)
    expect(vi.mocked(player.playSource).mock.calls[0]![2]).toBe(music)
  })
})

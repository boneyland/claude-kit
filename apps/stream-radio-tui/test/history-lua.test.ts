// The history script in a real mpv, on a few seconds of silence: one mpv at a
// time (a file's tests run in turn; none is .concurrent), each killed with its
// process group.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { HISTORY_LUA } from '@core/history'

const has = (cmd: string) => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const hasMpv = has('mpv')

let dir = ''
let wav = ''
let long = ''
let script = ''

// `seconds` of silence as a WAV file: 8 kHz mono 16-bit, 16 kB a second.
function silence(seconds: number): Buffer {
  const data = 16_000 * seconds
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(16_000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(data, 40)
  return b
}

// mpv on a silent file (the 3 s one unless `file` is given); resolves when it exits, killed at 20 s. `during`
// runs once it has started (for the IPC seek).
async function play(args: string[], opts: string[], during?: (sock: string) => Promise<void>, file = wav) {
  const sock = join(dir, 'mpv.sock')
  const child = spawn(
    'mpv',
    [
      '--no-config',
      '--ao=null',
      '--no-video',
      '--idle=no',
      `--script=${script}`,
      `--script-opts=${['stream_radio_history-file=' + join(dir, 'h.jsonl'), ...opts].join(',')}`,
      ...(during ? [`--input-ipc-server=${sock}`] : []),
      ...args,
      file,
    ],
    { detached: true, stdio: 'ignore' },
  )
  const kill = setTimeout(() => child.pid && process.kill(-child.pid, 'SIGKILL'), 20_000)
  try {
    const done = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (during) await during(sock)
    await done
  } finally {
    clearTimeout(kill)
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

const lines = () => {
  const file = join(dir, 'h.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

// One command on mpv's socket: its reply, or undefined while nothing listens.
function ask(sock: string, command: unknown[]): Promise<{ data?: unknown; error?: string } | undefined> {
  return new Promise(resolve => {
    const c = connect(sock)
    let got = ''
    c.once('connect', () => c.write(JSON.stringify({ command, request_id: 1 }) + '\n'))
    c.on('data', d => {
      got += d
      for (const line of got.split('\n').slice(0, -1)) {
        const reply = JSON.parse(line)
        if (reply.request_id === 1) {
          c.destroy()
          resolve(reply)
        }
      }
      got = got.slice(got.lastIndexOf('\n') + 1)
    })
    c.once('error', () => resolve(undefined))
    c.once('close', () => resolve(undefined))
  })
}

// Waits until mpv has loaded the file (it knows its duration).
async function loaded(sock: string) {
  for (let i = 0; i < 250; i++) {
    if (typeof (await ask(sock, ['get_property', 'duration']))?.data === 'number') return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('mpv never loaded the file')
}

describe.skipIf(!hasMpv)('history.lua in mpv', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-lua-'))
    script = join(dir, 'history.lua')
    writeFileSync(script, HISTORY_LUA)
    wav = join(dir, 's.wav')
    writeFileSync(wav, silence(3))
    long = join(dir, 'long.wav')
    writeFileSync(long, silence(6))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const fresh = (text = '') => writeFileSync(join(dir, 'h.jsonl'), text)

  test('logs a play after min seconds', { timeout: 25_000 }, async () => {
    fresh()
    const before = Math.floor(Date.now() / 1000)
    await play([], ['stream_radio_history-min=1'])
    const got = lines().map(l => JSON.parse(l))
    expect(got).toHaveLength(1)
    expect(got[0].path).toBe(wav)
    expect(got[0].title).toBe('s.wav')
    expect(got[0].at).toBeGreaterThanOrEqual(before)
    expect(got[0].at).toBeLessThanOrEqual(before + 2)
    expect(got[0].duration).toBeCloseTo(3, 0)
    expect(got[0].artist).toBeUndefined()
  })

  test('short file logs at its end', { timeout: 25_000 }, async () => {
    fresh()
    await play([], ['stream_radio_history-min=10'])
    expect(lines()).toHaveLength(1)
  })

  test('repeat-one logs each loop', { timeout: 25_000 }, async () => {
    fresh()
    await play(['--loop-file=2'], ['stream_radio_history-min=1'])
    expect(lines()).toHaveLength(3)
  })

  test('seek does not count', { timeout: 25_000 }, async () => {
    fresh()
    // On the 6 s file, paused at the start until a seek to 4.5 s: past min,
    // with 1.5 s left to play, so a tick sees the position past min after
    // under min played.
    await play(
      ['--start=0', '--keep-open=no', '--pause'],
      ['stream_radio_history-min=2'],
      async sock => {
        await loaded(sock)
        expect((await ask(sock, ['seek', 4.5, 'absolute']))?.error).toBe('success')
        expect((await ask(sock, ['set_property', 'pause', false]))?.error).toBe('success')
      },
      long,
    )
    expect(lines()).toHaveLength(0)
  })

  test('cap keeps the last lines', { timeout: 25_000 }, async () => {
    fresh([1, 2, 3, 4, 5].map(n => JSON.stringify({ at: n, path: `/old/${n}`, title: `${n}` })).join('\n') + '\n')
    await play([], ['stream_radio_history-min=1', 'stream_radio_history-cap=5', 'stream_radio_history-keep=2'])
    const got = lines().map(l => JSON.parse(l))
    // 6 lines is past the cap of 5: the last 2 are kept, the new play last
    expect(got.map(p => p.path)).toEqual(['/old/5', wav])
  })
})

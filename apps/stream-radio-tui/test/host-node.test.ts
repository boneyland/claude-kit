import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nodeHost, memoryStore } from '../src/host-node'
import { splitEvents } from '@core/nowplaying'
import { fakeMpv, type Fake } from './fake-mpv-socket'

const events = { titleChanged: () => undefined, watching: () => undefined }
const host = () => nodeHost(events, memoryStore(() => undefined))
let fake: Fake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

describe('ipc', () => {
  test('returns the matching reply data', async () => {
    fake = await fakeMpv()
    expect(await host().ipc(fake.path, ['get_property', 'pid'])).toEqual({ data: 4242 })
  })
  test('an mpv error gives undefined', async () => {
    fake = await fakeMpv()
    expect(await host().ipc(fake.path, ['bad'])).toBeUndefined()
  })
  test('no listener gives undefined, quickly', async () => {
    const t = Date.now()
    expect(await host().ipc(path.join(os.tmpdir(), 'sr-nonexistent.sock'), ['x'])).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(3000)
  })
  test('a stale socket file gives undefined', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-stale-'))
    try {
      const p = path.join(dir, 'mpv.sock')
      const net = await import('node:net')
      const s = net.createServer().listen(p)
      await new Promise(r => s.once('listening', r))
      // closing a server unlinks the file; recreate a plain file in its place
      await new Promise(r => s.close(r))
      fs.writeFileSync(p, '')
      expect(await host().ipc(p, ['x'])).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('watch', () => {
  test('whole-second time-pos, boolean duration, deduplicated, then ends on close', async () => {
    fake = await fakeMpv()
    const w = host().watch(fake.path, ['time-pos', 'duration'])
    const first = w.next()
    // wait until it has subscribed
    while (fake.received.length < 2) await new Promise(r => setTimeout(r, 10))
    expect(fake.received).toEqual([
      { command: ['observe_property', 1, 'time-pos'] },
      { command: ['observe_property', 2, 'duration'] },
    ])
    fake.push(
      { event: 'idle' },
      { event: 'property-change', id: 1, name: 'time-pos', data: 12.7 },
      { event: 'property-change', id: 1, name: 'time-pos', data: 12.9 },
      { event: 'property-change', id: 1, name: 'time-pos', data: 13.1 },
      { event: 'property-change', id: 2, name: 'duration', data: 245.3 },
      { event: 'property-change', id: 2, name: 'duration', data: 246.3 },
      { event: 'file-loaded' },
    )
    fake.closeClients()
    let text = ''
    for (let s = await first; !s.done; s = await w.next()) text += s.value
    const { events: got, rest } = splitEvents(text)
    expect(rest).toBe('')
    expect(got).toEqual([
      { event: 'property-change', name: 'time-pos', data: 12 },
      { event: 'property-change', name: 'time-pos', data: 13 },
      { event: 'property-change', name: 'duration', data: true },
      { event: 'file-loaded' },
    ])
    expect(text.endsWith('\n')).toBe(true)
  })
  test('return() ends a pending next at once', async () => {
    fake = await fakeMpv()
    const w = host().watch(fake.path, ['pause'])
    const pending = w.next()
    while (fake.received.length < 1) await new Promise(r => setTimeout(r, 10))
    const t = Date.now()
    await w.return()
    expect((await pending).done).toBe(true)
    expect(Date.now() - t).toBeLessThan(500)
  })
  test('no listener ends the watch', async () => {
    const w = host().watch(path.join(os.tmpdir(), 'sr-nonexistent.sock'), ['pause'])
    expect((await w.next()).done).toBe(true)
  })
})

describe('run', () => {
  test('resolves a non-zero exit with its output', async () => {
    const r = await host().run(['sh', '-c', 'echo out; echo err >&2; exit 3'])
    expect(r).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
  })
  test('rejects when the binary is missing', async () => {
    await expect(host().run(['sr-no-such-binary', '--version'])).rejects.toThrow()
  })
  test('times out', async () => {
    const r = await host().run(['sleep', '5'], { timeoutMs: 100 })
    expect(r.exitCode).not.toBe(0)
  })
})

describe('memoryStore', () => {
  test('defaults, change and onChange', async () => {
    let n = 0
    const s = memoryStore(() => n++)
    expect(await s.read('volume')).toBe(60)
    expect(await s.read('repeat')).toBe('all')
    expect(await s.read('queue')).toMatchObject({ kind: 'none', current: -1 })
    expect(await s.change('volume', v => v + 5)).toBe(65)
    expect(await s.read('volume')).toBe(65)
    expect(n).toBe(1)
  })
  test('defaults are not shared between stores', async () => {
    const a = memoryStore(() => undefined)
    await a.change('openFolders', f => [...f, 'x'])
    expect(await memoryStore(() => undefined).read('openFolders')).toEqual([])
  })
})

describe('host', () => {
  test('basics', async () => {
    const h = host()
    expect(h.program).toBe('tui')
    expect(await h.dataDir()).toBe(
      process.env.XDG_STATE_HOME ? `${process.env.XDG_STATE_HOME}/stream-radio` : `${process.env.HOME}/.local/state/stream-radio`,
    )
    expect(await h.home()).toBe(process.env.HOME ?? '')
  })
})

describe('fs.list', () => {
  test('lists a folder with each entry\'s kind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-list-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.flac'), '')
      fs.mkdirSync(path.join(dir, 'Sub'))
      const list = await host().fs.list(dir)
      expect([...list].sort((x, y) => x.name.localeCompare(y.name))).toEqual([
        { name: 'a.flac', kind: 'file' },
        { name: 'Sub', kind: 'dir' },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

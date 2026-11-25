import { describe, expect, test } from 'vitest'
import { runMpv } from '../src/media/mpv-child'
import { fakeSpawn } from './fake-spawn'

describe('runMpv', () => {
  test('collects stdout and always skips the user config', async () => {
    const { spawn, children } = fakeSpawn(() => ({ chunks: ['ab', 'cd'], code: 0 }))
    const r = await runMpv(['x'], { timeoutMs: 1000, maxBytes: 10, spawn })
    expect(r).toEqual({ code: 0, stdout: Buffer.from('abcd') })
    expect(children[0].args[0]).toBe('--no-config')
    expect(children[0].cmd).toBe('mpv')
  })
  test('runs the player it is given', async () => {
    const { spawn, children } = fakeSpawn(() => ({ code: 0 }))
    await runMpv([], { timeoutMs: 1000, maxBytes: 10, spawn, player: '/opt/mpv/bin/mpv' })
    expect(children[0].cmd).toBe('/opt/mpv/bin/mpv')
  })
  test('more than maxBytes kills it', async () => {
    const { spawn, children } = fakeSpawn(() => ({ chunks: [Buffer.alloc(20)] }))
    await expect(runMpv([], { timeoutMs: 1000, maxBytes: 10, spawn })).rejects.toThrow(/bytes/)
    expect(children[0].isKilled).toBe(true)
  })
  test('a child that never ends is killed at the timeout', async () => {
    const { spawn, children } = fakeSpawn(() => ({}))
    await expect(runMpv([], { timeoutMs: 20, maxBytes: 10, spawn })).rejects.toThrow(/timed out/)
    expect(children[0].isKilled).toBe(true)
  })
  test('an abort kills it', async () => {
    const { spawn, children } = fakeSpawn(() => ({}))
    const ac = new AbortController()
    const run = runMpv([], { timeoutMs: 1000, maxBytes: 10, spawn, signal: ac.signal })
    ac.abort()
    await expect(run).rejects.toThrow(/abort/i)
    expect(children[0].isKilled).toBe(true)
  })
  test('with onData stdout is passed on, not kept', async () => {
    const { spawn } = fakeSpawn(() => ({ chunks: ['ab', 'cd'], code: 0 }))
    const seen: string[] = []
    const r = await runMpv([], { timeoutMs: 1000, maxBytes: Infinity, spawn, onData: c => seen.push(c.toString()) })
    expect(seen.join('')).toBe('abcd')
    expect(r.stdout.length).toBe(0)
  })
})

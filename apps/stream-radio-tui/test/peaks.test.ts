import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodePeaks, peakFolder, resample } from '../src/media/peaks'
import { fakeSpawn } from './fake-spawn'

// s16le bytes of `samples`
const pcm = (samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b
}

describe('peakFolder', () => {
  test('a bucket is its loudest sample, out of 255', () => {
    const f = peakFolder()
    f.add(pcm([0, 16384, -32768, ...Array(157).fill(0)]))
    expect([...f.done()]).toEqual([255])
  })
  test('a sample split across two chunks is joined', () => {
    const bytes = pcm([0, 16384, ...Array(158).fill(0)])
    const f = peakFolder()
    f.add(bytes.subarray(0, 3))
    f.add(bytes.subarray(3))
    expect([...f.done()]).toEqual([128])
  })
  test('a last partial bucket counts', () => {
    const f = peakFolder()
    f.add(pcm(Array(400).fill(100)))
    expect(f.done()).toHaveLength(3)
  })
  test('a long stream keeps only its peaks', () => {
    const f = peakFolder()
    const chunk = pcm(Array(500).fill(1000))
    for (let i = 0; i < 2000; i++) f.add(chunk)
    expect(f.done()).toHaveLength(6250)
  })
})

describe('resample', () => {
  test('each span keeps its loudest', () => {
    expect([...resample(new Uint8Array([1, 9, 3, 4, 5, 6]), 3)]).toEqual([9, 4, 6])
    expect([...resample(new Uint8Array([1, 9, 3]), 1)]).toEqual([9])
  })
  test('more spans than peaks repeats them', () => {
    expect([...resample(new Uint8Array([1, 9]), 4)]).toEqual([1, 1, 9, 9])
  })
})

describe('decodePeaks', () => {
  let dir: string
  let song: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-peaks-'))
    song = path.join(dir, 'song.flac')
    fs.writeFileSync(song, 'x')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('folds what mpv decodes, and asks for 8 kHz mono PCM', async () => {
    const { spawn, children } = fakeSpawn(() => ({ chunks: [pcm(Array(160).fill(32767)), pcm(Array(160).fill(0))], code: 0 }))
    expect([...(await decodePeaks(song, { spawn }))!]).toEqual([255, 0])
    const args = children[0].args
    // --o=- (the encoder writes fd 1 itself): mpv can't open /dev/stdout when Node's pipe is a socket
    expect(args).toEqual(expect.arrayContaining(['--no-config', '--o=-', '--of=s16le', '--oac=pcm_s16le', '--audio-samplerate=8000', '--audio-channels=mono', '--ytdl=no', song]))
    expect(args.some(a => a.startsWith('--ao'))).toBe(false)
  })
  test('a second time comes from the cache', async () => {
    const { spawn, children } = fakeSpawn(() => ({ chunks: [pcm(Array(160).fill(32767))], code: 0 }))
    const cache = path.join(dir, 'cache')
    await decodePeaks(song, { spawn, cache })
    expect([...(await decodePeaks(song, { spawn, cache }))!]).toEqual([255])
    expect(children).toHaveLength(1)
  })
  test('mpv failing gives nothing', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 2 }))
    expect(await decodePeaks(song, { spawn })).toBeUndefined()
  })
  test('an abort kills mpv and is passed on', async () => {
    const { spawn, children } = fakeSpawn(() => ({}))
    const ac = new AbortController()
    const run = decodePeaks(song, { spawn, signal: ac.signal })
    await new Promise(r => setTimeout(r, 10))
    ac.abort()
    await expect(run).rejects.toThrow(/abort/i)
    expect(children[0].isKilled).toBe(true)
  })
})

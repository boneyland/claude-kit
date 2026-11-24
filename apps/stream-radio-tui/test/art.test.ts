import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artSources, cutRows, fitArt, loadArt, youtubeId } from '../src/media/art'
import { fakeSpawn } from './fake-spawn'

describe('youtubeId', () => {
  test.each([
    ['https://www.youtube.com/watch?v=tRsQsTMvPNg', 'tRsQsTMvPNg'],
    ['https://youtu.be/tRsQsTMvPNg?t=3', 'tRsQsTMvPNg'],
    ['https://www.youtube.com/shorts/tRsQsTMvPNg', 'tRsQsTMvPNg'],
    ['https://www.youtube.com/live/tRsQsTMvPNg', 'tRsQsTMvPNg'],
    ['https://radio.example/stream.mp3', ''],
  ])('%s', (url, id) => expect(youtubeId(url)).toBe(id))
})

describe('artSources', () => {
  const readdir = (async () => ['Folder.JPG', 'notes.txt', 'cover.png']) as unknown as typeof fs.promises.readdir
  test('a song: its own art first, then a cover in its folder (cover before folder)', async () => {
    expect(await artSources({ file: '/m/A/01.flac' }, readdir)).toEqual([
      { kind: 'file', path: '/m/A/01.flac' },
      { kind: 'file', path: '/m/A/cover.png' },
    ])
  })
  test('no cover in the folder: only the song', async () => {
    const none = (async () => ['x.txt']) as unknown as typeof fs.promises.readdir
    expect(await artSources({ file: '/m/A/01.flac' }, none)).toEqual([{ kind: 'file', path: '/m/A/01.flac' }])
  })
  test('a YouTube video: its thumbnail', async () => {
    expect(await artSources({ url: 'https://youtu.be/tRsQsTMvPNg' }, readdir)).toEqual([{ kind: 'url', url: 'https://i.ytimg.com/vi/tRsQsTMvPNg/mqdefault.jpg' }])
  })
  test('a radio stream: nothing', async () => {
    expect(await artSources({ url: 'https://radio.example/stream.mp3' }, readdir)).toEqual([])
  })
})

describe('fitArt', () => {
  const cell = { width: 8, height: 16 }
  test('a wide picture fills the width', () => {
    expect(fitArt({ width: 800, height: 450 }, 40, 30, cell)).toEqual({ cols: 40, rows: 11 })
  })
  test('a tall picture fills the height', () => {
    expect(fitArt({ width: 450, height: 800 }, 40, 30, cell)).toEqual({ cols: 33, rows: 30 })
  })
  test('never nothing', () => {
    expect(fitArt({ width: 4000, height: 10 }, 3, 2, cell)).toEqual({ cols: 3, rows: 1 })
  })
})

describe('cutRows', () => {
  test('strips cover the picture top to bottom', () => {
    const rgba = new Uint8Array(2 * 5 * 4).map((_, i) => i)
    const strips = cutRows({ width: 2, height: 5, rgba }, 2)
    expect(strips.map(s => s.height)).toEqual([2, 3])
    expect([...strips[0].rgba]).toEqual([...rgba.subarray(0, 16)])
    expect([...strips[1].rgba]).toEqual([...rgba.subarray(16)])
  })
})

describe('loadArt', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-art-'))
    for (const f of ['song.flac', 'cover.jpg']) fs.writeFileSync(path.join(dir, f), 'x')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sources = () => [
    { kind: 'file' as const, path: path.join(dir, 'song.flac') },
    { kind: 'file' as const, path: path.join(dir, 'cover.jpg') },
  ]

  test('skips a source without art, scales the next to 600 at most', async () => {
    const { spawn, children } = fakeSpawn(args => {
      const isSong = args.at(-1)!.endsWith('song.flac')
      if (args.includes('--vo=null')) return isSong ? { code: 2 } : { chunks: ['● Image\nSIZE 1200 600\n'], code: 0 }
      return { chunks: [Buffer.alloc(600 * 300 * 4)], code: 0 }
    })
    const art = await loadArt(sources(), { spawn })
    expect(art && { width: art.width, height: art.height, bytes: art.rgba.length }).toEqual({ width: 600, height: 300, bytes: 600 * 300 * 4 })
    expect(children.at(-1)!.args).toEqual(expect.arrayContaining(['--vf=scale=w=600:h=300,format=rgba', '--o=-', '--ytdl=no']))
  })
  test('too few bytes back is no art', async () => {
    const { spawn } = fakeSpawn(args => (args.includes('--vo=null') ? { chunks: ['SIZE 100 100\n'], code: 0 } : { chunks: [Buffer.alloc(10)], code: 0 }))
    expect(await loadArt(sources(), { spawn })).toBeUndefined()
  })
  test('a second time comes from the cache', async () => {
    const { spawn, children } = fakeSpawn(args => (args.includes('--vo=null') ? { chunks: ['SIZE 10 4\n'], code: 0 } : { chunks: [Buffer.alloc(10 * 4 * 4, 7)], code: 0 }))
    const cache = path.join(dir, 'cache')
    await loadArt(sources(), { spawn, cache })
    const again = await loadArt(sources(), { spawn, cache })
    expect(again && [again.width, again.height, again.rgba[0]]).toEqual([10, 4, 7])
    expect(children).toHaveLength(2)
  })
  test('a broken picture moves on instead of throwing', async () => {
    const { spawn } = fakeSpawn(args => (args.includes('--vo=null') ? { chunks: ['SIZE 10 4\n'], code: 0 } : { code: 1 }))
    expect(await loadArt(sources(), { spawn })).toBeUndefined()
  })
})

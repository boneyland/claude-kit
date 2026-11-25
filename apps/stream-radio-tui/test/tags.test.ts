import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTags, tagReader, type Tags } from '../src/media/tags'

const tags = (title: string): Tags => ({ title, artist: '', albumArtist: '', album: '' })
const EMPTY = tags('')

// A read that waits until the test lets it go, counting what runs at once.
function gatedRead() {
  const calls: string[] = []
  const waiting: (() => void)[] = []
  let running = 0
  let most = 0
  const read = (p: string) => {
    calls.push(p)
    running++
    most = Math.max(most, running)
    return new Promise<Tags>(resolve =>
      waiting.push(() => {
        running--
        resolve(tags(`T:${p}`))
      }),
    )
  }
  const releaseAll = async () => {
    while (waiting.length) {
      waiting.splice(0).forEach(go => go())
      await new Promise(r => setTimeout(r, 0))
    }
  }
  return { read, calls, releaseAll, most: () => most }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('tagReader', () => {
  test('a path wanted twice is read once', async () => {
    const g = gatedRead()
    const r = tagReader(g.read)
    r.want([{ path: '/m/a.mp3', mtimeMs: 1 }], () => {})
    r.want([{ path: '/m/a.mp3', mtimeMs: 1 }], () => {})
    await g.releaseAll()
    r.want([{ path: '/m/a.mp3', mtimeMs: 1 }], () => {})
    await g.releaseAll()
    expect(g.calls).toEqual(['/m/a.mp3'])
    r.stop()
  })

  test('get answers from the cache only for the same mtime', async () => {
    const g = gatedRead()
    const r = tagReader(g.read)
    expect(r.get('/m/a.mp3', 1)).toBeUndefined()
    r.want([{ path: '/m/a.mp3', mtimeMs: 1 }], () => {})
    await g.releaseAll()
    expect(r.get('/m/a.mp3', 1)).toEqual(tags('T:/m/a.mp3'))
    expect(r.get('/m/a.mp3', 2)).toBeUndefined()
    // a changed file is read again
    r.want([{ path: '/m/a.mp3', mtimeMs: 2 }], () => {})
    await g.releaseAll()
    expect(g.calls).toEqual(['/m/a.mp3', '/m/a.mp3'])
    r.stop()
  })

  test('no more than 4 reads run at once', async () => {
    const g = gatedRead()
    const r = tagReader(g.read)
    r.want(Array.from({ length: 10 }, (_, i) => ({ path: `/m/${i}.mp3`, mtimeMs: 1 })), () => {})
    await settle()
    expect(g.calls.length).toBe(4)
    await g.releaseAll()
    expect(g.calls.length).toBe(10)
    expect(g.most()).toBe(4)
    r.stop()
  })

  test('the newest request is read first', async () => {
    const g = gatedRead()
    const r = tagReader(g.read, 1)
    r.want([{ path: '/m/a', mtimeMs: 1 }, { path: '/m/b', mtimeMs: 1 }], () => {})
    r.want([{ path: '/m/c', mtimeMs: 1 }, { path: '/m/d', mtimeMs: 1 }], () => {})
    await g.releaseAll()
    // a was already being read; then the newest batch in its own order, then the rest
    expect(g.calls).toEqual(['/m/a', '/m/c', '/m/d', '/m/b'])
    r.stop()
  })

  test('a read that throws caches empty tags', async () => {
    const r = tagReader(async () => {
      throw new Error('bad file')
    })
    r.want([{ path: '/m/bad.mp3', mtimeMs: 1 }], () => {})
    await settle()
    await settle()
    expect(r.get('/m/bad.mp3', 1)).toEqual(EMPTY)
    r.stop()
  })

  test('onTags is called, at most once per 100 ms', async () => {
    const g = gatedRead()
    const r = tagReader(g.read)
    let n = 0
    r.want(Array.from({ length: 8 }, (_, i) => ({ path: `/m/${i}`, mtimeMs: 1 })), () => n++)
    await g.releaseAll()
    expect(n).toBe(1)
    await new Promise(r => setTimeout(r, 150))
    expect(n).toBe(2)
    r.stop()
  })

  test('after stop nothing more is read and onTags is not called', async () => {
    const g = gatedRead()
    const r = tagReader(g.read, 1)
    let n = 0
    r.want([{ path: '/m/a', mtimeMs: 1 }, { path: '/m/b', mtimeMs: 1 }], () => n++)
    r.stop()
    await g.releaseAll()
    await new Promise(r => setTimeout(r, 150))
    expect(g.calls).toEqual(['/m/a'])
    expect(n).toBe(0)
  })
})

describe('readTags (music-metadata)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-tags-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  // An ID3v2.3 tag holding one TIT2 (title) frame, then padding.
  function id3Title(title: string): Buffer {
    const text = Buffer.concat([Buffer.from([0]), Buffer.from(title, 'latin1')])
    const frameHead = Buffer.alloc(10)
    frameHead.write('TIT2', 0, 'latin1')
    frameHead.writeUInt32BE(text.length, 4)
    const body = Buffer.concat([frameHead, text, Buffer.alloc(32)])
    const size = body.length
    const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
    return Buffer.concat([head, body])
  }

  test('reads the title of a tagged file', async () => {
    const file = path.join(dir, 'song.mp3')
    fs.writeFileSync(file, id3Title('Hello There'))
    expect((await readTags(file)).title).toBe('Hello There')
  })

  test('a file with no tags gives empty strings', async () => {
    const file = path.join(dir, 'blank.mp3')
    fs.writeFileSync(file, Buffer.alloc(64))
    expect(await readTags(file).catch(() => EMPTY)).toEqual(EMPTY)
  })

  test('it keeps at most `most` files, the least recently used going first', async () => {
    const g = gatedRead()
    const r = tagReader(g.read, 4, 2)
    const want = (path: string) => r.want([{ path, mtimeMs: 1 }], () => {})
    want('/a.mp3')
    want('/b.mp3')
    await g.releaseAll()
    // a get is a use: /b.mp3 is now the least recently used
    expect(r.get('/a.mp3', 1)).toBeDefined()
    want('/c.mp3')
    await g.releaseAll()
    expect(r.get('/a.mp3', 1)).toBeDefined()
    expect(r.get('/b.mp3', 1)).toBeUndefined()
    expect(r.get('/c.mp3', 1)).toBeDefined()
    r.stop()
  })
})

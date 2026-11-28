import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keepPruned, pruneCache, readCache } from '../src/media/cache'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cache-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// a `size`-byte file last used `ageS` seconds ago
const put = (name: string, size: number, ageS: number) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(size))
  const t = Date.now() / 1000 - ageS
  fs.utimesSync(p, t, t)
}

describe('pruneCache', () => {
  test('the least recently used files go until the rest fit', async () => {
    put('old', 400, 300)
    put('mid', 400, 200)
    put('new', 400, 100)
    await pruneCache(dir, 900)
    expect(fs.readdirSync(dir).sort()).toEqual(['mid', 'new'])
  })
  test('under the limit nothing goes', async () => {
    put('a', 100, 10)
    await pruneCache(dir, 900)
    expect(fs.readdirSync(dir)).toEqual(['a'])
  })
  test('a missing folder is no error', async () => {
    await expect(pruneCache(path.join(dir, 'nope'), 10)).resolves.toBeUndefined()
  })
  test('reading a file counts as using it, so it outlives older ones', async () => {
    put('read-me', 400, 300)
    put('other', 400, 200)
    await readCache(dir, 'read-me')
    await pruneCache(dir, 500)
    expect(fs.readdirSync(dir)).toEqual(['read-me'])
  })
})

describe('keepPruned', () => {
  test('prunes again every so often, until stopped', async () => {
    const stop = keepPruned(dir, 20, 500)
    put('old', 400, 300)
    put('new', 400, 100)
    await new Promise(r => setTimeout(r, 80))
    expect(fs.readdirSync(dir)).toEqual(['new'])
    await stop()
    put('older', 400, 400)
    await new Promise(r => setTimeout(r, 80))
    expect(fs.readdirSync(dir).sort()).toEqual(['new', 'older'])
  })
  test('stop waits for a prune still running, so none deletes after it', async () => {
    put('old', 400, 300)
    put('new', 400, 100)
    const stop = keepPruned(dir, 60_000, 500)
    await stop()
    expect(fs.readdirSync(dir)).toEqual(['new'])
  })
})

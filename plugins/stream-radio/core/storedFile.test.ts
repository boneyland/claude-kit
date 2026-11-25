import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { addEntries, EMPTY_QUEUE, parseStored } from './stored'
import { backUpAndEmpty, QUEUE_LOCK_STALE_MS, readPlace, readStored, restorePrev, updateStored, withFileLock, writePlace } from './storedFile'

const D = '/data'
const LOCK = `${D}/queue.lock`

// A Host over files in memory with a fake clock: sleep moves the clock. run
// does mkdir, mv -f, rm -f and the noclobber create of the lock.
function hostOf(files: Record<string, string> = {}) {
  const clock = { now: 1_000_000 }
  const mtimes: Record<string, number> = {}
  for (const p of Object.keys(files)) mtimes[p] = clock.now
  const writes: string[] = []
  const h = {
    dataDir: async () => D,
    now: async () => clock.now,
    sleep: async (ms: number) => void (clock.now += ms),
    log: () => undefined,
    run: async (argv: readonly string[]) => {
      const ok = { exitCode: 0, stdout: '', stderr: '' }
      if (argv[0] === 'rm') delete files[argv[2]!]
      else if (argv[0] === 'mv') {
        files[argv[3]!] = files[argv[2]!]!
        mtimes[argv[3]!] = clock.now
        delete files[argv[2]!]
      } else if (argv[0] === 'sh') {
        const path = argv[5]!
        if (path in files) return { exitCode: 1, stdout: '', stderr: 'exists' }
        files[path] = argv[4]!
        mtimes[path] = clock.now
      }
      return ok
    },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`)
        return files[path]!
      },
      write: async (path: string, text: string) => {
        files[path] = text
        mtimes[path] = clock.now
        writes.push(path)
      },
      stat: async (path: string) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`)
        return { kind: 'file', mtimeMs: mtimes[path]! }
      },
    },
  } as unknown as Host
  return { h, files, clock, mtimes, writes }
}

const add = (path: string) => (q: typeof EMPTY_QUEUE) => addEntries(q, [{ path }], 'end', null)

test('two updates under the lock both land', async () => {
  const { h, files } = hostOf()
  await Promise.all([updateStored(h, add('/a.mp3')), updateStored(h, add('/b.mp3'))])
  const q = parseStored(files[`${D}/queue.json`]!)
  expect(q.entries.map(e => e.path).sort()).toEqual(['/a.mp3', '/b.mp3'])
  expect(q.rev).toBe(2)
  expect(LOCK in files).toBe(false)
})

test('a stale lock is taken over; a fresh one gives busy', async () => {
  const stale = hostOf({ [LOCK]: 'x' })
  stale.mtimes[LOCK] = stale.clock.now - (QUEUE_LOCK_STALE_MS + 1000)
  expect((await updateStored(stale.h, add('/a.mp3')) as { rev: number }).rev).toBe(1)

  const fresh = hostOf({ [LOCK]: 'x' })
  const start = fresh.clock.now
  expect(await updateStored(fresh.h, add('/a.mp3'))).toBe('busy')
  expect(fresh.clock.now - start).toBeGreaterThanOrEqual(2000)
  expect(`${D}/queue.json` in fresh.files).toBe(false)
  expect(LOCK in fresh.files).toBe(true)
})

test('the lock is released when the work throws', async () => {
  const { h, files } = hostOf()
  await expect(withFileLock(h, LOCK, 1000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(LOCK in files).toBe(false)
})

test('an edit over a broken file writes a valid one', async () => {
  const { h, files } = hostOf({ [`${D}/queue.json`]: '{"entries":[{' })
  expect(await readStored(h)).toEqual(EMPTY_QUEUE)
  await updateStored(h, add('/a.mp3'))
  const q = parseStored(files[`${D}/queue.json`]!)
  expect(q.entries).toHaveLength(1)
  expect(q.rev).toBe(1)
})

test('an update that changes nothing writes nothing', async () => {
  const { h, writes } = hostOf()
  expect(await updateStored(h, q => q)).toEqual(EMPTY_QUEUE)
  expect(writes).toEqual([])
})

test('place writes never bump rev, and an unchanged place is not rewritten', async () => {
  const { h, files, writes } = hostOf()
  await updateStored(h, add('/a.mp3'))
  const before = files[`${D}/queue.json`]
  const place = { rev: 1, current: 'x', seconds: 12 }
  await writePlace(h, place)
  expect(await readPlace(h)).toEqual(place)
  const n = writes.length
  await writePlace(h, { ...place })
  expect(writes.length).toBe(n)
  await writePlace(h, { ...place, seconds: 20 })
  expect(writes.length).toBe(n + 1)
  expect(files[`${D}/queue.json`]).toBe(before)
})

test('backUpAndEmpty then restorePrev gives the same entries back', async () => {
  const { h } = hostOf()
  expect(await restorePrev(h)).toBe(false)
  await updateStored(h, add('/a.mp3'))
  await updateStored(h, add('/b.mp3'))
  const was = await readStored(h)
  await backUpAndEmpty(h)
  const empty = await readStored(h)
  expect(empty.entries).toEqual([])
  expect(empty.rev).toBe(was.rev + 1)
  expect(await restorePrev(h)).toBe(true)
  const back = await readStored(h)
  expect(back.entries).toEqual(was.entries)
  expect(back.rev).toBeGreaterThan(empty.rev)
})

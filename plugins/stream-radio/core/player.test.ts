import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { entryName, paths, resumeQueue, playQueue } from './player'

// Only dataDir and run are used: the rest of the Host is never reached.
const ran: string[][] = []
const hostIn = (dir: string) =>
  ({ dataDir: async () => dir, run: async (argv: string[]) => (ran.push(argv), { exitCode: 0, stdout: '', stderr: '' }) }) as unknown as Host

test('a data folder not known yet is asked for again, not kept as the root', async () => {
  expect((await paths(hostIn(''))).sock).toBe('/mpv.sock')
  expect(ran).toEqual([])
  expect(await paths(hostIn('/data'))).toEqual({
    sock: '/data/mpv.sock',
    intent: '/data/player.json',
    lock: '/data/reconnect.lock',
    log: '/data/mpv.log',
    state: '/data/state.json',
    queue: '/data/queue.m3u',
    queueJson: '/data/queue.json',
    place: '/data/queue-place.json',
    prev: '/data/queue.prev.json',
    queueLock: '/data/queue.lock',
  })
  // Once known it is kept, and made once.
  expect((await paths(hostIn('/elsewhere'))).sock).toBe('/data/mpv.sock')
  expect(ran).toEqual([['mkdir', '-p', '/data']])
})

test('queue names come without control characters', async () => {
  const h = {} as Host
  expect(await entryName(h, { title: 'Song\x1b]52;c;eA==\x07' }, '')).toBe('Song]52;c;eA==')
  expect(await entryName(h, { filename: 'https://x.test/a\x1b[2Jb.mp3' }, '')).toBe('a[2Jb.mp3')
})

// Files in memory under /data (paths keeps the first data folder it learns),
// a clock that sleep moves, and run doing the lock, mv -f and rm -f.
function filesHost(files: Record<string, string>) {
  const clock = { now: 1_000_000 }
  const mtimes: Record<string, number> = {}
  return {
    clock,
    mtimes,
    h: {
      dataDir: async () => '/data',
      now: async () => clock.now,
      sleep: async (ms: number) => void (clock.now += ms),
      log: () => undefined,
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'sh') {
          if (argv[5]! in files) return { exitCode: 1, stdout: '', stderr: 'exists' }
          files[argv[5]!] = argv[4]!
          mtimes[argv[5]!] = clock.now
        } else if (argv[0] === 'rm') delete files[argv.at(-1)!]
        else if (argv[0] === 'mv') {
          files[argv[3]!] = files[argv[2]!]!
          delete files[argv[2]!]
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      fs: {
        read: async (p: string) => {
          if (!(p in files)) throw new Error(`ENOENT: ${p}`)
          return files[p]!
        },
        write: async (p: string, text: string) => void (files[p] = text),
        stat: async (p: string) => {
          if (!(p in files)) throw new Error(`ENOENT: ${p}`)
          return { kind: 'file', mtimeMs: mtimes[p] ?? clock.now }
        },
        exists: async (p: string) => p in files,
      },
    } as unknown as Host,
  }
}

test('l and ▶ on an empty queue say the queue is busy, not play the default over the cleared one', async () => {
  const prev = { version: 1, rev: 3, entries: [{ id: '3.0', path: '/m/a.mp3' }], arrangement: { kind: 'none' }, root: '', source: '/m' }
  const files: Record<string, string> = {
    '/data/queue.json': JSON.stringify({ ...prev, rev: 4, entries: [] }),
    '/data/queue.prev.json': JSON.stringify(prev),
    '/data/queue.lock': 'held',
  }
  const { h, clock, mtimes } = filesHost(files)
  const config = { volume: 60, player: 'mpv', androidClient: false }
  for (const play of [resumeQueue, playQueue]) {
    mtimes['/data/queue.lock'] = clock.now
    expect(await play(h, config, 'https://example.com/default')).toBe('The queue is busy; try again.')
    expect(JSON.parse(files['/data/queue.json']!).entries).toEqual([])
  }
})

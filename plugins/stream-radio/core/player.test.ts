import { expect, test } from 'claude-code/testing'

import { HISTORY_LUA, installHistoryScript } from './history'
import type { Host } from './host'
import { MAX_SONGS } from './paths'
import { entryName, paths, playEntries, resumeQueue, playQueue } from './player'

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
    history: '/data/history.jsonl',
    historyLua: '/data/history.lua',
    libraryLock: '/data/library.lock',
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
      libraryDir: async () => '/lib',
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

test('playEntries starts at the given entry', async () => {
  const files: Record<string, string> = {}
  const { h } = filesHost(files)
  const config = { volume: 60, player: 'mpv', androidClient: false }
  const entries = [{ path: '/m/a.mp3' }, { path: '/m/b.mp3' }, { path: '/m/c.mp3' }]
  await playEntries(h, config, entries, 'Road', 1).catch(() => undefined)
  const q = JSON.parse(files['/data/queue.json']!)
  expect(q.entries.map((e: { path: string }) => e.path)).toEqual(['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'])
  expect(q.source).toBe('Road')
  const place = JSON.parse(files['/data/queue-place.json']!)
  expect(place.current).toBe(q.entries[1].id)
})

// A host that gets launch() as far as starting mpv: the vars it reads, no
// player answering on the socket, and run() reporting the `sh -c … setsid` argv.
function launchHost(files: Record<string, string>, failWrite?: string) {
  const { h } = filesHost(files)
  const vars: Record<string, unknown> = {
    repeat: 'off',
    volume: 60,
    lastUrl: '',
    resumeAt: { url: '', index: -1, seconds: -1, title: '' },
    queue: { kind: 'none', items: [], current: -1, paths: [], root: '' },
  }
  let started: (argv: readonly string[]) => void = () => undefined
  const launched = new Promise<readonly string[]>(resolve => (started = resolve))
  const run = h.run.bind(h)
  const write = h.fs.write.bind(h.fs)
  Object.assign(h, {
    vars: {
      read: async (k: string) => vars[k],
      change: async (k: string, fn: (prev: unknown) => unknown) => (vars[k] = fn(vars[k])),
    },
    events: { titleChanged: () => undefined, watching: () => undefined },
    toast: () => undefined,
    ipc: async () => undefined,
    every: () => ({ cancel: () => undefined }),
    run: async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
      if (argv[0] === 'sh' && String(argv[2]).includes('setsid')) {
        started(argv)
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return run(argv, opts)
    },
  })
  Object.assign(h.fs, {
    write: async (p: string, text: string) => {
      if (failWrite && p.startsWith(failWrite)) throw new Error('EACCES')
      return write(p, text)
    },
  })
  return { h, launched }
}

test('playEntries keeps at most MAX_SONGS and says it cut', async () => {
  const files: Record<string, string> = {}
  const { h } = launchHost(files)
  const config = { volume: 60, player: 'mpv', androidClient: false }
  const entries = Array.from({ length: MAX_SONGS + 5 }, (_, i) => ({ path: `/m/${i}.mp3` }))
  const said = await playEntries(h, config, entries, 'Big', 0)
  expect(JSON.parse(files['/data/queue.json']!).entries).toHaveLength(MAX_SONGS)
  expect(said).toBe(`Played the first ${MAX_SONGS} songs.`)
})

const firstOf = <T>(p: Promise<T>) => Promise.race([p, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000))])

test('launch passes the history script', async () => {
  const config = { volume: 60, player: 'mpv', androidClient: false }
  const files: Record<string, string> = {}
  const { h, launched } = launchHost(files)
  await playEntries(h, config, [{ path: '/m/a.mp3' }], '', 0)
  const argv = await firstOf(launched)
  expect(argv).toContain('--script=/data/history.lua')
  expect(argv).toContain('--script-opts-append=stream_radio_history-file=/data/history.jsonl')
  expect(files['/data/history.lua']).toContain('stream_radio_history')
})

test('launch starts mpv without the history script when it cannot be written', async () => {
  const config = { volume: 60, player: 'mpv', androidClient: false }
  const files: Record<string, string> = {}
  const { h, launched } = launchHost(files, '/data/history.lua')
  await playEntries(h, config, [{ path: '/m/a.mp3' }], '', 0)
  const argv = await firstOf(launched)
  expect(argv).toBeDefined()
  expect(argv!.some(a => a.startsWith('--script'))).toBe(false)
})

test('the history script is written only when it differs', async () => {
  const files: Record<string, string> = {}
  const { h } = filesHost(files)
  let writes = 0
  const write = h.fs.write.bind(h.fs)
  Object.assign(h.fs, { write: async (p: string, text: string) => (writes++, write(p, text)) })
  expect(await installHistoryScript(h)).toBe('/data/history.lua')
  expect(files['/data/history.lua']).toBe(HISTORY_LUA)
  expect(writes).toBe(1)
  expect(await installHistoryScript(h)).toBe('/data/history.lua')
  expect(writes).toBe(1)
  files['/data/history.lua'] = 'old'
  expect(await installHistoryScript(h)).toBe('/data/history.lua')
  expect(writes).toBe(2)
  expect(files['/data/history.lua']).toBe(HISTORY_LUA)
})

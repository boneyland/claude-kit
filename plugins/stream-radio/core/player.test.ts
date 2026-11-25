import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { entryName, paths } from './player'

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

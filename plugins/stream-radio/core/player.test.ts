import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { paths } from './player'

// Only dataDir is read: the rest of the Host is never reached.
const hostIn = (dir: string) => ({ dataDir: async () => dir }) as unknown as Host

test('a data folder not known yet is asked for again, not kept as the root', async () => {
  expect((await paths(hostIn(''))).sock).toBe('/mpv.sock')
  expect(await paths(hostIn('/data'))).toEqual({
    sock: '/data/mpv.sock',
    intent: '/data/player.json',
    lock: '/data/reconnect.lock',
    log: '/data/mpv.log',
  })
  // Once known it is kept.
  expect((await paths(hostIn('/elsewhere'))).sock).toBe('/data/mpv.sock')
})

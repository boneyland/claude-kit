import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { isPlayable, listSongs, stateDir } from './paths'

const envOf = (vars: Record<string, string>) => async (name: string) => vars[name]

test('XDG_STATE_HOME holds the folder when set', async () => {
  expect(await stateDir(envOf({ XDG_STATE_HOME: '/x', HOME: '/h' }))).toBe('/x/stream-radio')
})

test('without it the folder is under HOME/.local/state', async () => {
  expect(await stateDir(envOf({ HOME: '/h' }))).toBe('/h/.local/state/stream-radio')
  expect(await stateDir(envOf({ XDG_STATE_HOME: '', HOME: '/h' }))).toBe('/h/.local/state/stream-radio')
})

test('with neither it is empty, so the core asks again later', async () => {
  expect(await stateDir(envOf({}))).toBe('')
  expect(await stateDir(envOf({ HOME: '' }))).toBe('')
})

test('playable: the sound, video and playlist files mpv plays, any case; no dotfiles', () => {
  for (const name of ['a.flac', 'B.MP3', 'x.m3u', 'v.mkv', 'c.opus']) expect([name, isPlayable(name)]).toEqual([name, true])
  for (const name of ['cover.jpg', 'notes.txt', '.hidden.mp3', 'noext']) expect([name, isPlayable(name)]).toEqual([name, false])
})

test("a folder's songs, through its subfolders, in name order with numbers counted", async () => {
  const tree: Record<string, { name: string; kind: 'file' | 'dir' | 'other' }[]> = {
    '/m': [
      { name: 'b.flac', kind: 'file' },
      { name: 'A', kind: 'dir' },
      { name: 'cover.jpg', kind: 'file' },
      { name: '.git', kind: 'dir' },
    ],
    '/m/A': [
      { name: '2.mp3', kind: 'file' },
      { name: '10.mp3', kind: 'file' },
    ],
  }
  const h = { fs: { list: async (path: string) => tree[path] ?? [] } } as unknown as Host
  expect(await listSongs(h, '/m')).toEqual(['/m/A/2.mp3', '/m/A/10.mp3', '/m/b.flac'])
})

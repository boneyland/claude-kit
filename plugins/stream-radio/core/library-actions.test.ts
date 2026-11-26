import { expect, test } from 'claude-code/testing'

import type { Host } from './host'
import { FAVOURITES } from './library'
import { addTo, historyText, playList, playingSong, removeFrom, toggleFavourite } from './library-actions'

const LIB = '/lib'
const queueJson = (es: { id: string; path: string; title?: string }[]) =>
  JSON.stringify({ version: 1, rev: 1, entries: es, arrangement: { kind: 'none' }, root: '', source: '' })

function hostOf(files: Record<string, string> = {}, playing = '') {
  const clock = { now: 1_000_000 }
  const h = {
    dataDir: async () => '/data',
    libraryDir: async () => LIB,
    home: async () => '/h',
    now: async () => clock.now,
    sleep: async (ms: number) => void (clock.now += ms),
    log: () => undefined,
    vars: { read: async () => playing },
    run: async (argv: readonly string[]) => {
      if (argv[0] === 'rm') delete files[argv.at(-1)!]
      else if (argv[0] === 'mv') {
        files[argv.at(-1)!] = files[argv.at(-2)!]!
        delete files[argv.at(-2)!]
      } else if (argv[0] === 'sh') {
        if (argv[5]! in files) return { exitCode: 1, stdout: '', stderr: 'exists' }
        files[argv[5]!] = argv[4]!
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    fs: {
      exists: async (p: string) => p in files,
      read: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return files[p]!
      },
      write: async (p: string, text: string) => void (files[p] = text),
      stat: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return { kind: 'file', mtimeMs: 1 }
      },
      list: async (p: string) =>
        Object.keys(files)
          .filter(f => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/'))
          .map(f => ({ name: f.slice(p.length + 1), kind: 'file' as const })),
    },
  } as unknown as Host
  return { h, files }
}

const song = { path: '/h/M/a.mp3', title: 'A' }

test('playingSong: the place picks, the first is the fallback, empty is undefined', async () => {
  const q = [{ id: '1.0', path: '/m/a.mp3' }, { id: '1.1', path: '/m/b.mp3', title: 'B' }, { id: '1.2', path: 'https://x/y' }]
  const { h, files } = hostOf({}, 'Now')
  expect(await playingSong(h)).toBeUndefined()
  files['/data/queue.json'] = queueJson(q)
  expect(await playingSong(h)).toEqual({ path: '/m/a.mp3' })
  files['/data/queue-place.json'] = JSON.stringify({ rev: 1, current: '1.1', seconds: 3 })
  expect(await playingSong(h)).toEqual({ path: '/m/b.mp3', title: 'B' })
  files['/data/queue-place.json'] = JSON.stringify({ rev: 1, current: '1.2', seconds: 3 })
  expect(await playingSong(h)).toEqual({ path: 'https://x/y', title: 'Now' })
})

test('favourite toggles', async () => {
  const { h, files } = hostOf()
  expect(await toggleFavourite(h, [song])).toBe('Added to ★ Favourites.')
  expect(files[`${LIB}/${FAVOURITES}.m3u`]).toContain('/h/M/a.mp3')
  expect(await toggleFavourite(h, [song])).toBe('Removed from ★ Favourites.')
  expect(files[`${LIB}/${FAVOURITES}.m3u`]).not.toContain('a.mp3')
  expect(await toggleFavourite(h, [])).toBe('Nothing playing.')
})

test('add and remove say what happened', async () => {
  const { h } = hostOf({ [`${LIB}/Road trip.m3u`]: '#EXTM3U\n' })
  expect(await addTo(h, 'road TRIP', [song])).toBe('Added to Road trip.')
  expect(await addTo(h, 'Road trip', [song])).toBe('Already in Road trip.')
  expect(await removeFrom(h, 'Road trip', [song])).toBe('Removed from Road trip.')
  expect(await removeFrom(h, 'Road trip', [song])).toBe('Not in Road trip.')
  expect(await addTo(h, 'Nope', [song])).toBe('No playlist called Nope.')
  expect(await removeFrom(h, 'Nope', [song])).toBe('No playlist called Nope.')
  expect(await addTo(h, 'fav', [song])).toBe(`Added to ${FAVOURITES}.`)
  expect(await removeFrom(h, 'fav', [song])).toBe(`Removed from ${FAVOURITES}.`)
  expect(await addTo(h, 'history', [song])).toBe('No playlist called history.')
  expect(await removeFrom(h, 'history', [song])).toBe('No playlist called history.')
})

test('playList: unknown name, empty history', async () => {
  const { h } = hostOf()
  const config = { volume: 50, player: 'mpv', androidClient: false }
  expect(await playList(h, config, 'Nope')).toBe('No playlist called Nope.')
  expect(await playList(h, config, 'history')).toBe('Nothing played yet.')
})

test('historyText: newest first, title or file name', () => {
  const now = 1_000_000
  const plays = [
    { at: now - 10, path: '/m/b.mp3', title: '' },
    { at: now - 600, path: '/m/a.mp3', title: 'Song A' },
  ]
  expect(historyText(plays, now)).toBe('just now  b.mp3\n10 min ago  Song A')
  expect(historyText(plays, now, 1)).toBe('just now  b.mp3')
  expect(historyText([], now)).toBe('Nothing played yet.')
})

test('playList finds a saved name in any case, and fav by alias', async () => {
  const { h } = hostOf({ [`${LIB}/Road trip.m3u`]: '#EXTM3U\n' })
  const config = { volume: 50, player: 'mpv', androidClient: false }
  expect(await playList(h, config, 'ROAD trip')).toBe('Road trip is empty.')
  expect(await playList(h, config, 'fav')).toBe(`${FAVOURITES} is empty.`)
})

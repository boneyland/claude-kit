import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host } from '@core/host'
import { FAVOURITES } from '@core/library'
import { memoryStore, nodeHost } from '../src/host-node'
import { HISTORY, libraryRows, POLL_MS, useLibrary, type Library } from '../src/library/useLibrary'

// One state folder for the whole file: core's paths() keeps the first it sees.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lib-'))
const STATE = path.join(TMP, 'state')
fs.mkdirSync(STATE, { recursive: true })
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

let data = ''
let lists = ''
beforeEach(() => {
  data = fs.mkdtempSync(path.join(TMP, 'data-'))
  lists = path.join(data, 'stream-radio', 'playlists')
  fs.mkdirSync(lists, { recursive: true })
  fs.rmSync(path.join(STATE, 'history.jsonl'), { force: true })
})
afterEach(() => cleanup())

const m3u = (...songs: [string, string][]) => `#EXTM3U\n${songs.map(([p, t]) => `#EXTINF:-1,${t}\n${p}`).join('\n')}\n`
// A later mtime than the file had, so a poll sees the change whatever the clock's grain.
function writeLater(file: string, text: string) {
  const was = fs.existsSync(file) ? fs.statSync(file).mtimeMs : Date.now()
  fs.writeFileSync(file, text)
  const t = new Date(was + 5000)
  fs.utimesSync(file, t, t)
}

// A host on the temp folders, with a clock the test turns by hand.
function fakeHost() {
  const timers = new Set<{ ms: number; fn: () => void }>()
  const base = nodeHost({ titleChanged: () => undefined, watching: () => undefined }, memoryStore(() => undefined), { env: { HOME: TMP, XDG_DATA_HOME: data, XDG_STATE_HOME: TMP } })
  const host: Host = {
    ...base,
    dataDir: async () => STATE,
    every: (ms, fn) => {
      const t = { ms, fn }
      timers.add(t)
      return { cancel: () => void timers.delete(t) }
    },
  }
  return { host, timers, tick: () => [...timers].forEach(t => t.fn()) }
}

let seen: Library | undefined
function Probe({ h, isShown }: { h: Host; isShown: boolean }) {
  seen = useLibrary(h, isShown)
  return null
}
const lib = () => seen!

describe('useLibrary', () => {
  test('lists Favourites first with counts, then the saved lists by name', async () => {
    fs.writeFileSync(path.join(lists, `${FAVOURITES}.m3u`), m3u(['/m/a.mp3', 'A'], ['/m/b.mp3', 'B']))
    fs.writeFileSync(path.join(lists, 'Road trip.m3u'), m3u(['/m/c.mp3', 'C']))
    fs.writeFileSync(path.join(lists, 'Late night.m3u'), m3u())
    const { host } = fakeHost()
    render(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(lib().isLoaded).toBe(true))
    expect(lib().lists.map(l => [l.name, l.count])).toEqual([
      [FAVOURITES, 2],
      ['Late night', 0],
      ['Road trip', 1],
    ])
    expect(libraryRows(lib(), '').map(r => r.kind)).toEqual(['list', 'history', 'list', 'list', 'new'])
  })

  test('reads nothing while hidden', async () => {
    const { host, timers } = fakeHost()
    render(<Probe h={host} isShown={false} />)
    await new Promise(r => setTimeout(r, 50))
    expect(lib().isLoaded).toBe(false)
    expect(timers.size).toBe(0)
    expect(libraryRows(lib(), '')).toEqual([])
  })

  test('opens a list in place of the top level, ../ first, and closes back', async () => {
    fs.writeFileSync(path.join(lists, 'Road trip.m3u'), m3u(['/m/c.mp3', 'C'], ['/m/d.mp3', 'D']))
    const { host } = fakeHost()
    render(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(lib().isLoaded).toBe(true))
    lib().openList('Road trip')
    await vi.waitFor(() => expect(lib().open?.name).toBe('Road trip'))
    expect(lib().open).toMatchObject({ kind: 'playlist', songs: [{ path: '/m/c.mp3', title: 'C' }, { path: '/m/d.mp3', title: 'D' }], file: path.join(lists, 'Road trip.m3u') })
    expect(libraryRows(lib(), '').map(r => r.kind)).toEqual(['up', 'song', 'song'])
    expect(libraryRows(lib(), 'd').flatMap(r => (r.kind === 'song' ? [r.index] : []))).toEqual([1])
    lib().close()
    await vi.waitFor(() => expect(lib().open).toBeUndefined())
  })

  test('Recently played: newest first, each with when it played', async () => {
    fs.writeFileSync(path.join(STATE, 'history.jsonl'), [{ at: 100, path: '/m/a.mp3', title: 'A' }, { at: 200, path: '/m/b.mp3', title: 'B' }].map(j => JSON.stringify(j)).join('\n') + '\n')
    const { host } = fakeHost()
    render(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(lib().isLoaded).toBe(true))
    lib().openList(HISTORY)
    await vi.waitFor(() => expect(lib().open?.kind).toBe('history'))
    expect(lib().open!.songs.map(s => s.path)).toEqual(['/m/b.mp3', '/m/a.mp3'])
    expect(libraryRows(lib(), '').flatMap(r => (r.kind === 'song' ? [r.at] : []))).toEqual([200, 100])
    // unix seconds, for whenPlayed
    expect(lib().now).toBeGreaterThan(1_700_000_000)
    expect(lib().now).toBeLessThan(10_000_000_000)
  })

  test('a list changed on disk shows after one 2 s poll', async () => {
    const file = path.join(lists, 'Road trip.m3u')
    fs.writeFileSync(file, m3u(['/m/c.mp3', 'C']))
    const { host, timers, tick } = fakeHost()
    render(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(lib().isLoaded).toBe(true))
    expect([...timers].map(t => t.ms)).toEqual([POLL_MS])
    expect(POLL_MS).toBe(2000)
    // the top level: a list's count, and a new list
    writeLater(file, m3u(['/m/c.mp3', 'C'], ['/m/e.mp3', 'E']))
    writeLater(path.join(lists, 'New one.m3u'), m3u())
    tick()
    await vi.waitFor(() => expect(lib().lists.map(l => [l.name, l.count])).toEqual([[FAVOURITES, 0], ['New one', 0], ['Road trip', 2]]))
    // an open list
    lib().openList('Road trip')
    await vi.waitFor(() => expect(lib().open?.songs.length).toBe(2))
    writeLater(file, m3u(['/m/e.mp3', 'E']))
    tick()
    await vi.waitFor(() => expect(lib().open?.songs.map(s => s.path)).toEqual(['/m/e.mp3']))
  })

  test('Recently played re-reads when history.jsonl changes', async () => {
    const file = path.join(STATE, 'history.jsonl')
    fs.writeFileSync(file, JSON.stringify({ at: 100, path: '/m/a.mp3', title: 'A' }) + '\n')
    const { host, tick } = fakeHost()
    render(<Probe h={host} isShown />)
    lib().openList(HISTORY)
    await vi.waitFor(() => expect(lib().open?.songs.length).toBe(1))
    writeLater(file, fs.readFileSync(file, 'utf8') + JSON.stringify({ at: 300, path: '/m/z.mp3', title: 'Z' }) + '\n')
    tick()
    await vi.waitFor(() => expect(lib().open?.songs.map(s => s.path)).toEqual(['/m/z.mp3', '/m/a.mp3']))
  })

  test('the poll stops when the tab hides, and on unmount', async () => {
    const { host, timers } = fakeHost()
    const ui = render(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(timers.size).toBe(1))
    ui.rerender(<Probe h={host} isShown={false} />)
    await vi.waitFor(() => expect(timers.size).toBe(0))
    ui.rerender(<Probe h={host} isShown />)
    await vi.waitFor(() => expect(timers.size).toBe(1))
    ui.unmount()
    await vi.waitFor(() => expect(timers.size).toBe(0))
  })
})

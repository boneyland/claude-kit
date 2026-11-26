import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Box } from 'ink'
import type { Host } from '@core/host'
import { FAVOURITES } from '@core/library'
import { memoryStore, nodeHost } from '../src/host-node'
import { Checklist, NEW_PLAYLIST } from '../src/ui/Checklist'
import { checklistRows, toggleIn } from '@core/library-actions'
import { useFavourites, type Favourites } from '../src/library/useFavourites'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-check-'))
const STATE = path.join(TMP, 'state')
fs.mkdirSync(STATE, { recursive: true })
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))
afterEach(() => cleanup())

let data = ''
let lists = ''
beforeEach(() => {
  data = fs.mkdtempSync(path.join(TMP, 'data-'))
  lists = path.join(data, 'stream-radio', 'playlists')
  fs.mkdirSync(lists, { recursive: true })
})
const m3u = (...songs: [string, string][]) => `#EXTM3U\n${songs.map(([p, t]) => `#EXTINF:-1,${t}\n${p}`).join('\n')}\n`
const file = (name: string) => path.join(lists, `${name}.m3u`)

function fakeHost() {
  const timers = new Set<{ ms: number; fn: () => void }>()
  const base = nodeHost({ titleChanged: () => undefined, watching: () => undefined }, memoryStore(() => undefined), { env: { HOME: TMP, XDG_DATA_HOME: data } })
  const h = {
    ...base,
    dataDir: async () => STATE,
    home: async () => TMP,
    every: (ms: number, fn: () => void) => {
      const t = { ms, fn }
      timers.add(t)
      return { cancel: () => void timers.delete(t) }
    },
  } as Host
  return { h, timers, tick: () => [...timers].forEach(t => t.fn()) }
}

describe('the checklist', () => {
  const rows = [
    { name: FAVOURITES, mark: 'all' as const },
    { name: 'Late night', mark: 'none' as const },
    { name: 'Road trip', mark: 'some' as const },
  ]
  test('✓ when every song is in the list, – when some are, blank when none; + New playlist… last', () => {
    // over a list: drawn where it is put, in the list's box
    const ui = render(
      <Box flexDirection="column" width={40} height={10}>
        <Checklist rows={rows} selected={1} onToggle={() => undefined} onNew={() => undefined} onClose={() => undefined} />
      </Box>,
    )
    const all = (ui.lastFrame() ?? '').split('\n')
    const at = (t: string) => all.findIndex(l => l.includes(t))
    expect(all[at('Add to playlist')]).toBeDefined()
    expect(all[at(FAVOURITES)]).toMatch(/✓ ★ Favourites/)
    expect(all[at('Road trip')]).toMatch(/– Road trip/)
    expect(all[at('Late night')]).toMatch(/[│ ] {3}Late night/)
    expect(at(NEW_PLAYLIST)).toBeGreaterThan(at('Road trip'))
    expect(at('Road trip')).toBeGreaterThan(at('Late night'))
  })
})

describe('the checklist rows, from the list files', () => {
  test('marks from the songs acted on; a toggle adds the missing, or takes them all out', async () => {
    fs.writeFileSync(file(FAVOURITES), m3u(['/m/a.mp3', 'A'], ['/m/b.mp3', 'B']))
    fs.writeFileSync(file('Road trip'), m3u(['/m/a.mp3', 'A']))
    fs.writeFileSync(file('Late night'), m3u(['/m/z.mp3', 'Z']))
    const { h } = fakeHost()
    const songs = [{ path: '/m/a.mp3', title: 'A' }, { path: '/m/b.mp3', title: 'B' }]
    expect(await checklistRows(h, songs)).toEqual([
      { name: FAVOURITES, mark: 'all' },
      { name: 'Late night', mark: 'none' },
      { name: 'Road trip', mark: 'some' },
    ])
    expect(await toggleIn(h, 'Road trip', songs)).toBe('Added to Road trip.')
    expect(fs.readFileSync(file('Road trip'), 'utf8')).toContain('/m/b.mp3')
    expect((await checklistRows(h, songs))[2]).toEqual({ name: 'Road trip', mark: 'all' })
    expect(await toggleIn(h, FAVOURITES, songs)).toBe(`Removed from ${FAVOURITES}.`)
    expect(fs.readFileSync(file(FAVOURITES), 'utf8')).not.toContain('/m/a.mp3')
    expect((await checklistRows(h, songs))[0]).toEqual({ name: FAVOURITES, mark: 'none' })
  })
})

describe('useFavourites', () => {
  function Probe({ h, playing, out }: { h: Host; playing: string; out: { fav?: Favourites } }) {
    out.fav = useFavourites(h, playing)
    return null
  }
  // A later mtime than the file had, so a poll sees the change whatever the clock's grain.
  function writeLater(f: string, text: string) {
    const was = fs.existsSync(f) ? fs.statSync(f).mtimeMs : Date.now()
    fs.writeFileSync(f, text)
    const t = new Date(was + 5000)
    fs.utimesSync(f, t, t)
  }
  test("reads Favourites' songs, and again when its file changes, at a poll every 2 s", async () => {
    fs.writeFileSync(file(FAVOURITES), m3u(['/m/a.mp3', 'A'], ['https://youtu.be/abc', 'Video']))
    const { h, timers, tick } = fakeHost()
    const out: { fav?: Favourites } = {}
    render(<Probe h={h} playing="" out={out} />)
    await vi.waitFor(() => expect(out.fav?.has('/m/a.mp3')).toBe(true))
    expect(out.fav?.has('https://www.youtube.com/watch?v=abc&list=L')).toBe(true)
    expect(out.fav?.has('/m/b.mp3')).toBe(false)
    expect([...timers].map(t => t.ms)).toEqual([2000])
    writeLater(file(FAVOURITES), m3u(['/m/b.mp3', 'B']))
    tick()
    await vi.waitFor(() => expect(out.fav?.has('/m/b.mp3')).toBe(true))
    expect(out.fav?.has('/m/a.mp3')).toBe(false)
  })

  test('refresh reads it again at once', async () => {
    const { h } = fakeHost()
    const out: { fav?: Favourites } = {}
    render(<Probe h={h} playing="" out={out} />)
    await vi.waitFor(() => expect(out.fav).toBeDefined())
    writeLater(file(FAVOURITES), m3u(['/m/c.mp3', 'C']))
    out.fav!.refresh()
    await vi.waitFor(() => expect(out.fav?.has('/m/c.mp3')).toBe(true))
  })
})

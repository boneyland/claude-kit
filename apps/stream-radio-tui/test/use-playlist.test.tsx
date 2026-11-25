import { afterEach, expect, test } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host, PlayerKeys } from '@core/host'
import { DEFAULT_CONFIG } from '../src/config'
import { usePlaylist, type Playlist } from '../src/playlist/usePlaylist'
import type { View } from '../src/ui/hooks'
import type { TagBook } from '../src/ui/tagbook'

afterEach(() => cleanup())

const QUEUE: PlayerKeys['queue'] = { kind: 'playlist', items: ['One', 'Two', 'Three'], paths: ['/m/1.mp3', '/m/2.mp3', '/m/3.mp3'], root: '/m', current: 1 }
const view = (elapsed: number, filter = ''): View =>
  ({ playing: 'Two', isPaused: false, elapsed, chapter: '', lastUrl: '/m', queue: QUEUE, openFolders: [], filter, resumeAt: { url: '', index: 0, seconds: 0, title: '' }, volume: 60, repeat: 'all', isShuffled: false, status: '', statusSeq: 0 }) as unknown as View

let version = 0
const book: TagBook = { get: () => undefined, need: () => undefined, know: () => undefined, version: () => version }
const turns = { act: () => undefined, inTurn: async () => undefined }
const seen: Playlist[] = []

function Probe({ v }: { v: View }) {
  seen.push(usePlaylist({} as Host, DEFAULT_CONFIG, v, book, '', turns))
  return null
}

test("the rows are worked out again for a new queue, filter or tags, not for the time's tick", () => {
  const ui = render(<Probe v={view(1)} />)
  ui.rerender(<Probe v={view(2)} />)
  ui.rerender(<Probe v={view(3)} />)
  const [a, b, c] = seen.slice(-3)
  expect(b.rows).toBe(a.rows)
  expect(c.rows).toBe(a.rows)
  expect(a.playingRow).toBe(1)

  ui.rerender(<Probe v={view(4, 'thr')} />)
  expect(seen.at(-1)!.rows.map(r => r.title)).toEqual(['Three'])

  version += 1
  ui.rerender(<Probe v={view(5, 'thr')} />)
  expect(seen.at(-1)!.rows).not.toBe(seen.at(-2)!.rows)
})

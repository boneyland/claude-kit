import { afterEach, expect, test } from 'vitest'
import React, { useEffect } from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host } from '@core/host'
import { useTagBook, type TagBook } from '../src/ui/tagbook'
import type { TagReader } from '../src/media/tags'

afterEach(() => cleanup())

const tick = () => new Promise(r => setTimeout(r, 10))

// A host whose stats answer only when told to, one path at a time.
function slowStats() {
  const waiting = new Map<string, () => void>()
  const h = {
    fs: {
      stat: (path: string) => new Promise(resolve => waiting.set(path, () => resolve({ kind: 'file', mtimeMs: 1 }))),
    },
  } as unknown as Host
  return { h, answer: (path: string) => waiting.get(path)!() }
}

function Need({ h, reader, paths }: { h: Host; reader: TagReader; paths: string[] }) {
  const book: TagBook = useTagBook(h, reader)
  useEffect(() => book.need(paths), [book])
  return null
}

test('the files stat-ed together go to the reader together, once the last stat is in', async () => {
  const wanted: string[][] = []
  const reader: TagReader = { get: () => undefined, want: paths => void wanted.push(paths.map(w => w.path)), stop: () => undefined }
  const { h, answer } = slowStats()
  render(<Need h={h} reader={reader} paths={['/a.mp3', '/b.mp3', '/c.mp3']} />)
  await tick()
  answer('/a.mp3')
  await tick()
  answer('/b.mp3')
  await tick()
  expect(wanted).toEqual([])
  answer('/c.mp3')
  await tick()
  expect(wanted).toEqual([['/a.mp3', '/b.mp3', '/c.mp3']])
})

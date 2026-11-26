import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
// Ink's own chalk: colour on, so the frames carry the style codes.
import chalk from 'chalk'
import { Title } from '../src/ui/NowPlaying'

const level = chalk.level
beforeAll(() => {
  chalk.level = 1
})
afterAll(() => {
  chalk.level = level
})
afterEach(cleanup)

const DIM = '\x1b[2m'
const UNDIM = '\x1b[22m'

// Whether dim is on where the song's name starts.
const isNameDim = (frame: string) => {
  let dim = false
  for (const code of frame.slice(0, frame.indexOf('Song')).match(/\x1b\[\d+m/g) ?? []) {
    if (code === DIM) dim = true
    if (code === UNDIM) dim = false
  }
  return dim
}

// Bold and dim end with the same code: Ink, writing a dim cell beside a bold
// one, kept the dim on into the name.
test('a dim ☆ leaves the song name bold, not dim', () => {
  const frame = render(<Title playing="Song title" isPaused={false} isFavourite={false} />).lastFrame() ?? ''
  expect(frame).toContain(`${DIM}☆`)
  expect(isNameDim(frame)).toBe(false)
  expect(frame).toMatch(/\x1b\[1mSong title/)
})

test('a ★ and the name are bold, nothing dim', () => {
  const frame = render(<Title playing="Song title" isPaused={false} isFavourite />).lastFrame() ?? ''
  expect(frame).toContain('★')
  expect(frame).not.toContain(DIM)
  expect(frame).toMatch(/\x1b\[1mSong title/)
})

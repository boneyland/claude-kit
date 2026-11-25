import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
// Ink's own chalk: colour on, so the frames carry the inverse codes.
import chalk from 'chalk'
import { PlaylistView } from '../src/ui/PlaylistView'
import type { FlatRow } from '../src/playlist/rows'

const level = chalk.level
beforeAll(() => {
  chalk.level = 1
})
afterAll(() => {
  chalk.level = level
})
afterEach(cleanup)

const INVERSE = '\x1b[7m'
const row = (index: number, title: string) => ({ index, number: index + 1, title, artist: '', where: '' }) as unknown as FlatRow
// The inverse run on a line: the cells between its start and end codes.
const inverseCells = (line: string) =>
  [...line.matchAll(/\x1b\[7m(.*?)\x1b\[27m/g)].map(m => m[1].replace(/\x1b\[[0-9;]*m/g, '')).join('').length

test('the cursor row is inverse across the whole width, ⋯ included', () => {
  const { lastFrame } = render(
    <PlaylistView heading="Playlist" rows={[row(0, 'Short'), row(1, 'Other')]} selected={0} current={-1} height={2} width={30} first={0} />,
  )
  const [, cursor, other] = lastFrame()!.split('\n')
  expect(cursor).toContain(INVERSE)
  expect(inverseCells(cursor)).toBe(30)
  expect(other).not.toContain(INVERSE)
})

test("the artist and where are dim, except on the cursor's row", () => {
  const withExtra = (index: number) => ({ ...row(index, 'Song'), artist: 'The Band', where: 'Album' }) as FlatRow
  const { lastFrame } = render(
    <PlaylistView heading="Playlist" rows={[withExtra(0), withExtra(1)]} selected={0} current={-1} height={2} width={40} first={0} />,
  )
  const [, cursor, other] = lastFrame()!.split('\n')
  expect(cursor).toContain('The Band · Album')
  expect(cursor).not.toContain('\x1b[2m')
  expect(other).toContain('\x1b[2m')
})

test('a row too long for the width is still one line, truncated', () => {
  const { lastFrame } = render(
    <PlaylistView heading="Playlist" rows={[row(0, 'x'.repeat(80))]} selected={0} current={-1} height={1} width={30} first={0} />,
  )
  const lines = lastFrame()!.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('…')
  expect(inverseCells(lines[1])).toBe(30)
})

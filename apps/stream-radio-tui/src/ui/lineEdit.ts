import { textWidth } from '../../../../plugins/stream-radio/core/nowplaying'

// A line of text being edited, and where the cursor is in it: a UTF-16 index,
// always between two graphemes (a letter and its combining marks move as one).
export type Line = { text: string; at: number }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Where each grapheme starts, and the text's end.
const stops = (text: string) => [...[...segmenter.segment(text)].map(s => s.index), text.length]

const prevStop = (line: Line) => stops(line.text).filter(i => i < line.at).pop() ?? 0
const nextStop = (line: Line) => stops(line.text).find(i => i > line.at) ?? line.text.length
// The start of the word before the cursor, spaces and slashes before it skipped:
// Ctrl-W in a path takes off one folder.
const wordStart = (line: Line) => {
  let i = line.at
  while (i > 0 && /[\s/]/.test(line.text[i - 1]!)) i--
  while (i > 0 && !/[\s/]/.test(line.text[i - 1]!)) i--
  return i
}

const cut = (line: Line, from: number, to: number): Line => ({ text: line.text.slice(0, from) + line.text.slice(to), at: from })

export type Edit =
  | { kind: 'insert'; text: string }
  // the grapheme before the cursor; after it
  | { kind: 'erase' }
  | { kind: 'eraseAfter' }
  | { kind: 'eraseWord' }
  // from the start to the cursor; from the cursor to the end
  | { kind: 'eraseToStart' }
  | { kind: 'eraseToEnd' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'start' }
  | { kind: 'end' }

export function edit(line: Line, e: Edit): Line {
  switch (e.kind) {
    case 'insert':
      return { text: line.text.slice(0, line.at) + e.text + line.text.slice(line.at), at: line.at + e.text.length }
    case 'erase':
      return cut(line, prevStop(line), line.at)
    case 'eraseAfter':
      return cut(line, line.at, nextStop(line))
    case 'eraseWord':
      return cut(line, wordStart(line), line.at)
    case 'eraseToStart':
      return cut(line, 0, line.at)
    case 'eraseToEnd':
      return cut(line, line.at, line.text.length)
    case 'left':
      return { ...line, at: prevStop(line) }
    case 'right':
      return { ...line, at: nextStop(line) }
    case 'start':
      return { ...line, at: 0 }
    case 'end':
      return { ...line, at: line.text.length }
  }
}

// What of the line shows in `width` cells, one kept for the cursor at the end:
// all of it when it fits, else a window that ends at the cursor. `from` is the
// index of the first grapheme shown; the cursor sits on `under` (a space at the end).
export function shown(line: Line, width: number): { from: number; before: string; under: string; after: string } {
  const cells = Math.max(1, width)
  const all = stops(line.text)
  const atEnd = line.at >= line.text.length
  const under = atEnd ? ' ' : line.text.slice(line.at, all.find(i => i > line.at))
  // the first grapheme shown: the earliest from which the cursor's grapheme still fits
  let from = 0
  for (const i of all) {
    if (i > line.at) break
    if (textWidth(line.text.slice(i, line.at)) + textWidth(under) <= cells) {
      from = i
      break
    }
  }
  const before = line.text.slice(from, line.at)
  let after = ''
  let used = textWidth(before) + textWidth(under)
  const rest = atEnd ? '' : line.text.slice(line.at + under.length)
  for (const { segment } of segmenter.segment(rest)) {
    const w = textWidth(segment)
    if (used + w > cells) break
    after += segment
    used += w
  }
  return { from, before, under, after }
}

// The cursor's index for a click `x` cells into the window drawn for `line` in
// `width` cells: before the grapheme clicked, or after the last one showing.
export function indexAt(line: Line, width: number, x: number): number {
  const { from, before, under, after } = shown(line, width)
  const visible = line.text.slice(from, Math.min(line.text.length, from + before.length + under.length + after.length))
  let used = 0
  for (const { segment, index } of segmenter.segment(visible)) {
    const w = textWidth(segment)
    if (x < used + w) return from + index
    used += w
  }
  return from + visible.length
}

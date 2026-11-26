import React from 'react'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'
import { textWidth } from '@core/nowplaying'
import type { Mark } from '@core/library'
import { firstRow } from './List'

export const NEW_PLAYLIST = '+ New playlist…'
const TITLE = 'Add to playlist'

const GLYPH: Record<Mark, string> = { all: '✓', some: '–', none: ' ' }

// Add to playlist's checklist, drawn over the list at (x, y) from its top
// left: each playlist marked ✓ (every song acted on is in it), – (some are)
// or blank, then + New playlist… (selected: rows.length). ↑/↓ and Enter
// choose through the app's keys, as does a click; it stays open after a
// toggle. A click on its title closes it. height: the most rows it shows
// (not counting its title and frame); past that, a window of them that
// follows the choice.
export function Checklist({
  rows,
  selected,
  x = 4,
  y = 0,
  height = Infinity,
  onToggle,
  onNew,
  onClose,
}: {
  rows: readonly { name: string; mark: Mark }[]
  selected: number
  x?: number
  y?: number
  height?: number
  onToggle(i: number): void
  onNew(): void
  onClose(): void
}) {
  const labels = [...rows.map(r => `${GLYPH[r.mark]} ${r.name}`), `  ${NEW_PLAYLIST}`]
  const width = Math.max(textWidth(TITLE), ...labels.map(textWidth)) + 2
  const pad = (s: string) => ` ${s}${' '.repeat(Math.max(0, width - 1 - textWidth(s)))}`
  const shown = Math.max(1, Math.min(height, labels.length))
  const first = firstRow(selected, labels.length, shown)
  return (
    // layer 1: over the rows it covers; a click on its frame does nothing
    <Clickable layer={1} onClick={() => {}} position="absolute" marginLeft={x} marginTop={y} flexDirection="column" borderStyle="round" width={width + 2}>
      <Clickable layer={1} onClick={onClose}>
        <Text bold>{pad(TITLE)}</Text>
      </Clickable>
      {labels.slice(first, first + shown).map((label, n) => {
        const i = first + n
        return (
          <Clickable key={i < rows.length ? `list-${rows[i]!.name}` : 'new'} layer={1} onClick={() => (i < rows.length ? onToggle(i) : onNew())}>
            <Text inverse={i === selected} dimColor={i === rows.length && i !== selected}>
              {pad(label)}
            </Text>
          </Clickable>
        )
      })}
    </Clickable>
  )
}

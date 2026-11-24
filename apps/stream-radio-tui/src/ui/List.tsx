import React from 'react'
import { Text } from 'ink'
import { Clickable, type Hit } from '../mouse/Clickable'
import type { TreeRow } from '../../../../plugins/stream-radio/core/nowplaying'

// Whether a row carries the playing mark: the current song, or a shut folder
// holding it.
export const isCurrent = (row: TreeRow, current: number) =>
  row.kind === 'item' ? row.index === current : row.hasCurrent && !row.isOpen

// The row as the mod's panel writes it.
function label(row: TreeRow, current: number): string {
  const mark = isCurrent(row, current) ? '▶' : ' '
  const indent = '  '.repeat(row.depth)
  if (row.kind === 'folder') return `${mark} ${indent}${row.isOpen ? '▾' : '▸'} 📁 ${row.name}/ · ${row.count}`
  return `${mark} ${indent}${row.number}. ${row.name}${row.where ? ` · ${row.where}` : ''}`
}

// The first row shown: `top` once the wheel or a click has placed the view,
// else the window centred on the selected row; never past either end.
export function firstRow(selected: number, count: number, height: number, top?: number): number {
  const last = Math.max(0, count - height)
  return Math.max(0, Math.min(top ?? selected - Math.floor(height / 2), last))
}

// Whether `x`, from a row's left edge, is on a folder row's ▸/▾.
export const isOnArrow = (row: TreeRow, x: number) => row.kind === 'folder' && x >= 2 + 2 * row.depth && x <= 3 + 2 * row.depth

type Props = {
  heading: string
  rows: TreeRow[]
  selected: number
  current: number
  height: number
  width: number
  first: number
  onRow?(index: number, hit: Hit): void
  onWheel?(dir: 'up' | 'down'): void
}

// The playlist or chapters: the window of rows from `first`.
export function List({ heading, rows, selected, current, height, width, first, onRow, onWheel }: Props) {
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <Text dimColor wrap="truncate-end">
        {heading}
      </Text>
      {rows.slice(first, first + height).map((row, i) => (
        <Clickable key={row.kind === 'item' ? `item-${row.index}` : `folder-${row.path}`} onClick={hit => onRow?.(first + i, hit)}>
          <Text inverse={first + i === selected} bold={isCurrent(row, current)} wrap="truncate-end">
            {label(row, current)}
          </Text>
        </Clickable>
      ))}
    </Clickable>
  )
}

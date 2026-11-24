import React from 'react'
import { Box, Text } from 'ink'
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

type Props = { heading: string; rows: TreeRow[]; selected: number; current: number; height: number; width: number }

// The playlist or chapters: the window of rows around the selected one.
export function List({ heading, rows, selected, current, height, width }: Props) {
  const first = Math.max(0, Math.min(selected - Math.floor(height / 2), rows.length - height))
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor wrap="truncate-end">
        {heading}
      </Text>
      {rows.slice(first, first + height).map((row, i) => (
        <Text
          key={row.kind === 'item' ? `item-${row.index}` : `folder-${row.path}`}
          inverse={first + i === selected}
          bold={isCurrent(row, current)}
          wrap="truncate-end"
        >
          {label(row, current)}
        </Text>
      ))}
    </Box>
  )
}

import React from 'react'
import { Box, Text } from 'ink'
import { Clickable, type Hit } from '../mouse/Clickable'
import type { FileRow } from '../files/tree'
import type { Tags } from '../media/tags'

type Props = {
  heading: string
  rows: FileRow[]
  selected: number
  picked?: ReadonlySet<number>
  height: number
  width: number
  first: number
  tags(path: string): Tags | undefined
  onRow?(at: number, hit: Hit): void
  // a row's menu: right-click, or the ⋯ at the end of the cursor's row
  onMenu?(at: number): void
  onWheel?(dir: 'up' | 'down'): void
}

// x of a folder row's ▸/▾, from the row's left edge.
export const arrowAt = (row: FileRow) => (row.kind === 'dir' ? 2 + 2 * row.depth : -1)

function label(row: FileRow): string {
  switch (row.kind) {
    case 'up':
      return '../'
    case 'dir':
      return `${'  '.repeat(row.depth)}${row.isOpen ? '▾' : '▸'} 📁 ${row.name}/`
    case 'file':
      return `${'  '.repeat(row.depth)}  ${row.name}`
    case 'note':
      return `${'  '.repeat(row.depth)}  ${row.text}`
  }
}

// The Files tab: a tree from the root folder, ../ first.
export function FilesView({ heading, rows, selected, picked, height, width, first, tags, onRow, onMenu, onWheel }: Props) {
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <Text dimColor wrap="truncate-end">
        {heading}
      </Text>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        const isPicked = !!picked?.has(at)
        const artist = row.kind === 'file' ? tags(row.path)?.artist : ''
        return (
          <Clickable key={row.kind === 'up' ? 'up' : row.kind === 'note' ? `note-${at}` : `${row.kind}-${row.path}`} onClick={hit => onRow?.(at, hit)} onRightClick={() => onMenu?.(at)}>
            <Box flexGrow={1}>
              <Text inverse={at === selected} dimColor={row.kind === 'note'} color={isPicked ? 'cyan' : undefined} wrap="truncate-end">
                {` ${isPicked ? '+' : ' '}${label(row)}`}
                {artist ? <Text dimColor>{` · ${artist}`}</Text> : null}
              </Text>
            </Box>
            {at === selected && (row.kind === 'file' || row.kind === 'dir') ? (
              <Clickable onClick={() => onMenu?.(at)} flexShrink={0}>
                <Text>{' ⋯'}</Text>
              </Clickable>
            ) : null}
          </Clickable>
        )
      })}
    </Clickable>
  )
}

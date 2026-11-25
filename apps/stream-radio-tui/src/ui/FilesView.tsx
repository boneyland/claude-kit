import React from 'react'
import { Box, Text } from 'ink'
import { Clickable, type Hit } from '../mouse/Clickable'
import { RowFill } from './RowFill'
import type { FileRow } from '../files/tree'
import type { Tags } from '../media/tags'
import { shown, type Line } from './lineEdit'

type Props = {
  // the root folder's name, after HEADING_PREFIX
  heading: string
  // the location being edited in its place, with a cursor
  editing?: Line
  // a click on the heading, x cells from the location's start (less than 0 on the prefix)
  onHeading?(x: number): void
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

export const HEADING_PREFIX = 'Files · '
const PREFIX_CELLS = HEADING_PREFIX.length

// The cells a location being edited has in a list `width` wide.
export const editCells = (width: number) => Math.max(1, width - PREFIX_CELLS)

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
export function FilesView({ heading, editing, onHeading, rows, selected, picked, height, width, first, tags, onRow, onMenu, onWheel }: Props) {
  // how many times each path has been drawn so far, for keys
  const seen = new Map<string, number>()
  const copies = (path: string) => {
    const n = seen.get(path) ?? 0
    seen.set(path, n + 1)
    return n
  }
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <Clickable onClick={hit => onHeading?.(hit.x - PREFIX_CELLS)}>
        {editing ? <EditLine line={editing} width={editCells(width)} /> : (
          <Text dimColor wrap="truncate-end">
            {HEADING_PREFIX + heading}
          </Text>
        )}
      </Clickable>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        // a video can be in a playlist twice: each copy is its own row
        const key = row.kind === 'up' ? 'up' : row.kind === 'note' ? `note-${at}` : `${row.kind}-${row.path}#${copies(row.path)}`
        const isPicked = !!picked?.has(at)
        const artist = row.kind === 'file' ? tags(row.path)?.artist : ''
        return (
          <Clickable key={key} onClick={hit => onRow?.(at, hit)} onRightClick={() => onMenu?.(at)}>
            <Box flexGrow={1}>
              <Text inverse={at === selected} dimColor={row.kind === 'note'} color={isPicked ? 'cyan' : undefined} wrap="truncate-end">
                {` ${isPicked ? '+' : ' '}${label(row)}`}
                {/* dim on the highlight would be hard to read: full strength there */}
                {artist ? <Text dimColor={at !== selected}>{` · ${artist}`}</Text> : null}
              </Text>
              <RowFill on={at === selected} width={width} />
            </Box>
            {at === selected && (row.kind === 'file' || row.kind === 'dir') ? (
              <Clickable onClick={() => onMenu?.(at)} flexShrink={0}>
                <Text inverse>{' ⋯'}</Text>
              </Clickable>
            ) : null}
          </Clickable>
        )
      })}
    </Clickable>
  )
}

// The heading as the location is edited: the cursor on a cell of its own.
function EditLine({ line, width }: { line: Line; width: number }) {
  const { before, under, after } = shown(line, width)
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{HEADING_PREFIX}</Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  )
}

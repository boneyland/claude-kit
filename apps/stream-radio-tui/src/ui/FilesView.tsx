import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable, type Hit } from '../mouse/Clickable'
import { RowFill } from './RowFill'
import type { FileRow } from '../files/tree'
import type { Tags } from '../media/tags'
import type { Line } from './lineEdit'
import { EditLine, HeadingRow, headingWidth } from './EditLine'

type Props = {
  // where the tree is: a folder, or a YouTube playlist's title
  heading: string
  // the location being edited in its place, with a cursor
  editing?: Line
  // a click on the heading, x cells from the location's start
  onHeading?(x: number): void
  rows: FileRow[]
  selected: number
  picked?: ReadonlySet<number>
  height: number
  width: number
  first: number
  tags(path: string): Tags | undefined
  // whether a file row is a favourite: marked ★
  isFavourite?(row: FileRow): boolean
  onRow?(at: number, hit: Hit): void
  // a row's menu: right-click, or the ⋯ at the end of the cursor's row
  onMenu?(at: number): void
  onWheel?(dir: 'up' | 'down'): void
  // the filter, at the right of the heading's row
  filter?: React.ReactNode
}


// The cells a location being edited has in a list `width` wide.
export const editCells = headingWidth

// x of a folder row's ▸/▾, from the row's left edge.
export const arrowAt = (row: FileRow) => (row.kind === 'dir' ? 2 + 2 * row.depth : -1)

// A row's text: a folder with ▾ (open) or ▸ before it, a favourite file with ★.
function label(row: FileRow, isFavourite: boolean): string {
  switch (row.kind) {
    case 'up':
      return '../'
    case 'dir':
      return `${'  '.repeat(row.depth)}${row.isOpen ? '▾' : '▸'} 📁 ${row.name}/`
    case 'file':
      return `${'  '.repeat(row.depth)}${isFavourite ? '★' : ' '} ${row.name}`
    case 'note':
      return `${'  '.repeat(row.depth)}  ${row.text}`
  }
}

// The Files tab: a tree from the root folder, ../ first.
export function FilesView({ heading, editing, onHeading, rows, selected, picked, height, width, first, tags, isFavourite, onRow, onMenu, onWheel, filter }: Props) {
  // how many times each path has been drawn so far, for keys
  const seen = new Map<string, number>()
  const copies = (path: string) => {
    const n = seen.get(path) ?? 0
    seen.set(path, n + 1)
    return n
  }
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <HeadingRow width={width} onClick={onHeading} filter={filter}>
        {editing ? <EditLine prefix="" line={editing} width={editCells(width)} /> : (
          <Text dimColor wrap="truncate-end">
            {heading}
          </Text>
        )}
      </HeadingRow>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        // a video can be in a playlist twice: each copy is its own row
        const key = row.kind === 'up' ? 'up' : row.kind === 'note' ? `note-${at}` : `${row.kind}-${row.path}#${copies(row.path)}`
        const isPicked = !!picked?.has(at)
        const artist = row.kind === 'file' ? tags(row.path)?.artist : ''
        return (
          <Clickable key={key} onClick={hit => onRow?.(at, hit)} onRightClick={() => onMenu?.(at)}>
            <Box flexGrow={1}>
              <RowFill on={at === selected} width={width} />
              <Text inverse={at === selected} dimColor={row.kind === 'note'} color={isPicked ? 'cyan' : undefined} wrap="truncate-end">
                {` ${isPicked ? '+' : ' '}${label(row, row.kind === 'file' && !!isFavourite?.(row))}`}
                {/* dim on the highlight would be hard to read: full strength there */}
                {artist ? <Text dimColor={at !== selected}>{` · ${artist}`}</Text> : null}
              </Text>
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

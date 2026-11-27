import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'
import { shown, type Line } from './lineEdit'

// A line being edited after a dim prefix: the cursor on a cell of its own.
// width: the cells for the line, after the prefix.
export function EditLine({ prefix, line, width }: { prefix: string; line: Line; width: number }) {
  const { before, under, after } = shown(line, width)
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{prefix}</Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  )
}

export const FILTER_PREFIX = 'Filter · '
const PREFIX_CELLS = FILTER_PREFIX.length
// What an empty filter line says: how to type in it, or why it can't be.
export const FILTER_HINT = '/ or click to filter'
export const FILTER_NONE = 'open a list first'

// The filter's share of a heading's row, in a list `width` wide; a cell
// between it and the heading.
export const filterWidth = (width: number) => Math.min(32, Math.max(12, Math.floor(width * 0.45)))
export const headingWidth = (width: number) => Math.max(1, width - filterWidth(width) - 1)
// The cells the filter text has in a list `width` wide.
export const filterCells = (width: number) => Math.max(1, filterWidth(width) - PREFIX_CELLS)

// A list's heading row: the heading at the left, the filter at the right.
export function HeadingRow({ width, onClick, filter, children }: { width: number; onClick?(x: number): void; filter?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Box>
      <Clickable width={headingWidth(width)} marginRight={1} flexShrink={0} onClick={hit => onClick?.(hit.x)}>
        {children}
      </Clickable>
      <Box width={filterWidth(width)} flexShrink={0}>
        {filter}
      </Box>
    </Box>
  )
}

type FilterProps = {
  text: string
  // the filter being typed, with its cursor
  editing?: Line
  // whether this list can be filtered (Playlists: only an open list)
  canFilter: boolean
  // the list's width: the filter has its share of it
  width: number
  // a click on the line, x cells from the text's start (less than 0 on the prefix)
  onClick?(x: number): void
}

// A tab's filter, at the right of its heading's row. Edited in place, as
// the Files heading is; an empty one too narrow for the hint says only /.
export function FilterLine({ text, editing, canFilter, width: listWidth, onClick }: FilterProps) {
  const width = filterWidth(listWidth)
  return (
    <Clickable width={width} onClick={hit => onClick?.(hit.x - PREFIX_CELLS)}>
      {editing ? (
        <EditLine prefix={FILTER_PREFIX} line={editing} width={filterCells(listWidth)} />
      ) : text ? (
        <Text wrap="truncate-end">
          <Text dimColor>{FILTER_PREFIX}</Text>
          {text}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {FILTER_PREFIX + (!canFilter ? FILTER_NONE : PREFIX_CELLS + FILTER_HINT.length <= width ? FILTER_HINT : '/')}
        </Text>
      )}
    </Clickable>
  )
}

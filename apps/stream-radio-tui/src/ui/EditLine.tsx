import React from 'react'
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
export const FILTER_NONE = 'open a list to filter it'

// The cells the filter text has in a list `width` wide.
export const filterCells = (width: number) => Math.max(1, width - PREFIX_CELLS)

type FilterProps = {
  text: string
  // the filter being typed, with its cursor
  editing?: Line
  // whether this list can be filtered (Playlists: only an open list)
  canFilter: boolean
  width: number
  // a click on the line, x cells from the text's start (less than 0 on the prefix)
  onClick?(x: number): void
}

// A tab's filter: the Queue's and Playlists' under the tabs, Files' at the
// right of its heading. Edited in place, as the Files heading is; an empty
// one too narrow for the hint says only /.
export function FilterLine({ text, editing, canFilter, width, onClick }: FilterProps) {
  return (
    <Clickable width={width} onClick={hit => onClick?.(hit.x - PREFIX_CELLS)}>
      {editing ? (
        <EditLine prefix={FILTER_PREFIX} line={editing} width={filterCells(width)} />
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

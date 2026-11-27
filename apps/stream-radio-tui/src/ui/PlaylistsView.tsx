import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable, type Hit } from '../mouse/Clickable'
import { RowFill } from './RowFill'
import { HeadingRow } from './EditLine'
import { textWidth } from '@core/nowplaying'
import { whenPlayed, type Song } from '@core/library'
import { type LibraryRow } from '../library/useLibrary'
import { extraOf } from '../queue/rows'
import { shown, type Line } from './lineEdit'

type Props = {
  heading: string
  rows: LibraryRow[]
  selected: number
  picked?: ReadonlySet<number>
  // during a drag: the row the songs would land above (rows.length: the end)
  dropAt?: number
  height: number
  width: number
  first: number
  // now, in unix seconds: when Recently played's songs played is shown from it
  now: number
  // whether a song is a favourite: marked ★
  isFavourite?(song: Song): boolean
  onRow?(at: number, hit: Hit): void
  // a row's menu: right-click, or the ⋯ at the end of the cursor's row
  // a drag from row `at`, `dy` rows down (up when negative); its release
  onRowDrag?(at: number, dy: number): void
  onRowRelease?(): void
  onMenu?(at: number): void
  onWheel?(dir: 'up' | 'down'): void
  // the filter, at the right of the heading's row
  filter?: React.ReactNode
}

// After a song's title, dimmed: its artist and folder as the Queue shows them, and when it played.
const songExtra = (row: Extract<LibraryRow, { kind: 'song' }>, now: number): string => {
  const extra = extraOf(row.artist, row.where, row.at === undefined ? '' : whenPlayed(row.at, now))
  return extra ? ` · ${extra}` : ''
}

const nameOf = (row: LibraryRow): string => {
  switch (row.kind) {
    case 'up':
      return '../'
    case 'list':
      return row.info.name
    case 'history':
      return 'Recently played'
    case 'new':
      return '+ New playlist…'
    case 'song':
      return row.title
  }
}

// The Playlists tab: Favourites, Recently played, the saved lists with their
// song counts in a column, and + New playlist…; or an open list, ../ first.
export function PlaylistsView({ heading, rows, selected, picked, dropAt, height, width, first, now, isFavourite, onRow, onRowDrag, onRowRelease, onMenu, onWheel, filter }: Props) {
  // the counts line up after the longest name, leaving room for them
  const nameCells = Math.min(Math.max(0, width - 12), Math.max(0, ...rows.map(r => (r.kind === 'list' ? textWidth(r.info.name) : 0))))
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <HeadingRow width={width} filter={filter}>
        <Text dimColor wrap="truncate-end">
          {heading}
        </Text>
      </HeadingRow>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        const isPicked = !!picked?.has(at)
        const name = (row.kind === 'song' && isFavourite?.(row.song) ? '★ ' : '') + nameOf(row)
        const extra = row.kind === 'list' ? `${' '.repeat(Math.max(0, nameCells - textWidth(name)))} · ${row.info.count}` : row.kind === 'song' ? songExtra(row, now) : ''
        const hasMenu = row.kind === 'list' || row.kind === 'history' || row.kind === 'song'
        return (
          <Clickable key={`${row.kind}-${row.kind === 'list' ? row.info.name : row.kind === 'song' ? row.index : ''}`} onClick={hit => onRow?.(at, hit)} onRightClick={() => onMenu?.(at)} onDrag={p => onRowDrag?.(at, p.y)} onRelease={() => onRowRelease?.()}>
            <Box flexGrow={1}>
              <RowFill on={at === selected} width={width} />
              <Text inverse={at === selected} dimColor={row.kind === 'new'} color={isPicked ? 'cyan' : undefined} underline={dropAt !== undefined && dropAt === at + 1} wrap="truncate-end">
                {`${dropAt === at ? '⤵' : ' '}${isPicked ? '+' : ' '}${name}`}
                {/* dim on the highlight would be hard to read: full strength there */}
                {extra ? <Text dimColor={at !== selected}>{extra}</Text> : null}
              </Text>
            </Box>
            {at === selected && hasMenu ? (
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

// The name being typed for a playlist, on the text line: the cursor on a cell of its own.
export function NamePrompt({ label, line, width }: { label: string; line: Line; width: number }) {
  const { before, under, after } = shown(line, width - textWidth(label))
  return (
    <>
      {label}
      {before}
      <Text inverse>{under}</Text>
      {after}
    </>
  )
}

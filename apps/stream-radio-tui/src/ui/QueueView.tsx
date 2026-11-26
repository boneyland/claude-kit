import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable, type Hit } from '../mouse/Clickable'
import { RowFill } from './RowFill'
import { extraOf, type FlatRow } from '../queue/rows'

type Props = {
  heading: string
  rows: FlatRow[]
  selected: number
  picked?: ReadonlySet<number>
  // during a drag: the row the songs would land above (rows.length: the end)
  dropAt?: number
  current: number
  // whether the song at a queue index is a favourite: marked ★
  isFavourite?(index: number): boolean
  height: number
  width: number
  first: number
  onRow?(at: number, hit: Hit): void
  // a drag from row `at`, `dy` rows down (up when negative); its release
  onRowDrag?(at: number, dy: number): void
  onRowRelease?(): void
  // a row's menu: right-click, or the ⋯ at the end of the cursor's row
  onMenu?(at: number): void
  onWheel?(dir: 'up' | 'down'): void
}

// The Queue tab: one row per song, the window of rows from `first`.
// at: a row's place in `rows` (not its queue index).
export function QueueView({ heading, rows, selected, picked, dropAt, current, isFavourite, height, width, first, onRow, onRowDrag, onRowRelease, onMenu, onWheel }: Props) {
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <Text dimColor wrap="truncate-end">
        {heading}
      </Text>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        const isPlaying = row.index === current
        const isPicked = !!picked?.has(at)
        const extra = extraOf(row.artist, row.where)
        return (
          <Clickable key={`row-${row.index}`} onClick={hit => onRow?.(at, hit)} onRightClick={() => onMenu?.(at)} onDrag={p => onRowDrag?.(at, p.y)} onRelease={() => onRowRelease?.()}>
            <Box flexGrow={1}>
            <RowFill on={at === selected} width={width} />
            <Text inverse={at === selected} bold={isPlaying} color={isPicked ? 'cyan' : undefined} underline={dropAt === at + 1 && dropAt !== undefined} wrap="truncate-end">
              {`${dropAt === at ? '⤵' : isPlaying ? '▶' : ' '}${isPicked ? '+' : ' '}${row.number}. ${row.title}${isFavourite?.(row.index) ? ' ★' : ''}`}
              {/* dim on the highlight would be hard to read: full strength there */}
              {extra ? <Text dimColor={at !== selected}>{` · ${extra}`}</Text> : null}
            </Text>
            </Box>
            {at === selected ? (
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

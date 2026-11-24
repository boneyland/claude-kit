import React from 'react'
import { Text } from 'ink'
import { Clickable, type Hit } from '../mouse/Clickable'
import type { FlatRow } from '../playlist/rows'

type Props = {
  heading: string
  rows: FlatRow[]
  selected: number
  picked?: ReadonlySet<number>
  current: number
  height: number
  width: number
  first: number
  onRow?(at: number, hit: Hit): void
  onWheel?(dir: 'up' | 'down'): void
}

// The Playlist tab: one row per song, the window of rows from `first`.
// at: a row's place in `rows` (not its queue index).
export function PlaylistView({ heading, rows, selected, picked, current, height, width, first, onRow, onWheel }: Props) {
  return (
    <Clickable flexDirection="column" width={width} onWheel={onWheel}>
      <Text dimColor wrap="truncate-end">
        {heading}
      </Text>
      {rows.slice(first, first + height).map((row, i) => {
        const at = first + i
        const isPlaying = row.index === current
        const isPicked = !!picked?.has(at)
        const extra = [row.artist, row.where].filter(Boolean).join(' · ')
        return (
          <Clickable key={`row-${row.index}`} onClick={hit => onRow?.(at, hit)}>
            <Text inverse={at === selected} bold={isPlaying} color={isPicked ? 'cyan' : undefined} wrap="truncate-end">
              {`${isPlaying ? '▶' : ' '}${isPicked ? '+' : ' '}${row.number}. ${row.title}`}
              {extra ? <Text dimColor>{` · ${extra}`}</Text> : null}
            </Text>
          </Clickable>
        )
      })}
    </Clickable>
  )
}

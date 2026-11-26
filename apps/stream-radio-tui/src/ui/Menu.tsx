import React from 'react'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'
import type { Action } from '../keys'

export type MenuItem = { label: string; key: string; action: Action }

// The actions of a row, drawn over the list at (x, y) from the list's top
// left. ↑/↓ and Enter choose (through the app's keys), as does a click.
export function Menu({ items, selected, x, y, onPick }: { items: readonly MenuItem[]; selected: number; x: number; y: number; onPick(i: number): void }) {
  const width = Math.max(...items.map(i => i.label.length + i.key.length + 4)) + 2
  return (
    // layer 1: over the rows it covers; a click on its frame does nothing
    <Clickable layer={1} onClick={() => {}} position="absolute" marginLeft={x} marginTop={y} flexDirection="column" borderStyle="round" width={width + 2}>
      {items.map((item, i) => (
        <Clickable key={item.label} layer={1} onClick={() => onPick(i)}>
          <Text inverse={i === selected}>{` ${item.label.padEnd(width - item.key.length - 2)}${item.key} `}</Text>
        </Clickable>
      ))}
    </Clickable>
  )
}

export const FILES_MENU: readonly MenuItem[] = [
  { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end' } },
  { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next' } },
]

// a video's chapters: they play, but aren't queue entries to move or remove
export const CHAPTER_MENU: readonly MenuItem[] = [{ label: 'Play', key: 'Enter', action: { kind: 'enter' } }]

export const QUEUE_MENU: readonly MenuItem[] = [
  { label: 'Play', key: 'Enter', action: { kind: 'enter' } },
  { label: 'Move up', key: 'u', action: { kind: 'move', by: -1 } },
  { label: 'Move down', key: 'd', action: { kind: 'move', by: 1 } },
  { label: 'Remove', key: 'Del', action: { kind: 'remove' } },
  { label: 'Clear queue', key: 'C', action: { kind: 'clearQueue', isSure: true } },
]

// Playlists, on a list at the top level. Favourites has no Rename or Delete;
// Recently played has Clear instead.
const LIST_PLAY: readonly MenuItem[] = [
  { label: 'Play', key: '', action: { kind: 'playList' } },
  { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end' } },
  { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next' } },
]
export const LIST_MENU: readonly MenuItem[] = [
  ...LIST_PLAY,
  { label: 'Rename', key: '', action: { kind: 'rename' } },
  { label: 'Delete playlist', key: 'Del', action: { kind: 'deleteList' } },
]
export const FAVOURITES_MENU: readonly MenuItem[] = LIST_PLAY
export const HISTORY_MENU: readonly MenuItem[] = [...LIST_PLAY, { label: 'Clear', key: '', action: { kind: 'clearHistory' } }]

// Playlists, on a song inside a list; Recently played's can't be removed.
export const HISTORY_SONG_MENU: readonly MenuItem[] = [
  { label: 'Play from here', key: 'Enter', action: { kind: 'enter' } },
  { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end' } },
  { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next' } },
]
export const LIST_SONG_MENU: readonly MenuItem[] = [...HISTORY_SONG_MENU, { label: 'Remove from playlist', key: 'Del', action: { kind: 'remove' } }]

// What Delete playlist and Clear ask before they act.
export const confirmMenu = (label: string, action: Action): readonly MenuItem[] => [
  { label, key: '', action },
  { label: 'Keep it', key: 'Esc', action: { kind: 'cancel' } },
]

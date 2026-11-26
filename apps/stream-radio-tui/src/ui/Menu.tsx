import React from 'react'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'
import type { Action } from '../keys'
import type { Song } from '@core/library'

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

// Playlists, on list `name` at the top level (HISTORY for Recently played):
// each item names the list, not the row. Favourites has no Rename or Delete;
// Recently played has Clear instead.
const listPlay = (name: string): MenuItem[] => [
  { label: 'Play', key: '', action: { kind: 'playList', name } },
  { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end', list: name } },
  { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next', list: name } },
]
export const listMenu = (name: string): readonly MenuItem[] => [
  ...listPlay(name),
  { label: 'Rename', key: '', action: { kind: 'rename', name } },
  { label: 'Delete playlist', key: 'Del', action: { kind: 'deleteList', name } },
]
export const favouritesMenu = (name: string): readonly MenuItem[] => listPlay(name)
export const historyMenu = (name: string): readonly MenuItem[] => [...listPlay(name), { label: 'Clear', key: '', action: { kind: 'clearHistory' } }]

// Playlists, on songs inside a list, as it was when the menu opened: `all`
// its songs, `source` its file, `index` the cursor's song, `songs` the ones
// the menu acts on (the picked, or the cursor's). Each item carries them, so
// a poll that changes the list meanwhile can't change what it plays or
// removes. Recently played's (no `list`) can't be removed.
export type SongMenuOf = { all: readonly Song[]; source: string; index: number; songs: readonly Song[]; list?: string }
export function songMenu({ all, source, index, songs, list }: SongMenuOf): readonly MenuItem[] {
  return [
    { label: 'Play from here', key: 'Enter', action: { kind: 'enter', play: { songs: all, source, index } } },
    { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end', songs } },
    { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next', songs } },
    ...(list === undefined ? [] : [{ label: 'Remove from playlist', key: 'Del', action: { kind: 'remove', from: { list, songs } } } as const]),
  ]
}

// What Delete playlist and Clear ask before they act.
export const confirmMenu = (label: string, action: Action): readonly MenuItem[] => [
  { label, key: '', action },
  { label: 'Keep it', key: 'Esc', action: { kind: 'cancel' } },
]

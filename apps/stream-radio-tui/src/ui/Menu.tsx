import React from 'react'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'
import type { Action, LibraryOn } from '../keys'
import type { Song } from '@core/library'
import { textWidth } from '@core/nowplaying'

export type MenuItem = { label: string; key: string; action: Action }

// The actions of a row, drawn over the list at (x, y) from the list's top
// left. ↑/↓ and Enter choose (through the app's keys), as does a click.
export function Menu({ items, selected, x, y, onPick }: { items: readonly MenuItem[]; selected: number; x: number; y: number; onPick(i: number): void }) {
  // in columns, not code units: a label can carry a playlist's name (Delete "…")
  const width = Math.max(...items.map(i => textWidth(i.label) + textWidth(i.key) + 4)) + 2
  const pad = (item: MenuItem) => ' '.repeat(Math.max(0, width - 2 - textWidth(item.label) - textWidth(item.key)))
  return (
    // layer 1: over the rows it covers; a click on its frame does nothing
    <Clickable layer={1} onClick={() => {}} position="absolute" marginLeft={x} marginTop={y} flexDirection="column" borderStyle="round" width={width + 2}>
      {items.map((item, i) => (
        <Clickable key={item.label} layer={1} onClick={() => onPick(i)}>
          <Text inverse={i === selected}>{` ${item.label}${pad(item)}${item.key} `}</Text>
        </Clickable>
      ))}
    </Clickable>
  )
}

// What Favourite / Unfavourite and Add to playlist… act on, captured when the
// menu opens: `songs` (toExpand: Files rows, a folder still to be expanded
// into its songs), or the song playing (a video's chapters: the whole video).
// isFavourite: whether all of them are favourites already, for the label.
export type LibraryTarget = { songs: readonly Song[]; toExpand?: boolean; isFavourite: boolean } | { isPlaying: true; isFavourite: boolean }
export function libraryItems(t: LibraryTarget): MenuItem[] {
  const on: LibraryOn = 'songs' in t ? { songs: t.songs, ...(t.toExpand ? { toExpand: true } : {}) } : { isPlaying: true }
  return [
    { label: t.isFavourite ? 'Unfavourite' : 'Favourite', key: '*', action: { kind: 'favourite', ...on } },
    { label: 'Add to playlist…', key: 'P', action: { kind: 'addToList', ...on } },
  ]
}

export const filesMenu = (t: LibraryTarget): readonly MenuItem[] => [
  { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end' } },
  { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next' } },
  ...libraryItems(t),
]

// a video's chapters: they play, but aren't queue entries to move or remove
export const chapterMenu = (isFavourite: boolean): readonly MenuItem[] => [
  { label: 'Play', key: 'Enter', action: { kind: 'enter' } },
  ...libraryItems({ isPlaying: true, isFavourite }),
]

export const queueMenu = (t: LibraryTarget): readonly MenuItem[] => [
  { label: 'Play', key: 'Enter', action: { kind: 'enter' } },
  { label: 'Move up', key: 'u', action: { kind: 'move', by: -1 } },
  { label: 'Move down', key: 'd', action: { kind: 'move', by: 1 } },
  { label: 'Remove', key: 'Del', action: { kind: 'remove' } },
  ...libraryItems(t),
  // last: k from the top lands on it
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
// the menu acts on (the picked, or the cursor's), and `picks` their rows (song
// index in the file, and song) for Remove. Each item carries them, so
// a poll that changes the list meanwhile can't change what it plays or
// removes. Recently played's (no `list`) can't be removed. isFavourite: all of
// `songs` are favourites.
export type SongMenuOf = { all: readonly Song[]; source: string; index: number; songs: readonly Song[]; picks?: readonly { index: number; song: Song }[]; list?: string; isFavourite: boolean }
export function songMenu({ all, source, index, songs, picks, list, isFavourite }: SongMenuOf): readonly MenuItem[] {
  return [
    { label: 'Play from here', key: 'Enter', action: { kind: 'enter', play: { songs: all, source, index } } },
    { label: 'Add to queue', key: 'a', action: { kind: 'add', where: 'end', songs } },
    { label: 'Play next', key: 'A', action: { kind: 'add', where: 'next', songs } },
    ...(list === undefined ? [] : [{ label: 'Remove from playlist', key: 'Del', action: { kind: 'remove', from: { list, picks: picks ?? songs.map(song => ({ index: -1, song })) } } } as const]),
    ...libraryItems({ songs, isFavourite }),
  ]
}

// What Delete playlist and Clear ask before they act.
export const confirmMenu = (label: string, action: Action): readonly MenuItem[] => [
  { label, key: '', action },
  { label: 'Keep it', key: 'Esc', action: { kind: 'cancel' } },
]

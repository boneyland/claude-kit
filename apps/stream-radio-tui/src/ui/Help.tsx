import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { textWidth } from '@core/nowplaying'
import { ICONS } from './Controls'
import type { Tab } from './Tabs'

// Every key, as the README's tables have it: the keys of both tabs, then each tab's own.
export const KEY_HELP: [string, string][] = [
  ['Tab  Shift-Tab', 'switch tabs: Files and the queue'],
  ['↑ ↓  k j', 'move'],
  ['Shift-↑ ↓', 'pick rows from the cursor'],
  ['space', 'pause or resume; while rows are picked, pick or unpick this one'],
  ['Esc', 'clear the pick'],
  ['m', "the row's menu"],
  ['S', 'sort by the next field'],
  ['n  p', 'next or previous song'],
  ['b  f', 'jump 10 seconds back or ahead'],
  ['+ =  -', 'volume up or down a step (3 dB)'],
  ['s', 'shuffle on or off'],
  ['r', 'repeat: all, one, off'],
  ['o', 'go to a folder, or a YouTube playlist URL, in Files'],
  ['G', "Files: the folder of the song playing, the cursor on it"],
  ['l', 'resume the last URL from where it got to'],
  ['x', 'stop the player'],
  ['?', 'this list'],
  ['q, Ctrl-C twice', 'quit; the music keeps playing'],
]

export const PLAYLIST_KEY_HELP: [string, string][] = [
  ['Enter', 'play the song'],
  ['Alt-↑ ↓  u d', 'move the picked songs (or this one)'],
  ['Delete', 'remove the picked songs (or this one)'],
  ['R', 'sort the other way round'],
  ['C twice', 'clear the playlist and stop; l brings it back'],
  ['/', 'filter the list; Enter plays the first match, Esc clears'],
]

export const FILES_KEY_HELP: [string, string][] = [
  ['Enter', 'open or shut a folder; on ../ go up; on a file, add to queue'],
  ['← →', 'shut or open a folder'],
  ['U', 'the folder above (../)'],
  ['o, click heading', 'edit the location: ← → Ctrl-A/E/W/U/K/D, Enter goes'],
  ['a', 'add to queue: the picked rows, or this one'],
  ['A', 'play next: the same, after the song playing'],
]

// What the mouse does.
export const MOUSE_HELP: [string, string][] = [
  ['click', 'select a row; on a folder, open or shut it; on ../, go up'],
  ['Ctrl-click', 'pick or unpick a row'],
  ['Shift-, Alt-click', 'pick the rows from the cursor to there'],
  ['double-click', 'Playlist: play the song; Files: add to queue'],
  ['right-click, ⋯', "the row's menu"],
  ['drag', 'Playlist: move the picked songs (or the one dragged)'],
  ['wheel', 'scroll the list'],
  ['Files heading', 'edit the location there; Esc leaves it'],
  [`${ICONS.prev}  ${ICONS.pause}  ${ICONS.next}  ${ICONS.stop}`, 'previous, pause or play, next, stop'],
  ['volume bar', 'set the volume there'],
  ['repeat, shuffle', 'switch them'],
  ['waveform, bar', 'seek there'],
  ['Shift-drag', 'select text, as the terminal does (see the README for kitty)'],
]

const COLUMN = 20

// Padded by screen columns: a Nerd Font icon is two UTF-16 units but one column.
const pad = (text: string) => text + ' '.repeat(Math.max(0, COLUMN - textWidth(text)))

// The lines of the list, headings and all.
export function helpLines(tab: Tab = 'playlist'): { text: string; isHeading?: boolean }[] {
  const rows = (list: [string, string][]) => list.map(([k, what]) => ({ text: `  ${pad(k)}${what}` }))
  return [
    { text: 'Keys', isHeading: true },
    ...rows(KEY_HELP),
    { text: '' },
    { text: tab === 'playlist' ? 'Playlist tab' : 'Files tab', isHeading: true },
    ...rows(tab === 'playlist' ? PLAYLIST_KEY_HELP : FILES_KEY_HELP),
    { text: '' },
    { text: 'Mouse', isHeading: true },
    ...rows(MOUSE_HELP),
  ]
}

// The first line shown, kept so the last line can reach the foot and no further.
export const helpTop = (top: number, height: number, tab?: Tab) => Math.max(0, Math.min(top, helpLines(tab).length - height))

// The key list in `height` lines from line `top`.
export function Help({ top, height, width, tab }: { top: number; height: number; width: number; tab?: Tab }) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      {helpLines(tab)
        .slice(helpTop(top, height, tab), helpTop(top, height, tab) + height)
        .map((line, i) => (
          <Text key={i} bold={line.isHeading} wrap="truncate-end">
            {line.text || ' '}
          </Text>
        ))}
    </Box>
  )
}

import React from 'react'
import { Box, Text } from 'ink'
import { textWidth } from '../../../../plugins/stream-radio/core/nowplaying'
import { ICONS } from './Controls'

// Every key, as the README's table has it.
export const KEY_HELP: [string, string][] = [
  ['↑ ↓  k j', 'move'],
  ['Enter', 'play the song, or open or shut a folder'],
  ['← →', 'shut or open a folder'],
  ['space', 'pause or resume'],
  ['n  p', 'next or previous song'],
  ['b  f', 'jump 10 seconds back or ahead'],
  ['+ =  -', 'volume up or down a step (3 dB)'],
  ['s', 'shuffle on or off'],
  ['r', 'repeat: all, one, off'],
  ['/', 'filter the list; Enter plays the first match, Esc clears'],
  ['o', 'type a URL or path to play'],
  ['l', 'resume the last URL from where it got to'],
  ['x', 'stop the player'],
  ['?', 'this list'],
  ['q, Ctrl-C twice', 'quit; the music keeps playing'],
]

// What the mouse does.
export const MOUSE_HELP: [string, string][] = [
  ['click', "select a row; on a folder's ▸/▾, open or shut it"],
  ['double-click', 'play the song, or open or shut the folder'],
  ['wheel', 'scroll the list'],
  [`${ICONS.prev}  ${ICONS.pause}  ${ICONS.next}`, 'previous, pause or play, next'],
  ['volume bar', 'set the volume there'],
  ['repeat, shuffle', 'switch them'],
  ['waveform, bar', 'seek there'],
  ['Shift-drag', 'select text, as the terminal does'],
]

const COLUMN = 18

// Padded by screen columns: a Nerd Font icon is two UTF-16 units but one column.
const pad = (text: string) => text + ' '.repeat(Math.max(0, COLUMN - textWidth(text)))

// The lines of the list, headings and all.
export function helpLines(): { text: string; isHeading?: boolean }[] {
  const rows = (list: [string, string][]) => list.map(([k, what]) => ({ text: `  ${pad(k)}${what}` }))
  return [{ text: 'Keys', isHeading: true }, ...rows(KEY_HELP), { text: '' }, { text: 'Mouse', isHeading: true }, ...rows(MOUSE_HELP)]
}

// The first line shown, kept so the last line can reach the foot and no further.
export const helpTop = (top: number, height: number) => Math.max(0, Math.min(top, helpLines().length - height))

// The key list in `height` lines from line `top`.
export function Help({ top, height, width }: { top: number; height: number; width: number }) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      {helpLines()
        .slice(helpTop(top, height), helpTop(top, height) + height)
        .map((line, i) => (
          <Text key={i} bold={line.isHeading} wrap="truncate-end">
            {line.text || ' '}
          </Text>
        ))}
    </Box>
  )
}

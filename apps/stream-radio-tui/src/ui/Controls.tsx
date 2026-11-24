import React from 'react'
import { Box, Text } from 'ink'
import { VOLUME_STEP } from '../../../../plugins/stream-radio/core/nowplaying'
import { Clickable } from '../mouse/Clickable'
import type { Action } from '../keys'

const FILL_COLOR = '#5fafff'

// The volume a click at inner column `x` of a bar `width` cells wide asks
// for: the column's share, to the nearest step; the end cells 0 and 100.
export function volumeAt(x: number, width: number): number {
  if (x <= 0) return 0
  if (x >= width - 1) return 100
  return Math.min(100, Math.round(((x + 0.5) / width) * (100 / VOLUME_STEP)) * VOLUME_STEP)
}

type BarProps = { level: number; width: number; onSet?(level: number): void }

// The volume as mocp draws it: | at each edge, the filled share in █, the
// level centred, its letters over the fill inverted. A click sets it there.
export function VolumeBar({ level, width, onSet }: BarProps) {
  const inner = Math.max(1, width - 2)
  const filled = Math.round((inner * Math.min(100, Math.max(0, level))) / 100)
  const label = `vol ${level}%`
  const start = Math.max(0, Math.floor((inner - label.length) / 2))
  // runs of cells alike: [text, isFilled, isLabel]
  const runs: [string, boolean, boolean][] = []
  for (let i = 0; i < inner; i++) {
    const isLabel = i >= start && i < start + label.length
    const isFilled = i < filled
    const ch = isLabel ? label[i - start] : isFilled ? '█' : ' '
    const last = runs[runs.length - 1]
    if (last && last[1] === isFilled && last[2] === isLabel) last[0] += ch
    else runs.push([ch, isFilled, isLabel])
  }
  return (
    <Clickable width={width} flexShrink={0} onClick={hit => onSet?.(volumeAt(hit.x - 1, inner))}>
      <Text>
        |
        {runs.map(([text, isFilled, isLabel], i) => (
          <Text key={i} color={isFilled ? FILL_COLOR : undefined} inverse={isFilled && isLabel}>
            {text}
          </Text>
        ))}
        |
      </Text>
    </Clickable>
  )
}

type Props = { isPaused: boolean; volume: number; width: number; onAction?(a: Action): void; onVolume?(level: number): void }

// Nerd Font Material icons (kitty and Ghostty bundle the font): previous,
// pause, play, stop, next. Each takes one column; kitty may draw it over the
// space after it, so each button is the icon and a space.
export const ICONS = { prev: '\u{F04AE}', pause: '\u{F03E4}', play: '\u{F040A}', stop: '\u{F04DB}', next: '\u{F04AD}' }

// 󰒮 󰏤 󰓛 󰒭 then the volume bar over the rest of `width`; the play icon for
// pause while paused. Each does what its key does.
export function Controls({ isPaused, volume, width, onAction, onVolume }: Props) {
  const button = (icon: string, a: Action) => (
    <Clickable flexShrink={0} onClick={() => onAction?.(a)}>
      <Text>{`${icon} `}</Text>
    </Clickable>
  )
  const used = 4 * 3 + 1
  // nothing shrinks: a squeezed button or bar would wrap and misplace clicks
  return (
    <Box width={width} flexShrink={0}>
      {button(ICONS.prev, { kind: 'prev' })}
      <Text> </Text>
      {button(isPaused ? ICONS.play : ICONS.pause, { kind: 'pause' })}
      <Text> </Text>
      {button(ICONS.stop, { kind: 'stop' })}
      <Text> </Text>
      {button(ICONS.next, { kind: 'next' })}
      <Text>{'  '}</Text>
      <VolumeBar level={volume} width={Math.max(10, width - used)} onSet={onVolume} />
    </Box>
  )
}

// A word that does what its key does when clicked.
export function Toggle({ text, action, onAction }: { text: string; action: Action; onAction?(a: Action): void }) {
  return (
    <Clickable onClick={() => onAction?.(action)}>
      <Text>{text}</Text>
    </Clickable>
  )
}

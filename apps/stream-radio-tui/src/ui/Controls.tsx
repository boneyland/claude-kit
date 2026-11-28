import React, { useContext } from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { textWidth, VOLUME_STEP } from '@core/nowplaying'
import { Clickable } from '../mouse/Clickable'
import type { Action } from '../keys'
import { IconsContext } from './icons'

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

// isStopped: nothing plays (the pause key then plays the queue).
type Props = { isPaused: boolean; isStopped: boolean; volume: number; width: number; onAction?(a: Action): void; onVolume?(level: number): void }

// Previous, pause, next, stop (icons.ts picks the set), then the volume bar
// over the rest of `width`; the play icon for pause while paused or stopped.
// Each does what its key does.
export function Controls({ isPaused, isStopped, volume, width, onAction, onVolume }: Props) {
  const icons = useContext(IconsContext)
  const button = (icon: string, a: Action) => (
    <Clickable flexShrink={0} onClick={() => onAction?.(a)}>
      <Text>{`${icon} `}</Text>
    </Clickable>
  )
  // each button its icon and a space, a space between them, two before the bar
  const pausing = Math.max(textWidth(icons.pause), textWidth(icons.play))
  const used = [icons.prev, icons.next, icons.stop].reduce((n, icon) => n + textWidth(icon), pausing) + 4 + 3 + 2
  // nothing shrinks: a squeezed button or bar would wrap and misplace clicks
  return (
    <Box width={width} flexShrink={0}>
      {button(icons.prev, { kind: 'prev' })}
      <Text> </Text>
      {button(isPaused || isStopped ? icons.play : icons.pause, { kind: 'pause' })}
      <Text> </Text>
      {button(icons.next, { kind: 'next' })}
      <Text> </Text>
      {button(icons.stop, { kind: 'stop' })}
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

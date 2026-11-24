import React from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { resumable } from '../../../../plugins/stream-radio/core/player'
import type { View } from './hooks'

// The lines it takes, for the layout to plan around.
export const NOW_PLAYING_ROWS = 5

// `2:41 ━━━━━━━━━──── 4:05` in `width` cells.
export function progress(elapsed: number, duration: number, width: number): string {
  const from = formatTime(elapsed)
  const to = formatTime(duration)
  const bar = Math.max(4, width - from.length - to.length - 2)
  const filled = Math.round(bar * Math.min(1, Math.max(0, elapsed / duration)))
  return `${from} ${'━'.repeat(filled)}${'─'.repeat(bar - filled)} ${to}`
}

type Props = { view: View; duration: number; width: number }

// What plays, how far it is, and the volume, repeat and shuffle.
export function NowPlaying({ view, duration, width }: Props) {
  const { playing, isPaused, chapter, elapsed, lastUrl, resumeAt } = view
  const second = playing ? chapter : lastUrl ? `l plays ${resumable(resumeAt, lastUrl) || lastUrl}` : ''
  const time = !playing ? '' : elapsed < 0 || duration <= 0 ? '♪ live' : progress(elapsed, duration, width)
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate-end">
        {playing ? `${isPaused ? '⏸' : '▶'} ${playing}` : 'Nothing playing.'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {second || ' '}
      </Text>
      <Text>{time || ' '}</Text>
      <Text>{`vol ${view.volume}   repeat ${view.repeat}`}</Text>
      <Text>{`shuffle ${view.isShuffled ? 'on' : 'off'}`}</Text>
    </Box>
  )
}

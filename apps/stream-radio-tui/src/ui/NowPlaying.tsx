import React from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { resumable } from '../../../../plugins/stream-radio/core/player'
import type { View } from './hooks'
import { Waveform, WAVEFORM_ROWS } from './Waveform'
import { Art } from './Art'
import type { ArtState } from './hooks'
import type { Graphics } from '../gfx/screen'

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

// The wide layout's pane, a column of its own: its height, the song's tags,
// and its waveform when there is one.
// With `pixels`, the art at the top and the waveform in pixels.
export type Full = { height: number; tags: { artist: string; album: string }; peaks?: Uint8Array; pixels?: { graphics: Graphics; art: ArtState } }

// Title, second line, tags, settings: what the art leaves room for.
const DETAIL_ROWS = 4
// Less room than this and the art is left out.
const MIN_ART_ROWS = 4

type Props = { view: View; duration: number; width: number; full?: Full }

// What plays, how far it is, and the volume, repeat and shuffle. Narrow, in
// five lines; with `full`, down the whole column.
export function NowPlaying({ view, duration, width, full }: Props) {
  const { playing, isPaused, chapter, elapsed, lastUrl, resumeAt } = view
  const second = playing ? chapter : lastUrl ? `l plays ${resumable(resumeAt, lastUrl) || lastUrl}` : ''
  const time = !playing ? '' : elapsed < 0 || duration <= 0 ? '♪ live' : progress(elapsed, duration, width)
  if (full) return <Column view={view} duration={duration} width={width} full={full} second={second} time={time} />
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

type ColumnProps = { view: View; duration: number; width: number; full: Full; second: string; time: string }

// Title, second line, tags and settings at the top; the waveform, or the bar,
// at the foot.
function Column({ view, duration, width, full, second, time }: ColumnProps) {
  const { playing, isPaused, elapsed } = view
  const tags = [full.tags.artist, full.tags.album].filter(Boolean).join(' · ')
  const hasWave = !!full.peaks && full.peaks.length > 0 && duration > 0 && elapsed >= 0
  const pixels = full.pixels
  const artRows = full.height - DETAIL_ROWS - WAVEFORM_ROWS
  return (
    <Box flexDirection="column" width={width} height={full.height}>
      {pixels && artRows >= MIN_ART_ROWS ? <Art art={pixels.art} cols={width} rows={artRows} graphics={pixels.graphics} /> : null}
      <Text bold wrap="truncate-end">
        {playing ? `${isPaused ? '⏸' : '▶'} ${playing}` : 'Nothing playing.'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {second || ' '}
      </Text>
      {tags ? <Text wrap="truncate-end">{tags}</Text> : null}
      <Text wrap="truncate-end">{`vol ${view.volume}   repeat ${view.repeat}   shuffle ${view.isShuffled ? 'on' : 'off'}`}</Text>
      <Box flexGrow={1} />
      {hasWave ? (
        <Box height={WAVEFORM_ROWS}>
          <Waveform peaks={full.peaks!} elapsed={elapsed} duration={duration} width={width} graphics={pixels?.graphics} />
        </Box>
      ) : (
        <Text>{time || ' '}</Text>
      )}
    </Box>
  )
}

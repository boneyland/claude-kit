import React from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { resumable } from '../../../../plugins/stream-radio/core/player'
import type { View } from './hooks'
import { Waveform, WAVEFORM_ROWS } from './Waveform'
import { Art } from './Art'
import type { ArtState } from './hooks'
import type { Graphics } from '../gfx/screen'
import type { Wave } from '../media/peaks'
import type { Action } from '../keys'
import { Controls, Toggle } from './Controls'
import { Clickable, type Hit } from '../mouse/Clickable'

// The lines it takes, for the layout to plan around.
export const NOW_PLAYING_ROWS = 5

// The bar's cells in progress(): where they start, and how many.
function barSpan(elapsed: number, duration: number, width: number) {
  const from = formatTime(elapsed)
  const to = formatTime(duration)
  return { from, to, start: from.length + 1, bar: Math.max(4, width - from.length - to.length - 2) }
}

// `2:41 ━━━━━━━━━──── 4:05` in `width` cells.
export function progress(elapsed: number, duration: number, width: number): string {
  const { from, to, bar } = barSpan(elapsed, duration, width)
  const filled = Math.round(bar * Math.min(1, Math.max(0, elapsed / duration)))
  return `${from} ${'━'.repeat(filled)}${'─'.repeat(bar - filled)} ${to}`
}

// The wide layout's pane, a column of its own: its height, the song's tags,
// and its waveform when there is one.
// With `pixels`, the art at the top and the waveform in pixels.
export type Full = { height: number; tags: { artist: string; album: string }; peaks?: Wave; pixels?: { graphics: Graphics; art: ArtState } }

// Title, second line, tags, controls, settings: what the art leaves room for.
const DETAIL_ROWS = 5
// The narrow layout's volume bar.
const NARROW_BAR = 16
// Less room than this and the art is left out.
const MIN_ART_ROWS = 4

// onAction: a control clicked, as its key; onVolume: the volume bar clicked.
// onSeek: the waveform or the bar clicked, at this share of the song.
type Props = { view: View; duration: number; width: number; full?: Full; onAction?(a: Action): void; onVolume?(level: number): void; onSeek?(share: number): void }

// What plays, how far it is, and the volume, repeat and shuffle. Narrow, in
// five lines; with `full`, down the whole column.
export function NowPlaying({ view, duration, width, full, onAction, onVolume, onSeek }: Props) {
  const { playing, isPaused, chapter, elapsed, lastUrl, resumeAt } = view
  const second = playing ? chapter : lastUrl ? `l plays ${resumable(resumeAt, lastUrl) || lastUrl}` : ''
  const isLive = elapsed < 0 || duration <= 0
  const time = !playing ? <Text> </Text> : isLive ? <Text>♪ live</Text> : <Progress elapsed={elapsed} duration={duration} width={width} onSeek={onSeek} />
  if (full)
    return <Column view={view} duration={duration} width={width} full={full} second={second} time={time} onAction={onAction} onVolume={onVolume} onSeek={onSeek} />
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate-end">
        {playing ? `${isPaused ? '⏸' : '▶'} ${playing}` : 'Nothing playing.'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {second || ' '}
      </Text>
      {time}
      <Box>
        <Controls isPaused={isPaused} volume={view.volume} width={NARROW_BAR + 14} isNarrow onAction={onAction} onVolume={onVolume} />
        <Text>{'  '}</Text>
        <Toggle text={`repeat ${view.repeat}`} action={{ kind: 'repeat' }} onAction={onAction} />
      </Box>
      <Box>
        <Toggle text={`shuffle ${view.isShuffled ? 'on' : 'off'}`} action={{ kind: 'shuffle' }} onAction={onAction} />
      </Box>
    </Box>
  )
}

type ColumnProps = { view: View; duration: number; width: number; full: Full; second: string; time: React.ReactNode } & Pick<Props, 'onAction' | 'onVolume' | 'onSeek'>

// Title, second line, tags and settings at the top; the waveform, or the bar,
// at the foot.
function Column({ view, duration, width, full, second, time, onAction, onVolume, onSeek }: ColumnProps) {
  const { playing, isPaused, elapsed } = view
  const tags = [full.tags.artist, full.tags.album].filter(Boolean).join(' · ')
  const hasWave = !!full.peaks && full.peaks.peak.length > 0 && duration > 0 && elapsed >= 0
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
      <Controls isPaused={isPaused} volume={view.volume} width={width} onAction={onAction} onVolume={onVolume} />
      <Box>
        <Toggle text={`repeat ${view.repeat}`} action={{ kind: 'repeat' }} onAction={onAction} />
        <Text>{'   '}</Text>
        <Toggle text={`shuffle ${view.isShuffled ? 'on' : 'off'}`} action={{ kind: 'shuffle' }} onAction={onAction} />
      </Box>
      <Box flexGrow={1} />
      {hasWave ? (
        <Box height={WAVEFORM_ROWS}>
          <Waveform wave={full.peaks!} elapsed={elapsed} duration={duration} width={width} graphics={pixels?.graphics} onSeek={onSeek} />
        </Box>
      ) : (
        time
      )}
    </Box>
  )
}

// The bar from progress(); a click on its cells (not the times) seeks there.
function Progress({ elapsed, duration, width, onSeek }: { elapsed: number; duration: number; width: number; onSeek?(share: number): void }) {
  const { start, bar } = barSpan(elapsed, duration, width)
  const onClick = (hit: Hit) => {
    const i = hit.x - start
    if (i >= 0 && i < bar) onSeek?.((i + 0.5) / bar)
  }
  return (
    <Clickable onClick={onClick}>
      <Text>{progress(elapsed, duration, width)}</Text>
    </Clickable>
  )
}

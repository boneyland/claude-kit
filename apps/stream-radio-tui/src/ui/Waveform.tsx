import React, { useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { placeholderRow, WAVE_IDS } from '../gfx/kitty'
import type { Graphics } from '../gfx/screen'
import { brailleWave, waveRgba, type BrailleCell } from '../gfx/wave'
import { cutRows } from '../media/art'
import type { Wave } from '../media/peaks'

// Rows the wave itself takes.
const WAVE_ROWS = 4
// The lines it takes: the times, then the wave.
export const WAVEFORM_ROWS = 1 + WAVE_ROWS

const PLAYED_COLOR = '#5fafff'

type Props = { wave: Wave; elapsed: number; duration: number; width: number; graphics?: Graphics }

// The song's waveform as the progress bar, the times above it, drawn as
// Audacity does: the average loudness inside the peaks. The played part is
// blue. In pixels where the terminal shows pictures, else in braille.
export function Waveform({ wave, elapsed, duration, width, graphics }: Props) {
  const from = formatTime(elapsed)
  const to = formatTime(duration)
  const share = Math.min(1, Math.max(0, elapsed / duration))
  const times = <Text>{`${from}${' '.repeat(Math.max(1, width - from.length - to.length))}${to}`}</Text>
  if (graphics) return <Pixels wave={wave} share={share} width={width} graphics={graphics} times={times} />
  const played = Math.round(width * share)
  return (
    <Box flexDirection="column" width={width}>
      {times}
      {brailleWave(wave, width, WAVE_ROWS).map((line, i) => (
        <Text key={i}>{runs(line, played)}</Text>
      ))}
    </Box>
  )
}

// A braille line as runs of like cells: played ones blue, peaks-only ones dim.
function runs(line: BrailleCell[], played: number): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let start = 0
  const style = (i: number) => `${i < played ? 1 : 0}${line[i].isRms ? 1 : 0}`
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && style(i) === style(start)) continue
    const text = line
      .slice(start, i)
      .map(c => c.ch)
      .join('')
    out.push(
      <Text key={start} color={start < played ? PLAYED_COLOR : undefined} dimColor={!line[start].isRms}>
        {text}
      </Text>,
    )
    start = i
  }
  return out
}

type PixelsProps = { wave: Wave; share: number; width: number; graphics: Graphics; times: React.ReactNode }

// Rows of pixels, sent again only when the playhead reaches a new column.
function Pixels({ wave, share, width, graphics, times }: PixelsProps) {
  const { cell } = graphics
  const playedPx = Math.round(share * width * cell.width)
  const strips = useMemo(() => {
    const [w, h] = [width * cell.width, WAVE_ROWS * cell.height]
    return cutRows({ width: w, height: h, rgba: waveRgba(wave, w, h, playedPx) }, WAVE_ROWS)
  }, [wave, width, cell, playedPx])
  useEffect(() => graphics.show(WAVE_IDS.first, strips, width), [graphics, strips, width])
  useEffect(() => () => graphics.drop(WAVE_IDS.first, 0), [graphics])
  return (
    <Box flexDirection="column" width={width}>
      {times}
      {strips.map((_, i) => (
        <Text key={i}>{placeholderRow(WAVE_IDS.first + i, width)}</Text>
      ))}
    </Box>
  )
}

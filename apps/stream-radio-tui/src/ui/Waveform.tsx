import React, { useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { placeholderRow, WAVE_IDS } from '../gfx/kitty'
import type { Graphics } from '../gfx/screen'
import { brailleWave, waveRgba } from '../gfx/wave'
import { cutRows } from '../media/art'

// The lines it takes: the times, then the wave.
export const WAVEFORM_ROWS = 3

type Props = { peaks: Uint8Array; elapsed: number; duration: number; width: number; graphics?: Graphics }

// The song's waveform as the progress bar: the times above it, the played
// part drawn plainly and the rest dimmed.
export function Waveform({ peaks, elapsed, duration, width, graphics }: Props) {
  const from = formatTime(elapsed)
  const to = formatTime(duration)
  const share = Math.min(1, Math.max(0, elapsed / duration))
  const played = Math.round(width * share)
  const times = <Text>{`${from}${' '.repeat(Math.max(1, width - from.length - to.length))}${to}`}</Text>
  if (graphics) return <Pixels peaks={peaks} share={share} width={width} graphics={graphics} times={times} />
  return (
    <Box flexDirection="column" width={width}>
      {times}
      {brailleWave(peaks, width, 2).map((line, i) => {
        const cells = [...line]
        return (
          <Text key={i}>
            {cells.slice(0, played).join('')}
            <Text dimColor>{cells.slice(played).join('')}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

type PixelsProps = { peaks: Uint8Array; share: number; width: number; graphics: Graphics; times: React.ReactNode }

// Two rows of pixels, sent again only when the playhead reaches a new column.
function Pixels({ peaks, share, width, graphics, times }: PixelsProps) {
  const { cell } = graphics
  const playedPx = Math.round(share * width * cell.width)
  const strips = useMemo(
    () => cutRows({ width: width * cell.width, height: 2 * cell.height, rgba: waveRgba(peaks, width * cell.width, 2 * cell.height, playedPx) }, 2),
    [peaks, width, cell, playedPx],
  )
  useEffect(() => graphics.show(WAVE_IDS.first, strips, width), [graphics, strips, width])
  useEffect(() => () => graphics.drop(WAVE_IDS.first, 0), [graphics])
  return (
    <Box flexDirection="column" width={width}>
      {times}
      <Text>{placeholderRow(WAVE_IDS.first, width)}</Text>
      <Text>{placeholderRow(WAVE_IDS.first + 1, width)}</Text>
    </Box>
  )
}

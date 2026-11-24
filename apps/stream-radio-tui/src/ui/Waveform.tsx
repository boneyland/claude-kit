import React from 'react'
import { Box, Text } from 'ink'
import { formatTime } from '../../../../plugins/stream-radio/core/nowplaying'
import { brailleWave } from '../gfx/wave'

// The lines it takes: the times, then the wave.
export const WAVEFORM_ROWS = 3

type Props = { peaks: Uint8Array; elapsed: number; duration: number; width: number }

// The song's waveform as the progress bar: the times above it, the played
// part drawn plainly and the rest dimmed.
export function Waveform({ peaks, elapsed, duration, width }: Props) {
  const from = formatTime(elapsed)
  const to = formatTime(duration)
  const played = Math.round(width * Math.min(1, Math.max(0, elapsed / duration)))
  return (
    <Box flexDirection="column" width={width}>
      <Text>{`${from}${' '.repeat(Math.max(1, width - from.length - to.length))}${to}`}</Text>
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

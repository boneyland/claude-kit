import React, { useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { ART_IDS, placeholderRow } from '../gfx/kitty'
import type { Graphics } from '../gfx/screen'
import { cellStrips, fitArt } from '../media/art'
import type { ArtState } from './hooks'

type Props = { art: ArtState; cols: number; rows: number; graphics: Graphics }

// The art in a cols × rows box: the picture, as large as fits and in its own
// shape; a ♪ placeholder when there is none; nothing while it loads.
export function Art({ art, cols, rows, graphics }: Props) {
  if (art.state === 'shown' && art.art) return <Picture art={art.art} cols={cols} rows={rows} graphics={graphics} />
  if (art.state !== 'missing') return null
  const w = Math.max(4, Math.min(cols, rows * 2))
  const h = Math.max(3, Math.min(rows, Math.round(w / 2)))
  return (
    <Box width={cols} justifyContent="center">
      <Box width={w} height={h} borderStyle="round" borderDimColor justifyContent="center" alignItems="center">
        <Text dimColor>♪</Text>
      </Box>
    </Box>
  )
}

function Picture({ art, cols, rows, graphics }: { art: NonNullable<ArtState['art']>; cols: number; rows: number; graphics: Graphics }) {
  const fit = fitArt(art, cols, rows, graphics.cell)
  const strips = useMemo(() => cellStrips(art, fit.cols, fit.rows, graphics.cell), [art, fit.cols, fit.rows, graphics])
  useEffect(() => graphics.show(ART_IDS.first, strips, fit.cols), [graphics, strips, fit.cols])
  useEffect(() => () => graphics.drop(ART_IDS.first, 0), [graphics])
  return (
    <Box flexDirection="column" width={cols} alignItems="center">
      {strips.map((_, i) => (
        <Text key={i}>{placeholderRow(ART_IDS.first + i, fit.cols)}</Text>
      ))}
    </Box>
  )
}

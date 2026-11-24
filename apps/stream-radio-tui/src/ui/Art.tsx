import React, { useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { ART_IDS, placeholderRow } from '../gfx/kitty'
import type { Graphics } from '../gfx/screen'
import { noteRgba } from '../gfx/note'
import { cellStrips, cutRows, fitArt, type Art as ArtPixels } from '../media/art'
import type { ArtState } from './hooks'

type Props = { art: ArtState; cols: number; rows: number; graphics: Graphics }

// The art in a cols × rows box: the picture, as large as fits and in its own
// shape; a big ♪ in a frame, square, when there is none; nothing while it loads.
export function Art({ art, cols, rows, graphics }: Props) {
  if (art.state === 'shown' && art.art) return <Picture art={art.art} cols={cols} rows={rows} graphics={graphics} />
  if (art.state !== 'missing') return null
  return <Placeholder cols={cols} rows={rows} graphics={graphics} />
}

function Picture({ art, cols, rows, graphics }: { art: ArtPixels; cols: number; rows: number; graphics: Graphics }) {
  const fit = fitArt(art, cols, rows, graphics.cell)
  const strips = useMemo(() => cellStrips(art, fit.cols, fit.rows, graphics.cell), [art, fit.cols, fit.rows, graphics])
  return <Strips strips={strips} cols={fit.cols} width={cols} graphics={graphics} />
}

// As large a square as fits, drawn to the box's exact pixels.
function Placeholder({ cols, rows, graphics }: { cols: number; rows: number; graphics: Graphics }) {
  const { cell } = graphics
  const h = Math.max(1, Math.min(rows, Math.round((cols * cell.width) / cell.height)))
  const w = Math.max(1, Math.min(cols, Math.round((h * cell.height) / cell.width)))
  const strips = useMemo(() => {
    const [pw, ph] = [w * cell.width, h * cell.height]
    return cutRows({ width: pw, height: ph, rgba: noteRgba(pw, ph) }, h)
  }, [w, h, cell])
  return <Strips strips={strips} cols={w} width={cols} graphics={graphics} />
}

// Rows of pixels, centred in `width` columns, each `cols` wide.
function Strips({ strips, cols, width, graphics }: { strips: ArtPixels[]; cols: number; width: number; graphics: Graphics }) {
  useEffect(() => graphics.show(ART_IDS.first, strips, cols), [graphics, strips, cols])
  useEffect(() => () => graphics.drop(ART_IDS.first, 0), [graphics])
  return (
    <Box flexDirection="column" width={width} alignItems="center">
      {strips.map((_, i) => (
        <Text key={i}>{placeholderRow(ART_IDS.first + i, cols)}</Text>
      ))}
    </Box>
  )
}

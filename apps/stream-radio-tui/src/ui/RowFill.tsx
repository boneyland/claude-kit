import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'

// The cursor's highlight: a row of inverse spaces under the row's text, so it
// runs the row's whole width (Ink 5's Box has no background). It lies under
// the text rather than after it: Ink lays ▶ and ⤵ out as two columns but draws
// them in one, as terminals do, so a text box can end a cell past its text,
// and a fill placed after it left that cell out. Goes first in the row; off
// the cursor's row, nothing.
export function RowFill({ on, width }: { on: boolean; width: number }) {
  if (!on) return null
  return (
    <Box position="absolute" width={Math.max(0, width)} height={1} overflow="hidden">
      <Text inverse>{' '.repeat(Math.max(0, width))}</Text>
    </Box>
  )
}

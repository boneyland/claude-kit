import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'

// The rest of a row after its text, inverse on the cursor's row so the
// highlight runs the row's whole width. Ink 5's Box has no background, so this
// is a row of spaces that takes whatever room the text leaves (flexBasis 0:
// the text is measured first) and is clipped to it.
export function RowFill({ on, width }: { on: boolean; width: number }) {
  return (
    <Box flexGrow={1} flexBasis={0} height={1} overflow="hidden">
      <Text inverse={on}>{' '.repeat(Math.max(0, width))}</Text>
    </Box>
  )
}

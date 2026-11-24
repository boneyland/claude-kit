import React from 'react'
import { Box, Text } from 'ink'
import type { Mode } from '../keys'

const FIRST = {
  list: ['space pause  n/p next/prev  +/- vol  s shuffle  r repeat  / filter', 'space pause  n/p next/prev  +/- vol  s shuffle  r repeat'],
  filter: ['type to narrow the list  Enter plays the first match  Esc clears', 'type to narrow  Enter plays the first  Esc clears'],
  open: ['type a URL or a file or folder path  Enter plays it  Esc cancels', 'type a URL or path  Enter plays  Esc cancels'],
}
const SECOND = ['o open url/path  l play last  x stop  q quit (music keeps playing)', '/ filter  o open  l last  x stop  q quit (keeps playing)']

// The two lines of key hints; shorter under 80 columns.
export function Hints({ mode, isWide }: { mode: Mode; isWide: boolean }) {
  const at = isWide ? 0 : 1
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {FIRST[mode][at]}
      </Text>
      <Text dimColor wrap="truncate-end">
        {SECOND[at]}
      </Text>
    </Box>
  )
}

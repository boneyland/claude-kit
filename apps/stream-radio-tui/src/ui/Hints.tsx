import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import type { Mode } from '../keys'
import type { Tab } from './Tabs'

// list: the Playlist's keys; files: the Files tab's
const FIRST = {
  list: ['space pause  n/p next/prev  u/d move  Del remove  S sort  / filter  +/- vol', 'space pause  n/p  u/d move  Del remove  S sort'],
  files: ['Enter open  a add  A play next  m menu  Shift-↑↓ pick  S sort  space pause', 'a add  A play next  m menu  S sort  space pause'],
  filter: ['type to narrow the list  Enter plays the first match  Esc clears', 'type to narrow  Enter plays the first  Esc clears'],
  open: ['type a folder path or a YouTube playlist URL  Enter goes there  Esc leaves it', 'type a folder or URL  Enter goes there  Esc leaves it'],
  help: ['↑/↓ or j/k scroll  PgUp/PgDn a page  ?, Esc or q closes', '↑/↓ j/k scroll  ? Esc q close'],
  menu: ['↑/↓ choose  Enter does it  Esc closes the menu', '↑/↓ choose  Enter does it  Esc closes'],
}
const SECOND = ['? all keys  Tab switch tabs  o go to  l resume  x stop  q quit (music keeps playing)', '? keys  Tab tabs  o go to  l resume  x stop  q quit']

// The two lines of key hints, for the tab showing; shorter under 80 columns.
export function Hints({ mode, isWide, tab = 'playlist' }: { mode: Mode; isWide: boolean; tab?: Tab }) {
  const at = isWide ? 0 : 1
  const first = mode === 'list' && tab === 'files' ? FIRST.files : FIRST[mode]
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {first[at]}
      </Text>
      <Text dimColor wrap="truncate-end">
        {SECOND[at]}
      </Text>
    </Box>
  )
}

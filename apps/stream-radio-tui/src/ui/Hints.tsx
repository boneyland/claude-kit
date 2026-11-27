import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import type { Mode } from '../keys'
import type { Tab } from './Tabs'

// list: the Queue's keys; files and playlists: those tabs'
const FIRST = {
  list: ['space pause  n/p next/prev  u/d move  Del remove  * fav  P playlist  / filter', 'space pause  u/d move  Del remove  * fav  P playlist'],
  files: ['Enter open  a add  A play next  * fav  P playlist  m menu  S sort  space pause', 'a add  A play next  * fav  P playlist  m menu'],
  playlists: ['Enter open/play  a add  A next  Del remove  * fav  P playlist  m menu  / filter', 'Enter open/play  a add  * fav  P playlist  m menu'],
  name: ['type the playlist\'s name  Enter saves it  Esc leaves it as it was', 'type a name  Enter saves  Esc leaves it'],
  filter: ['type to narrow the list  ← → move  Enter plays the first match  Esc clears', 'type to narrow  Enter plays the first  Esc clears'],
  open: ['type a folder path or a YouTube playlist URL  Enter goes there  Esc leaves it', 'type a folder or URL  Enter goes there  Esc leaves it'],
  help: ['↑/↓ or j/k scroll  PgUp/PgDn a page  ?, Esc or q closes', '↑/↓ j/k scroll  ? Esc q close'],
  menu: ['↑/↓ choose  Enter does it  Esc closes the menu', '↑/↓ choose  Enter does it  Esc closes'],
  checklist: ['↑/↓ choose  Enter adds the songs to the list, or takes them out  Esc closes', '↑/↓ choose  Enter adds/takes out  Esc closes'],
}
const SECOND = ['? all keys  Tab switch tabs  o go to  l resume  x stop  q quit (music keeps playing)', '? keys  Tab tabs  o go to  l resume  x stop  q quit']

// The two lines of key hints, for the tab showing; shorter under 80 columns.
export function Hints({ mode, isWide, tab = 'queue' }: { mode: Mode; isWide: boolean; tab?: Tab }) {
  const at = isWide ? 0 : 1
  const first = mode === 'list' && tab !== 'queue' ? FIRST[tab] : FIRST[mode]
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

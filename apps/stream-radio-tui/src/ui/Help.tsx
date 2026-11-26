import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { textWidth } from '@core/nowplaying'
import { FILES_KEY_HELP, KEY_HELP, MOUSE_HELP, QUEUE_KEY_HELP } from '../help'
import type { Tab } from './Tabs'

const COLUMN = 20

// Padded by screen columns: a Nerd Font icon is two UTF-16 units but one column.
const pad = (text: string) => text + ' '.repeat(Math.max(0, COLUMN - textWidth(text)))

// The lines of the list, headings and all.
export function helpLines(tab: Tab = 'queue'): { text: string; isHeading?: boolean }[] {
  const rows = (list: [string, string][]) => list.map(([k, what]) => ({ text: `  ${pad(k)}${what}` }))
  return [
    { text: 'Keys', isHeading: true },
    ...rows(KEY_HELP),
    { text: '' },
    { text: tab === 'queue' ? 'Queue tab' : 'Files tab', isHeading: true },
    ...rows(tab === 'queue' ? QUEUE_KEY_HELP : FILES_KEY_HELP),
    { text: '' },
    { text: 'Mouse', isHeading: true },
    ...rows(MOUSE_HELP),
  ]
}

// The first line shown, kept so the last line can reach the foot and no further.
export const helpTop = (top: number, height: number, tab?: Tab) => Math.max(0, Math.min(top, helpLines(tab).length - height))

// The key list in `height` lines from line `top`.
export function Help({ top, height, width, tab }: { top: number; height: number; width: number; tab?: Tab }) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      {helpLines(tab)
        .slice(helpTop(top, height, tab), helpTop(top, height, tab) + height)
        .map((line, i) => (
          <Text key={i} bold={line.isHeading} wrap="truncate-end">
            {line.text || ' '}
          </Text>
        ))}
    </Box>
  )
}

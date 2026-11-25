import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'

export type Tab = 'files' | 'playlist'
export const TABS: readonly Tab[] = ['files', 'playlist']
const NAMES: Record<Tab, string> = { files: 'Files', playlist: 'Playlist' }

// The tab names, the current one inverted; with `sortLabel`, a clickable
// `sort: <field> ▾` at the right.
export function Tabs({ tab, width, sortLabel, onTab, onSort }: { tab: Tab; width: number; sortLabel?: string; onTab?(t: Tab): void; onSort?(): void }) {
  return (
    <Box width={width} justifyContent="space-between">
      <Box>
        {TABS.map(t => (
          <Clickable key={t} onClick={() => onTab?.(t)} marginRight={1}>
            <Text inverse={t === tab}>{` ${NAMES[t]} `}</Text>
          </Clickable>
        ))}
      </Box>
      {sortLabel ? (
        <Clickable onClick={() => onSort?.()}>
          <Text dimColor>{`sort: ${sortLabel} ▾`}</Text>
        </Clickable>
      ) : null}
    </Box>
  )
}

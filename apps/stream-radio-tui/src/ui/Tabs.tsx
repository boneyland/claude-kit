import React from 'react'
import { Box } from 'ink'
import { Text } from './Text'
import { Clickable } from '../mouse/Clickable'

export type Tab = 'files' | 'queue'
export const TABS: readonly Tab[] = ['files', 'queue']
const NAMES: Record<Tab, string> = { files: 'Files', queue: 'Queue' }

// The tab names, the current one inverted; with `sortLabel`, a clickable
// `sort: <field> ▾` at the right, and with `isReversed` set, after it a
// clickable ↓ (↑ the other way round) that turns the sort round.
type Props = { tab: Tab; width: number; sortLabel?: string; isReversed?: boolean; onTab?(t: Tab): void; onSort?(): void; onReverse?(): void }
export function Tabs({ tab, width, sortLabel, isReversed, onTab, onSort, onReverse }: Props) {
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
        <Box>
          <Clickable onClick={() => onSort?.()}>
            <Text dimColor>{`sort: ${sortLabel} ▾`}</Text>
          </Clickable>
          {isReversed !== undefined ? (
            <Clickable onClick={() => onReverse?.()} marginLeft={1}>
              <Text dimColor>{isReversed ? '↑' : '↓'}</Text>
            </Clickable>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

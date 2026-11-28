import { afterEach, expect, test } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Box } from 'ink'
import { Menu, confirmMenu } from '../src/ui/Menu'
import { textWidth } from '@core/nowplaying'

afterEach(() => cleanup())

test('a menu is as wide as its widest label in columns: a CJK playlist name stays on one row', () => {
  const items = confirmMenu('Delete "日本語の歌"', { kind: 'cancel' })
  const { lastFrame } = render(
    <Box width={60} height={10}>
      <Menu items={items} selected={0} x={0} y={0} onPick={() => {}} />
    </Box>,
  )
  const lines = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(l => l.trim())
  // the top border, the two items, the bottom border
  expect(lines).toHaveLength(4)
  expect(lines[1]).toContain('Delete "日本語の歌"')
  expect(lines[2]).toContain('Keep it')
  expect(lines[2]).toContain('Esc')
  // every row the same width, the border's corners lined up
  const widths = lines.map(l => textWidth(l.trimEnd()))
  expect(new Set(widths).size).toBe(1)
})

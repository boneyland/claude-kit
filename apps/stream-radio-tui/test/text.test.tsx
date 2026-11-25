import { afterEach, expect, test } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { clean, RawText, Text } from '../src/ui/Text'

afterEach(() => cleanup())

// OSC 52 sets the clipboard; a song's tags or a file's name could carry it.
const CLIPBOARD = '\x1b]52;c;cHduZWQ=\x07'

test('clean drops control characters and keeps the rest', () => {
  expect(clean(`Song${CLIPBOARD} title`)).toBe('Song]52;c;cHduZWQ= title')
  expect(clean('a\x9b2Jb\x7fc\x00d')).toBe('a2Jbcd')
  expect(clean('two\nlines\tand\rtab')).toBe('two lines and tab')
  expect(clean('Café ♪ 日本')).toBe('Café ♪ 日本')
})

test('Text draws no escape sequence from its strings, nested or in pieces', () => {
  const title = `Song${CLIPBOARD}`
  const { lastFrame } = render(
    <Text>
      {title} by <Text dimColor>{`\x1b]0;window title\x07Band`}</Text>
    </Text>,
  )
  const frame = lastFrame() ?? ''
  expect(frame).not.toContain('\x1b]')
  expect(frame).not.toContain('\x07')
  expect(frame).toContain('Song]52;c;cHduZWQ= by')
})

test('RawText keeps escape sequences meant for the terminal', () => {
  const { lastFrame } = render(<RawText>{'\x1b[38;2;0;0;1m\u{10EEEE}\x1b[39m'}</RawText>)
  expect(lastFrame()).toContain('\x1b[38;2;0;0;1m')
})

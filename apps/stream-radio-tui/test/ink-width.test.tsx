import { expect, test } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { patchInkOutput } from '../ink-width-fix.mjs'

// Kitty's image placeholder: one column wide, but two UTF-16 code units.
const P = '\u{10EEEE}'

test('a placeholder cell takes one column, so the text after it stays put', () => {
  const { lastFrame } = render(
    <Box width={20}>
      <Text>{P.repeat(5)}</Text>
      <Text>|end</Text>
    </Box>,
  )
  expect(lastFrame()).toBe(`${P.repeat(5)}|end`)
})

test('a double-width character still takes two', () => {
  const { lastFrame } = render(
    <Box width={20}>
      <Text>漢字ab</Text>
      <Text>|end</Text>
    </Box>,
  )
  expect(lastFrame()).toBe('漢字ab|end')
})

// string-width calls ▶ two columns (it can be an emoji); terminals draw it
// as one, as Ink did before the fix. The playlist's playing row starts with it.
test('▶ keeps one column, so a fixed-width row still reaches its edge', () => {
  const { lastFrame } = render(
    <Box>
      <Box width={6}>
        <Text>▶ x</Text>
      </Box>
      <Text>|</Text>
    </Box>,
  )
  expect(lastFrame()).toBe('▶ x   |')
})

// A tag can spell è as e + U+0300. The accent takes no column of its own, so it
// shares e's cell rather than leaving the rest of the row a column short.
// (Ink's truncation counts the accent as a column, so the text is cut early;
// that only shortens the text, the divider stays put.)
test('a combining mark shares the cell before it, so the row keeps its width', () => {
  const { lastFrame } = render(
    <Box>
      <Box width={20}>
        <Text wrap="truncate-end">Aria da Capo è Fine and more</Text>
      </Box>
      <Text>|</Text>
    </Box>,
  )
  const frame = lastFrame()!
  expect(frame).toMatch(/^Aria da Capo è Fi/)
  expect(stringWidth(frame.slice(0, frame.indexOf('|')))).toBe(20)
})

test('a combining mark after a double-width character joins that character', () => {
  const { lastFrame } = render(
    <Box width={20}>
      <Text>漢́ab</Text>
      <Text>|end</Text>
    </Box>,
  )
  expect(lastFrame()).toBe('漢́ab|end')
})

test('the patch refuses an Ink it does not recognise', () => {
  expect(() => patchInkOutput('nothing here')).toThrow(/ink-width-fix/)
})

import { expect, test } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
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

test('the patch refuses an Ink it does not recognise', () => {
  expect(() => patchInkOutput('nothing here')).toThrow(/ink-width-fix/)
})

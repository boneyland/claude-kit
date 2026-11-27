import { expect, test } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import { FilterLine } from '../src/ui/EditLine'

// Ink measured a text again after a string appeared in it at the end, but not
// before a part already there: it kept the old width, and truncate-end drew …
test('a string that appears before a part already there is measured again', () => {
  const row = (lead: string) => (
    <Box width={20}>
      <Text wrap="truncate-end">
        {lead}
        <Text inverse> </Text>
      </Text>
    </Box>
  )
  const { lastFrame, rerender } = render(row(''))
  rerender(row('abc'))
  expect(lastFrame()).toBe('abc')
})

test('the first letter typed in a filter shows, not …', () => {
  const { lastFrame, rerender } = render(<FilterLine text="" editing={{ text: '', at: 0 }} canFilter width={60} />)
  rerender(<FilterLine text="a" editing={{ text: 'a', at: 1 }} canFilter width={60} />)
  expect(lastFrame()).toBe('Filter · a')
})

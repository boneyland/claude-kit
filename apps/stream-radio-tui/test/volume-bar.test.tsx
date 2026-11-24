import { describe, expect, test } from 'vitest'
import React from 'react'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import { ICONS, volumeAt, VolumeBar } from '../src/ui/Controls'

describe('volumeAt', () => {
  test('the ends give 0 and 100; between, the nearest 5', () => {
    expect(volumeAt(0, 20)).toBe(0)
    expect(volumeAt(19, 20)).toBe(100)
    expect(volumeAt(9, 20)).toBe(50)
    expect(volumeAt(3, 20)).toBe(20)
    expect(volumeAt(-1, 20)).toBe(0)
    expect(volumeAt(25, 20)).toBe(100)
  })
})

describe('VolumeBar', () => {
  test('| at the edges, █ for the filled share, the level centred, nothing else', () => {
    const { lastFrame } = render(<VolumeBar level={60} width={22} />)
    expect(lastFrame()).toBe('|██████vol 60%       |')
  })
  test('empty and full', () => {
    expect(render(<VolumeBar level={0} width={12} />).lastFrame()).toBe('|  vol 0%  |')
    expect(render(<VolumeBar level={100} width={12} />).lastFrame()).toBe('|█vol 100%█|')
  })
  test('the icons take one column each, so the line ends where it should', () => {
    const { lastFrame } = render(
      <Box>
        <Box width={12}>
          <Text>{`${ICONS.prev} ${ICONS.pause} ${ICONS.play} ${ICONS.next}`}</Text>
        </Box>
        <Text>|</Text>
      </Box>,
    )
    expect(lastFrame()).toBe(`${ICONS.prev} ${ICONS.pause} ${ICONS.play} ${ICONS.next}     |`)
  })

})

import { describe, expect, test } from 'vitest'
import { brailleWave, WAVE_COLORS, waveRgba } from '../src/gfx/wave'

const full = (n: number) => new Uint8Array(n).fill(255)

describe('brailleWave', () => {
  test('a loud cell fills both rows', () => {
    expect(brailleWave(full(1), 1, 2)).toEqual(['⣿', '⣿'])
  })
  test('silence is a thin line either side of the middle', () => {
    expect(brailleWave(new Uint8Array([0]), 1, 2)).toEqual(['⣀', '⠉'])
  })
  test('each cell holds two values, left and right', () => {
    expect(brailleWave(new Uint8Array([255, 0]), 1, 2)).toEqual(['⣇', '⡏'])
  })
  test('as many lines as rows, as many characters as columns', () => {
    const lines = brailleWave(new Uint8Array([10, 200, 90, 30, 255]), 7, 3)
    expect(lines).toHaveLength(3)
    for (const l of lines) expect([...l]).toHaveLength(7)
  })
})

describe('waveRgba', () => {
  const px = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  test('played columns in one colour, the rest in another', () => {
    const rgba = waveRgba(full(4), 4, 8, 2)
    expect(rgba).toHaveLength(4 * 8 * 4)
    for (let y = 0; y < 8; y++) {
      expect(px(rgba, 4, 0, y)).toEqual([...WAVE_COLORS.played, 255])
      expect(px(rgba, 4, 3, y)).toEqual([...WAVE_COLORS.unplayed, 255])
    }
  })
  test('silence lights only the middle two rows; the rest is see-through', () => {
    const rgba = waveRgba(new Uint8Array(4), 4, 8, 0)
    const lit = [...Array(8).keys()].filter(y => px(rgba, 4, 1, y)[3] === 255)
    expect(lit).toEqual([3, 4])
    expect(px(rgba, 4, 1, 0)).toEqual([0, 0, 0, 0])
  })
})

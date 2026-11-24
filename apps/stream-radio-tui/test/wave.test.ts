import { describe, expect, test } from 'vitest'
import { brailleWave, WAVE_COLORS, waveRgba } from '../src/gfx/wave'

const wave = (peak: number[], rms: number[]) => ({ peak: new Uint8Array(peak), rms: new Uint8Array(rms) })
const text = (lines: { ch: string }[][]) => lines.map(l => l.map(c => c.ch).join(''))
const inRms = (lines: { isRms: boolean }[][]) => lines.map(l => l.map(c => c.isRms))

describe('brailleWave', () => {
  test('a loud cell fills all four rows', () => {
    expect(text(brailleWave(wave([255], [255]), 1, 4))).toEqual(['⣿', '⣿', '⣿', '⣿'])
  })
  test('silence is a thin line either side of the middle', () => {
    expect(text(brailleWave(wave([0], [0]), 1, 4))).toEqual(['⠀', '⣀', '⠉', '⠀'])
  })
  test('each cell holds two values, left and right', () => {
    expect(text(brailleWave(wave([255, 0], [255, 0]), 1, 2))).toEqual(['⣇', '⡏'])
  })
  test('cells in the average-loudness band are marked; peaks-only cells are not', () => {
    // loud peaks, quiet average: the outer rows are peaks only
    const lines = brailleWave(wave([255], [0]), 1, 4)
    expect(text(lines)).toEqual(['⣿', '⣿', '⣿', '⣿'])
    expect(inRms(lines)).toEqual([[false], [true], [true], [false]])
  })
  test('as many lines as rows, as many cells as columns', () => {
    const lines = brailleWave(wave([10, 200, 90, 30, 255], [5, 100, 40, 10, 120]), 7, 3)
    expect(lines).toHaveLength(3)
    for (const l of lines) expect(l).toHaveLength(7)
  })
})

describe('waveRgba', () => {
  const px = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  test('average loudness solid inside, peaks around it, played and unplayed apart', () => {
    const rgba = waveRgba(wave([255, 255, 255, 255], [0, 0, 0, 0]), 4, 8, 2)
    expect(rgba).toHaveLength(4 * 8 * 4)
    // column 0 played: peak colour at the edges, rms colour at the middle
    expect(px(rgba, 4, 0, 0)).toEqual([...WAVE_COLORS.played.peak, 255])
    expect(px(rgba, 4, 0, 3)).toEqual([...WAVE_COLORS.played.rms, 255])
    expect(px(rgba, 4, 0, 4)).toEqual([...WAVE_COLORS.played.rms, 255])
    expect(px(rgba, 4, 0, 7)).toEqual([...WAVE_COLORS.played.peak, 255])
    // column 3 unplayed
    expect(px(rgba, 4, 3, 0)).toEqual([...WAVE_COLORS.unplayed.peak, 255])
    expect(px(rgba, 4, 3, 4)).toEqual([...WAVE_COLORS.unplayed.rms, 255])
  })
  test('silence lights only the middle two rows; the rest is see-through', () => {
    const rgba = waveRgba(wave([0, 0, 0, 0], [0, 0, 0, 0]), 4, 8, 0)
    const lit = [...Array(8).keys()].filter(y => px(rgba, 4, 1, y)[3] === 255)
    expect(lit).toEqual([3, 4])
    expect(px(rgba, 4, 1, 0)).toEqual([0, 0, 0, 0])
  })
})

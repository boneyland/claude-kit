import { describe, expect, test } from 'vitest'
import { parseArgs, stepVolume } from '../../../plugins/stream-radio/core/nowplaying'

// mpv's volume is cubic: loudness in dB is 60·log10(volume / 100).
const db = (v: number) => 60 * Math.log10(v / 100)

describe('stepVolume', () => {
  test('down from 100, each step about 3 dB quieter, to silence', () => {
    const seen = [100]
    while (seen[seen.length - 1] > 0) seen.push(stepVolume(seen[seen.length - 1], -1))
    expect(seen).toEqual([100, 89, 79, 70, 62, 55, 49, 44, 39, 35, 31, 28, 25, 22, 20, 18, 16, 14, 12, 11, 10, 9, 8, 7, 6, 5, 0])
  })
  test('up from silence, to 100 and no further', () => {
    const seen = [0]
    while (seen[seen.length - 1] < 100) seen.push(stepVolume(seen[seen.length - 1], 1))
    expect(seen[1]).toBe(5)
    expect(seen[seen.length - 1]).toBe(100)
    expect(stepVolume(100, 1)).toBe(100)
    expect(stepVolume(0, -1)).toBe(0)
  })
  test('a step above 20 changes the loudness by 2.5 to 3.5 dB, at the top as at the bottom', () => {
    for (const v of [100, 60, 30, 21]) {
      for (const dir of [1, -1] as const) {
        const next = stepVolume(v, dir)
        if (next === v) continue
        expect(Math.abs(db(next) - db(v)), `${v} ${dir}`).toBeGreaterThan(2.5)
        expect(Math.abs(db(next) - db(v)), `${v} ${dir}`).toBeLessThan(3.5)
      }
    }
  })
  test('a level off the ladder (from mpv, or a click) steps from where it is', () => {
    expect(stepVolume(60, 1)).toBe(67)
    expect(stepVolume(60, -1)).toBe(53)
  })
})

test('/stream vol up and down ask for a step, not an amount', () => {
  expect(parseArgs('vol up', '')).toEqual({ kind: 'volume', step: 1 })
  expect(parseArgs('vol -', '')).toEqual({ kind: 'volume', step: -1 })
  expect(parseArgs('vol 30', '')).toEqual({ kind: 'volume', to: 30 })
})

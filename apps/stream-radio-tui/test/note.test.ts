import { describe, expect, test } from 'vitest'
import { NOTE_COLORS, noteRgba } from '../src/gfx/note'

const px = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

describe('noteRgba', () => {
  const [w, h] = [200, 200]
  const rgba = noteRgba(w, h)
  test('one pixel each, four bytes per pixel', () => {
    expect(rgba).toHaveLength(w * h * 4)
  })
  test('a big note: the head low left, the stem up its right side', () => {
    expect(px(rgba, w, 76, 148)).toEqual([...NOTE_COLORS.note, 255]) // head
    expect(px(rgba, w, 105, 80)).toEqual([...NOTE_COLORS.note, 255]) // stem
  })
  test('a rounded frame round the edge, see-through between frame and note', () => {
    expect(px(rgba, w, 100, 1)).toEqual([...NOTE_COLORS.frame, 255])
    expect(px(rgba, w, 1, 100)).toEqual([...NOTE_COLORS.frame, 255])
    expect(px(rgba, w, 0, 0)[3]).toBe(0) // the corner is rounded off
    expect(px(rgba, w, 30, 30)[3]).toBe(0)
  })
  test('a non-square box keeps the note round, centred', () => {
    const wide = noteRgba(400, 200)
    expect(px(wide, 400, 176, 148)).toEqual([...NOTE_COLORS.note, 255])
    expect(px(wide, 400, 76, 148)[3]).toBe(0)
  })
})

import { describe, expect, test } from 'vitest'
import { clamp, clear, extend, remap, select, targets, toggle, type Selection } from '../src/ui/selection'

const s0: Selection = { cursor: 0, anchor: 0, picked: [] }

describe('selection', () => {
  test('select moves cursor and anchor and clears the pick', () => {
    expect(select({ cursor: 1, anchor: 1, picked: [1, 2] }, 3)).toEqual({ cursor: 3, anchor: 3, picked: [] })
  })
  test('extend picks the range from the anchor', () => {
    expect(extend(select(s0, 2), 4).picked).toEqual([2, 3, 4])
    expect(extend(select(s0, 4), 1).picked).toEqual([1, 2, 3, 4])
    expect(extend(select(s0, 2), 4).cursor).toBe(4)
  })
  test('extending down then back over the anchor leaves only the anchor', () => {
    let s = select(s0, 4)
    s = extend(s, 3)
    s = extend(s, 2)
    s = extend(s, 3)
    s = extend(s, 4)
    expect(s.picked).toEqual([4])
  })
  test('toggle adds then removes, and moves cursor and anchor', () => {
    const a = toggle(s0, 3)
    expect(a).toEqual({ cursor: 3, anchor: 3, picked: [3] })
    const b = toggle(toggle(a, 1), 3)
    expect(b.picked).toEqual([1])
    expect(toggle(b, 1).picked).toEqual([])
  })
  test('picked stays sorted and unique', () => {
    expect(toggle(toggle(toggle(s0, 5), 1), 3).picked).toEqual([1, 3, 5])
  })
  test('targets: the picked rows, else the cursor', () => {
    expect(targets({ cursor: 2, anchor: 2, picked: [] })).toEqual([2])
    expect(targets({ cursor: 2, anchor: 2, picked: [0, 4] })).toEqual([0, 4])
  })
  test('clear keeps the cursor', () => {
    expect(clear({ cursor: 2, anchor: 1, picked: [1, 2] })).toEqual({ cursor: 2, anchor: 2, picked: [] })
  })
  test('remap: the pick is replaced and the cursor follows its row', () => {
    // rows 1,2 (cursor on 2) moved up by one → 0,1
    expect(remap({ cursor: 2, anchor: 1, picked: [1, 2] }, [0, 1])).toEqual({ cursor: 1, anchor: 0, picked: [0, 1] })
    // no pick: the cursor's row moved, and nothing becomes picked
    expect(remap({ cursor: 3, anchor: 3, picked: [] }, [4])).toEqual({ cursor: 4, anchor: 4, picked: [] })
  })
  test('clamp drops picks past the end and keeps the cursor in range', () => {
    expect(clamp({ cursor: 6, anchor: 5, picked: [1, 4, 5, 6] }, 5)).toEqual({ cursor: 4, anchor: 4, picked: [1, 4] })
    expect(clamp({ cursor: 3, anchor: 3, picked: [3] }, 0)).toEqual({ cursor: 0, anchor: 0, picked: [] })
  })
})

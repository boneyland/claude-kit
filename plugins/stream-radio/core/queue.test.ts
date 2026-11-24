import { expect, test } from 'claude-code/testing'

import { moveBy, moveSteps, moveTo } from './queue'

test('picked rows move one place as a block; a block at the end stays', () => {
  expect(moveBy(5, [1, 2], -1)).toEqual({ order: [1, 2, 0, 3, 4], picked: [0, 1] })
  expect(moveBy(5, [0], -1)).toEqual({ order: [0, 1, 2, 3, 4], picked: [0] })
  expect(moveBy(5, [1, 3], 1)).toEqual({ order: [0, 2, 1, 4, 3], picked: [2, 4] })
  expect(moveBy(5, [3, 4], 1)).toEqual({ order: [0, 1, 2, 3, 4], picked: [3, 4] })
})

test('moves go by position, so a song in the queue twice moves only the picked copy', () => {
  // [a, a, b]: the second a, picked, moves above the first
  expect(moveBy(3, [1], -1).order).toEqual([1, 0, 2])
  expect(moveBy(3, [2], -1).order).toEqual([0, 2, 1])
})

test('picked rows dropped before a row, in their order', () => {
  expect(moveTo(5, [3, 4], 1)).toEqual({ order: [0, 3, 4, 1, 2], picked: [1, 2] })
  expect(moveTo(5, [0], 5)).toEqual({ order: [1, 2, 3, 4, 0], picked: [4] })
  expect(moveTo(5, [1, 3], 3)).toEqual({ order: [0, 2, 1, 3, 4], picked: [2, 3] })
})

// mpv's playlist-move: entry j goes to before entry i.
function apply(n: number, steps: [number, number][]): number[] {
  const list = Array.from({ length: n }, (_, i) => i)
  for (const [j, i] of steps) {
    const [x] = list.splice(j, 1)
    list.splice(j < i ? i - 1 : i, 0, x!)
  }
  return list
}

test('the playlist-move steps turn the queue into the order asked', () => {
  expect(moveSteps([2, 0, 1])).toEqual([[2, 0]])
  expect(moveSteps([0, 1, 2])).toEqual([])
  for (let t = 0; t < 20; t++) {
    const order = [0, 1, 2, 3, 4, 5].map(v => ({ v, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.v)
    expect(apply(6, moveSteps(order))).toEqual(order)
  }
})

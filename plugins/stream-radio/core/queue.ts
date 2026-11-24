// Reordering the queue, as plain index work: which old entry ends up where,
// and the mpv commands that get it there. By position, never by name, so a
// song in the queue twice moves only the copy picked.

export type Moved = { order: number[]; picked: number[] }

// The picked rows one place up (-1) or down (1). Each run of picked rows moves
// as a block; a block already at that end stays. order[i]: the old index now
// at i; picked: the picked rows' new indexes.
export function moveBy(count: number, picked: readonly number[], by: 1 | -1): Moved {
  const isPicked = new Set(picked)
  const list = Array.from({ length: count }, (_, i) => i)
  const swap = (a: number, b: number) => ([list[a], list[b]] = [list[b]!, list[a]!])
  if (by < 0) {
    for (let i = 1; i < count; i++) if (isPicked.has(list[i]!) && !isPicked.has(list[i - 1]!)) swap(i, i - 1)
  } else {
    for (let i = count - 2; i >= 0; i--) if (isPicked.has(list[i]!) && !isPicked.has(list[i + 1]!)) swap(i, i + 1)
  }
  return { order: list, picked: list.flatMap((old, i) => (isPicked.has(old) ? [i] : [])) }
}

// The picked rows, in their order, dropped before old row `to` (count: the end).
export function moveTo(count: number, picked: readonly number[], to: number): Moved {
  const isPicked = new Set(picked)
  const rest = Array.from({ length: count }, (_, i) => i).filter(i => !isPicked.has(i))
  const at = rest.filter(i => i < to).length
  const moving = [...isPicked].sort((a, b) => a - b)
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
  return { order, picked: moving.map((_, k) => at + k) }
}

// mpv `playlist-move j i` pairs (entry j to before entry i) that turn the
// queue into `order`: each place filled from the front, so j is always past i.
export function moveSteps(order: readonly number[]): [number, number][] {
  const list = order.map((_, i) => i)
  const steps: [number, number][] = []
  order.forEach((want, i) => {
    const j = list.indexOf(want)
    if (j === i) return
    steps.push([j, i])
    list.splice(j, 1)
    list.splice(i, 0, want)
  })
  return steps
}

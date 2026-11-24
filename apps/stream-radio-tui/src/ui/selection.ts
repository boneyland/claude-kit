// Where the cursor is and which rows are picked, in one list (either tab).
// `anchor`: where a Shift range starts. `picked`: sorted, no repeats.
export type Selection = { cursor: number; anchor: number; picked: readonly number[] }

export const NO_SELECTION: Selection = { cursor: 0, anchor: 0, picked: [] }

const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b)

export const select = (_sel: Selection, to: number): Selection => ({ cursor: to, anchor: to, picked: [] })

export function extend(sel: Selection, to: number): Selection {
  const [lo, hi] = sel.anchor <= to ? [sel.anchor, to] : [to, sel.anchor]
  return { cursor: to, anchor: sel.anchor, picked: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) }
}

export function toggle(sel: Selection, i: number): Selection {
  const picked = sel.picked.includes(i) ? sel.picked.filter(p => p !== i) : sorted([...sel.picked, i])
  return { cursor: i, anchor: i, picked }
}

export const clear = (sel: Selection): Selection => ({ cursor: sel.cursor, anchor: sel.cursor, picked: [] })

// The rows an action takes: the picked ones, else the cursor's.
export const targets = (sel: Selection): number[] => (sel.picked.length ? [...sel.picked] : [sel.cursor])

// After a move: `moved` are the new places of targets(sel), in the same
// order; the cursor and anchor follow the rows they were on.
export function remap(sel: Selection, moved: readonly number[]): Selection {
  const from = targets(sel)
  const follow = (i: number) => {
    const k = from.indexOf(i)
    return k >= 0 && k < moved.length ? moved[k] : i
  }
  return { cursor: follow(sel.cursor), anchor: follow(sel.anchor), picked: sel.picked.length ? sorted(moved) : [] }
}

export function clamp(sel: Selection, count: number): Selection {
  const last = Math.max(0, count - 1)
  return {
    cursor: Math.min(sel.cursor, last),
    anchor: Math.min(sel.anchor, last),
    picked: sel.picked.filter(i => i < count),
  }
}

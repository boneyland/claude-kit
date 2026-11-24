import React, { createContext, useContext, useEffect, useRef } from 'react'
import { Box, type BoxProps, type DOMElement } from 'ink'
import type { MouseSource } from './sgr'

// Two presses on one box this close together are a double-click.
export const DOUBLE_MS = 400

export type Rect = { x: number; y: number; width: number; height: number }
// Where a press landed, from the box's top left.
export type Hit = { x: number; y: number; isDouble: boolean }
type Handlers = { onClick?(hit: Hit): void; onWheel?(dir: 'up' | 'down'): void }
type Entry = { node: React.RefObject<DOMElement>; handlers: React.MutableRefObject<Handlers> }

// A box's place on screen, from the layout Ink computed for it (the same data
// Ink's measureElement reads), summed up through its parents.
export function rectOf(node: DOMElement): Rect {
  let [x, y] = [0, 0]
  for (let n: DOMElement | undefined = node; n; n = n.parentNode) {
    x += n.yogaNode?.getComputedLeft() ?? 0
    y += n.yogaNode?.getComputedTop() ?? 0
  }
  return { x, y, width: node.yogaNode?.getComputedWidth() ?? 0, height: node.yogaNode?.getComputedHeight() ?? 0 }
}

const depth = (node: DOMElement) => {
  let d = 0
  for (let n = node.parentNode; n; n = n.parentNode) d++
  return d
}

const Registry = createContext<Map<number, Entry> | undefined>(undefined)

// Hands each mouse event from `source` to the innermost Clickable under it
// that takes that kind: presses of the left button to onClick, the wheel to
// onWheel. The app is drawn from the screen's top left, so layout positions
// are screen positions.
export function MouseProvider({ source, now = Date.now, children }: { source?: MouseSource; now?: () => number; children: React.ReactNode }) {
  const entries = useRef(new Map<number, Entry>()).current
  const last = useRef<{ id: number; at: number } | undefined>(undefined)
  const clock = useRef(now)
  clock.current = now
  useEffect(
    () =>
      source?.(e => {
        const isWheel = e.kind === 'wheel'
        if (!isWheel && (e.kind !== 'press' || e.button !== 'left')) return
        let best: { id: number; entry: Entry; rect: Rect; depth: number } | undefined
        for (const [id, entry] of entries) {
          const node = entry.node.current
          if (!node || !(isWheel ? entry.handlers.current.onWheel : entry.handlers.current.onClick)) continue
          const rect = rectOf(node)
          if (e.x < rect.x || e.y < rect.y || e.x >= rect.x + rect.width || e.y >= rect.y + rect.height) continue
          const d = depth(node)
          if (!best || d > best.depth) best = { id, entry, rect, depth: d }
        }
        if (!best) return
        if (isWheel) return best.entry.handlers.current.onWheel?.(e.dir ?? 'down')
        const at = clock.current()
        const isDouble = last.current?.id === best.id && at - last.current.at <= DOUBLE_MS
        last.current = isDouble ? undefined : { id: best.id, at }
        best.entry.handlers.current.onClick?.({ x: e.x - best.rect.x, y: e.y - best.rect.y, isDouble })
      }),
    [source, entries],
  )
  return <Registry.Provider value={entries}>{children}</Registry.Provider>
}

let nextId = 1

// A Box that takes clicks and the wheel. Outside a MouseProvider, a plain Box.
export function Clickable({ onClick, onWheel, children, ...box }: BoxProps & Handlers & { children?: React.ReactNode }) {
  const entries = useContext(Registry)
  const node = useRef<DOMElement>(null)
  const handlers = useRef<Handlers>({})
  handlers.current = { onClick, onWheel }
  const id = useRef(0)
  if (!id.current) id.current = nextId++
  useEffect(() => {
    if (!entries) return
    entries.set(id.current, { node, handlers })
    return () => void entries.delete(id.current)
  }, [entries])
  return (
    <Box ref={node} {...box}>
      {children}
    </Box>
  )
}

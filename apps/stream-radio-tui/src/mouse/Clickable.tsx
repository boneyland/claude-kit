import React, { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { Box, type BoxProps, type DOMElement } from 'ink'
import { NO_MODS, type Mods, type MouseSource } from './sgr'

// Two presses on one box this close together are a double-click.
export const DOUBLE_MS = 400

export type Rect = { x: number; y: number; width: number; height: number }
// Where a press landed, from the box's top left.
export type Hit = { x: number; y: number; isDouble: boolean; mods: Mods }
export type Point = { x: number; y: number }
// onDrag and onRelease: after a left press on this box, the pointer moving
// with the button held, and the button let go, wherever on screen (the point
// is still from this box's top left, so it may be outside it).
// onRightClick: a press of the right button.
// layer: a box drawn over others (a menu) takes the press first, whatever its depth.
type Handlers = { layer?: number; onClick?(hit: Hit): void; onRightClick?(hit: Hit): void; onWheel?(dir: 'up' | 'down'): void; onDrag?(at: Point): void; onRelease?(at: Point): void }
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
// onWheel. Drags and the release after a press go to the box pressed. The app is drawn from the screen's top left, so layout positions
// are screen positions.
export function MouseProvider({ source, now = Date.now, children }: { source?: MouseSource; now?: () => number; children: React.ReactNode }) {
  const entries = useRef(new Map<number, Entry>()).current
  const last = useRef<{ id: number; at: number } | undefined>(undefined)
  const clock = useRef(now)
  clock.current = now
  const pressed = useRef<Entry | undefined>(undefined)
  useEffect(
    () =>
      source?.(e => {
        if (e.button === 'left' && (e.kind === 'drag' || e.kind === 'release')) {
          const entry = pressed.current
          if (e.kind === 'release') pressed.current = undefined
          const node = entry?.node.current
          if (!entry || !node) return
          const rect = rectOf(node)
          const at = { x: e.x - rect.x, y: e.y - rect.y }
          return e.kind === 'drag' ? entry.handlers.current.onDrag?.(at) : entry.handlers.current.onRelease?.(at)
        }
        const isWheel = e.kind === 'wheel'
        const isRight = e.kind === 'press' && e.button === 'right'
        if (!isWheel && !isRight && (e.kind !== 'press' || e.button !== 'left')) return
        let best: { id: number; entry: Entry; rect: Rect; depth: number; layer: number } | undefined
        for (const [id, entry] of entries) {
          const node = entry.node.current
          const takes = isWheel ? entry.handlers.current.onWheel : isRight ? entry.handlers.current.onRightClick : entry.handlers.current.onClick
          if (!node || !takes) continue
          const rect = rectOf(node)
          if (e.x < rect.x || e.y < rect.y || e.x >= rect.x + rect.width || e.y >= rect.y + rect.height) continue
          const d = depth(node)
          const layer = entry.handlers.current.layer ?? 0
          if (!best || layer > best.layer || (layer === best.layer && d > best.depth)) best = { id, entry, rect, depth: d, layer }
        }
        if (!isWheel) pressed.current = undefined
        if (!best) return
        if (isWheel) return best.entry.handlers.current.onWheel?.(e.dir ?? 'down')
        if (isRight) return best.entry.handlers.current.onRightClick?.({ x: e.x - best.rect.x, y: e.y - best.rect.y, isDouble: false, mods: e.mods ?? NO_MODS })
        const at = clock.current()
        const isDouble = last.current?.id === best.id && at - last.current.at <= DOUBLE_MS
        last.current = isDouble ? undefined : { id: best.id, at }
        pressed.current = best.entry
        best.entry.handlers.current.onClick?.({ x: e.x - best.rect.x, y: e.y - best.rect.y, isDouble, mods: e.mods ?? NO_MODS })
      }),
    [source, entries],
  )
  return <Registry.Provider value={entries}>{children}</Registry.Provider>
}

let nextId = 1

// A Box that takes clicks, drags and the wheel. Outside a MouseProvider, a plain Box.
export function Clickable({ layer, onClick, onRightClick, onWheel, onDrag, onRelease, children, ...box }: BoxProps & Handlers & { children?: React.ReactNode }) {
  const entries = useContext(Registry)
  const node = useRef<DOMElement>(null)
  const handlers = useRef<Handlers>({})
  handlers.current = { layer, onClick, onRightClick, onWheel, onDrag, onRelease }
  const id = useRef(0)
  if (!id.current) id.current = nextId++
  // At commit, with the rows: a click right after a redraw finds the box.
  useLayoutEffect(() => {
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

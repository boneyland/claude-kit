// The desktop panel's pixel crabs, drawn into PNG frames for the terminal's
// Image element. The costumes are the same Fill drawings the SVG crabs use; the
// SVG's CSS motions are replayed here, one frame per 125 ms, so a cycle of 8
// frames is one second, the longest period any of them has.

import { encodePng } from './png'

export type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

/** The crab's 30×28 grid, padded a pixel each side so it fills 9×4 cells (cells twice as tall as wide). */
export const SPRITE_W = 32
export const SPRITE_H = 28
const PAD_X = 1
/** Each sprite pixel is sent as a 4×4 block, so a terminal that smooths what it scales stays sharp. */
const SCALE = 4
export const SPRITE_FRAMES = 8
export const SPRITE_COLS = 9
export const SPRITE_ROWS = 4

type Rgba = [number, number, number, number]

const parseColor = (c: string): Rgba => {
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(c)
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
  let hex = c.replace('#', '')
  if (hex.length === 3) hex = [...hex].map(h => h + h).join('')
  const n = parseInt(hex, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
}

// One group's motion at a moment: translate, then rotate, skew and scale about
// an origin given as a fraction of the group's box, and an opacity.
type Motion = { tx?: number; ty?: number; rot?: number; sx?: number; sy?: number; skewY?: number; op?: number; ox?: number; oy?: number }

const frac = (v: number) => v - Math.floor(v)
// steps(1) keyframes at 0% and 50%: the second half of each period.
const secondHalf = (s: number, period: number, delay = 0) => frac((s + delay) / period) >= 0.5
const ease = (t: number) => t * t * (3 - 2 * t)
// 0 → 1 at the middle → 0, eased: a keyframe at 50% alone.
const there = (p: number) => ease(p < 0.5 ? p * 2 : 2 - p * 2)

// The CSS in register.tsx's CRAB_CSS, by costume and group, at `s` seconds.
const motionOf = (costume: string, cls: string, s: number): Motion => {
  if (costume === 'fable') {
    if (cls === 'ant') return { op: secondHalf(s, 1) ? 0.15 : 1 }
    if (cls === 'star') return { op: secondHalf(s, 0.5, 0.25) ? 0.15 : 1 }
    return {}
  }
  const legPeriod = costume === 'light' ? 0.25 : 0.5
  if (cls === 'la') return { ty: secondHalf(s, legPeriod) ? -1 : 0 }
  if (cls === 'lb') return { ty: secondHalf(s, legPeriod, legPeriod / 2) ? -1 : 0 }
  if (cls === 'bd') return { ty: secondHalf(s, 0.5, 0.125) ? 1 : 0 }
  if (costume === 'heavy' && cls === 'it') {
    const q = Math.floor(frac(s) * 4)
    const d = [0, 1, 2, 1][q]!
    return { tx: -d, ty: d }
  }
  if (costume === 'heavy' && cls === 'gl') return { op: secondHalf(s, 1, 0.5) ? 0.15 : 1 }
  if (costume === 'careful' && cls === 'it') return { rot: -35 * there(frac(s / 0.5)), ox: 1, oy: 1 }
  if (costume === 'medium' && cls === 'pan') {
    const p = frac(s)
    const k = p < 0.2 ? ease(p / 0.2) : p < 0.4 ? 1 : 1 - ease((p - 0.4) / 0.6)
    return { rot: -12 * k, ox: 0, oy: 0.5 }
  }
  if (costume === 'medium' && cls === 'egg') {
    const p = frac(s)
    if (p < 0.3) {
      const t = ease(p / 0.3)
      return { ty: -5 * t, sy: 1 - 2 * t }
    }
    if (p < 0.6) {
      const t = ease((p - 0.3) / 0.3)
      return { ty: -5 * (1 - t), sy: -1 + 2 * t }
    }
    return {}
  }
  if (costume === 'light' && cls === 'flag') return secondHalf(s, 0.25) ? { skewY: -12, sx: 0.85, ox: 0, oy: 0.5 } : {}
  if (costume === 'explore' && cls === 'it') return { rot: 25 * there(frac(s / 0.5)), ox: 0.5, oy: 1 }
  return {}
}

// Each pixel keeps every color drawn on it, in order: the dome tints the body under it.
type Group = { cls: string; px: Map<number, Rgba[]>; x0: number; y0: number; x1: number; y1: number }

const groupsOf = (draw: (f: Fill) => void): Group[] => {
  const byCls = new Map<string, Group>()
  const f: Fill = (x, y, w, h, c, cls = 'bd') => {
    let g = byCls.get(cls)
    if (!g) byCls.set(cls, (g = { cls, px: new Map(), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }))
    const color = parseColor(c)
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const key = yy * 64 + xx
        const stack = g.px.get(key)
        if (stack) stack.push(color)
        else g.px.set(key, [color])
      }
    }
    g.x0 = Math.min(g.x0, x)
    g.y0 = Math.min(g.y0, y)
    g.x1 = Math.max(g.x1, x + w)
    g.y1 = Math.max(g.y1, y + h)
  }
  draw(f)
  // The SVG's order: the body, its props, then the two leg pairs.
  const all = [...byCls.values()]
  const legs = all.filter(g => g.cls === 'la' || g.cls === 'lb')
  return [...all.filter(g => g.cls === 'bd'), ...all.filter(g => !['bd', 'la', 'lb'].includes(g.cls)), ...legs]
}

const over = (dst: Uint8ClampedArray, i: number, [r, g, b, a]: Rgba) => {
  const da = dst[i + 3]! / 255
  const oa = a + da * (1 - a)
  if (oa === 0) return
  dst[i] = (r * a + dst[i]! * da * (1 - a)) / oa
  dst[i + 1] = (g * a + dst[i + 1]! * da * (1 - a)) / oa
  dst[i + 2] = (b * a + dst[i + 2]! * da * (1 - a)) / oa
  dst[i + 3] = oa * 255
}

/** One frame's pixels, SPRITE_W × SPRITE_H RGBA; `frame` 0 to 7, or still. */
export const spritePixels = (costume: string, draw: (f: Fill) => void, frame: number | null): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(SPRITE_W * SPRITE_H * 4)
  const s = frame === null ? 0 : (frame % SPRITE_FRAMES) / SPRITE_FRAMES
  const still = frame === null
  // The astronaut floats as a whole instead of walking.
  const float = !still && costume === 'fable' ? -2 * there(frac(s)) : 0
  const bob = still ? {} : motionOf(costume, 'bd', s)
  for (const g of groupsOf(draw)) {
    const own: Motion = still || g.cls === 'bd' ? {} : motionOf(costume, g.cls, s)
    // Props ride the body's bob; legs step on their own.
    const isLeg = g.cls === 'la' || g.cls === 'lb'
    const outer = (isLeg ? 0 : (bob.ty ?? 0)) + float
    const ox = g.x0 + (own.ox ?? 0.5) * (g.x1 - g.x0)
    const oy = g.y0 + (own.oy ?? 0.5) * (g.y1 - g.y0)
    const th = ((own.rot ?? 0) * Math.PI) / 180
    const k = Math.tan(((own.skewY ?? 0) * Math.PI) / 180)
    // Forward M = rotate · skewY · scale; sample the source through its inverse.
    const sx = own.sx ?? 1
    const sy = own.sy ?? 1
    const [c, sn] = [Math.cos(th), Math.sin(th)]
    const m = [c * sx + -sn * k * sx, -sn * sy, sn * sx + c * k * sx, c * sy] // [a b; c d]
    const det = m[0]! * m[3]! - m[1]! * m[2]!
    if (Math.abs(det) < 1e-6) continue
    const opacity = own.op ?? 1
    for (let y = 0; y < SPRITE_H; y++) {
      for (let x = 0; x < SPRITE_W; x++) {
        const qx = x + 0.5 - PAD_X - (own.tx ?? 0) - ox
        const qy = y + 0.5 - outer - (own.ty ?? 0) - oy
        const px = ox + (m[3]! * qx - m[1]! * qy) / det
        const py = oy + (-m[2]! * qx + m[0]! * qy) / det
        const stack = g.px.get(Math.floor(py) * 64 + Math.floor(px))
        if (!stack || px < 0 || py < 0) continue
        for (const color of stack) over(out, (y * SPRITE_W + x) * 4, [color[0], color[1], color[2], color[3] * opacity])
      }
    }
  }
  return out
}

/** The frame as a PNG, each pixel a SCALE × SCALE block. */
export const spritePng = (pixels: Uint8ClampedArray): Uint8Array => {
  const w = SPRITE_W * SCALE
  const h = SPRITE_H * SCALE
  const big = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (Math.floor(y / SCALE) * SPRITE_W + Math.floor(x / SCALE)) * 4
      big.set(pixels.subarray(from, from + 4), (y * w + x) * 4)
    }
  }
  return encodePng(big, w, h)
}

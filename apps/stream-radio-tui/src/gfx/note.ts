// The picture shown when a song has no art: a big eighth note inside a
// rounded frame, on a see-through background. Drawn from shapes, smoothed by
// sampling each pixel 3 × 3 times.

export const NOTE_COLORS = { note: [120, 120, 120], frame: [70, 70, 70] } as const

const SS = 3

// The note in a unit square, y down: an oval head tilted up to the right, a
// stem up its right side, a flag curving down from the stem's top.
const HEAD = { x: 0.4, y: 0.72, rx: 0.14, ry: 0.1, cos: Math.cos(-0.44), sin: Math.sin(-0.44) }
const STEM = { x0: 0.49, x1: 0.54, y0: 0.18, y1: 0.72 }
// The flag: points along a curve, each with its half-thickness.
const FLAG = (() => {
  const [p0, p1, p2, p3] = [[0.515, 0.19], [0.56, 0.33], [0.76, 0.36], [0.7, 0.6]]
  const pts: [number, number, number][] = []
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t ** 2, d = t ** 3
    pts.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], 0.032 - 0.016 * t])
  }
  return pts
})()

// The flag's segments, flat: ax ay ar bx by br, then each one's bounds
// (thickness included), so a point far from it costs four comparisons.
const SEGS = (() => {
  const out: number[] = []
  for (let i = 1; i < FLAG.length; i++) {
    const [ax, ay, ar] = FLAG[i - 1]
    const [bx, by, br] = FLAG[i]
    const r = Math.max(ar, br)
    out.push(ax, ay, ar, bx, by, br, Math.min(ax, bx) - r, Math.max(ax, bx) + r, Math.min(ay, by) - r, Math.max(ay, by) + r)
  }
  return Float64Array.from(out)
})()
const SEG = 10

// The note's bounds in the unit square, with room to spare: no point outside
// them is tested.
const NOTE_BOX = (() => {
  const reach = Math.max(HEAD.rx, HEAD.ry)
  let [x0, x1, y0, y1] = [Math.min(HEAD.x - reach, STEM.x0), Math.max(HEAD.x + reach, STEM.x1), Math.min(HEAD.y - reach, STEM.y0), Math.max(HEAD.y + reach, STEM.y1)]
  for (let i = 0; i < SEGS.length; i += SEG) {
    x0 = Math.min(x0, SEGS[i + 6])
    x1 = Math.max(x1, SEGS[i + 7])
    y0 = Math.min(y0, SEGS[i + 8])
    y1 = Math.max(y1, SEGS[i + 9])
  }
  return { x0: x0 - 0.01, x1: x1 + 0.01, y0: y0 - 0.01, y1: y1 + 0.01 }
})()

// Allocates nothing: it runs nine times a pixel, on the thread that reads the keys.
function inNote(u: number, v: number): boolean {
  const dx = u - HEAD.x
  const dy = v - HEAD.y
  const hx = dx * HEAD.cos + dy * HEAD.sin
  const hy = -dx * HEAD.sin + dy * HEAD.cos
  if ((hx / HEAD.rx) ** 2 + (hy / HEAD.ry) ** 2 <= 1) return true
  if (u >= STEM.x0 && u <= STEM.x1 && v >= STEM.y0 && v <= STEM.y1) return true
  for (let i = 0; i < SEGS.length; i += SEG) {
    if (u < SEGS[i + 6] || u > SEGS[i + 7] || v < SEGS[i + 8] || v > SEGS[i + 9]) continue
    const ax = SEGS[i]
    const ay = SEGS[i + 1]
    const ar = SEGS[i + 2]
    const ex = SEGS[i + 3] - ax
    const ey = SEGS[i + 4] - ay
    const t = Math.max(0, Math.min(1, ((u - ax) * ex + (v - ay) * ey) / (ex * ex + ey * ey)))
    const r = ar + (SEGS[i + 5] - ar) * t
    if ((u - ax - ex * t) ** 2 + (v - ay - ey * t) ** 2 <= r * r) return true
  }
  return false
}

// Signed distance from (x, y) to a w × h box's rounded edge: negative inside.
function boxDistance(x: number, y: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - w / 2) - (w / 2 - r)
  const qy = Math.abs(y - h / 2) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

// The last placeholder drawn: each song without art shows it again, at the
// same size.
let last: { width: number; height: number; rgba: Uint8Array } | undefined

// The placeholder at width × height pixels: the frame round the edge, the
// note in the middle square. Only pixels near the note or the frame are
// sampled; the rest stay see-through.
export function noteRgba(width: number, height: number): Uint8Array {
  if (last && last.width === width && last.height === height) return last.rgba
  const rgba = new Uint8Array(width * height * 4)
  const side = Math.min(width, height)
  const [ox, oy] = [(width - side) / 2, (height - side) / 2]
  const stroke = Math.max(2, side * 0.015)
  const corner = side * 0.08
  // pixels this far in from every edge are inside the frame's inner edge
  const band = Math.ceil(corner + stroke) + 1
  const [nx0, nx1] = [Math.floor(ox + NOTE_BOX.x0 * side), Math.ceil(ox + NOTE_BOX.x1 * side)]
  const [ny0, ny1] = [Math.floor(oy + NOTE_BOX.y0 * side), Math.ceil(oy + NOTE_BOX.y1 * side)]
  for (let y = 0; y < height; y++) {
    const nearY = y < band || y >= height - band
    const noteY = y >= ny0 && y <= ny1
    for (let x = 0; x < width; x++) {
      const nearFrame = nearY || x < band || x >= width - band
      const nearNote = noteY && x >= nx0 && x <= nx1
      if (!nearFrame && !nearNote) continue
      let note = 0
      let frame = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (nearNote && inNote((px - ox) / side, (py - oy) / side)) note++
          else if (nearFrame) {
            const d = boxDistance(px, py, width, height, corner)
            if (d <= 0 && d >= -stroke) frame++
          }
        }
      }
      if (!note && !frame) continue
      const c = note >= frame ? NOTE_COLORS.note : NOTE_COLORS.frame
      const p = (y * width + x) * 4
      rgba[p] = c[0]
      rgba[p + 1] = c[1]
      rgba[p + 2] = c[2]
      rgba[p + 3] = Math.round(((note + frame) / (SS * SS)) * 255)
    }
  }
  last = { width, height, rgba }
  return rgba
}

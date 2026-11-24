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

function inNote(u: number, v: number): boolean {
  const dx = u - HEAD.x
  const dy = v - HEAD.y
  const hx = dx * HEAD.cos + dy * HEAD.sin
  const hy = -dx * HEAD.sin + dy * HEAD.cos
  if ((hx / HEAD.rx) ** 2 + (hy / HEAD.ry) ** 2 <= 1) return true
  if (u >= STEM.x0 && u <= STEM.x1 && v >= STEM.y0 && v <= STEM.y1) return true
  for (let i = 1; i < FLAG.length; i++) {
    const [ax, ay, ar] = FLAG[i - 1]
    const [bx, by, br] = FLAG[i]
    const [ex, ey] = [bx - ax, by - ay]
    const t = Math.max(0, Math.min(1, ((u - ax) * ex + (v - ay) * ey) / (ex * ex + ey * ey)))
    const r = ar + (br - ar) * t
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

// The placeholder at width × height pixels: the frame round the edge, the
// note in the middle square.
export function noteRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const side = Math.min(width, height)
  const [ox, oy] = [(width - side) / 2, (height - side) / 2]
  const stroke = Math.max(2, side * 0.015)
  const corner = side * 0.08
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let note = 0
      let frame = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [px, py] = [x + (sx + 0.5) / SS, y + (sy + 0.5) / SS]
          if (inNote((px - ox) / side, (py - oy) / side)) note++
          else {
            const d = boxDistance(px, py, width, height, corner)
            if (d <= 0 && d >= -stroke) frame++
          }
        }
      }
      if (!note && !frame) continue
      const [r, g, b] = note >= frame ? NOTE_COLORS.note : NOTE_COLORS.frame
      rgba.set([r, g, b, Math.round(((note + frame) / (SS * SS)) * 255)], (y * width + x) * 4)
    }
  }
  return rgba
}

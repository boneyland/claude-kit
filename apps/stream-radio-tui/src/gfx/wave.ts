import { resample } from '../media/peaks'

// Braille dot bits, top to bottom, for a cell's left and right dot columns.
const LEFT = [0x01, 0x02, 0x04, 0x40]
const RIGHT = [0x08, 0x10, 0x20, 0x80]

// The waveform in braille: `rows` lines of `cols` characters, two values per
// character, mirrored about the middle. Silence still shows as a thin line.
export function brailleWave(peaks: Uint8Array, cols: number, rows = 2): string[] {
  const values = resample(peaks, cols * 2)
  const dotRows = rows * 4
  const mid = dotRows / 2
  const reach = (v: number) => Math.max(1, Math.round((v / 255) * (dotRows / 2)))
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let bits = 0
      for (const [side, value] of [[LEFT, values[c * 2]], [RIGHT, values[c * 2 + 1]]] as const) {
        const k = reach(value)
        for (let d = 0; d < 4; d++) {
          const y = r * 4 + d
          if (y >= mid - k && y < mid + k) bits |= side[d]
        }
      }
      line += String.fromCodePoint(0x2800 + bits)
    }
    lines.push(line)
  }
  return lines
}

export const WAVE_COLORS = { played: [95, 175, 255], unplayed: [128, 128, 128] } as const

// The waveform in pixels on a see-through background: columns left of
// `playedPx` in the played colour, the rest in the unplayed one.
export function waveRgba(peaks: Uint8Array, width: number, height: number, playedPx: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const values = resample(peaks, width)
  const mid = height / 2
  for (let x = 0; x < width; x++) {
    const h = Math.max(1, Math.round((values[x] / 255) * (height / 2)))
    const [r, g, b] = x < playedPx ? WAVE_COLORS.played : WAVE_COLORS.unplayed
    for (let y = Math.max(0, Math.floor(mid - h)); y < Math.min(height, Math.ceil(mid + h)); y++) rgba.set([r, g, b, 255], (y * width + x) * 4)
  }
  return rgba
}

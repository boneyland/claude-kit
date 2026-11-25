import { resample, resampleRms, type Wave } from '../media/peaks'

// Braille dot bits, top to bottom, for a cell's left and right dot columns.
const LEFT = [0x01, 0x02, 0x04, 0x40]
const RIGHT = [0x08, 0x10, 0x20, 0x80]

// How far from the middle a value reaches, in units out of `half`; at least
// one, so silence still shows as a thin line.
const reach = (v: number, half: number) => Math.max(1, Math.round((v / 255) * half))

export type BrailleCell = { ch: string; isRms: boolean }

// The waveform in braille: `rows` lines of `cols` cells, two values per cell,
// mirrored about the middle. The dots follow the peaks; a cell any of whose
// dots fall within the average loudness is marked isRms, to be drawn plainly
// (the rest dimmed), as Audacity draws the rms inside the peaks.
export function brailleWave(wave: Wave, cols: number, rows = 4): BrailleCell[][] {
  const peaks = resample(wave.peak, cols * 2)
  const rms = resampleRms(wave.rms, cols * 2)
  const half = rows * 2
  const mid = rows * 2
  const lines: BrailleCell[][] = []
  for (let r = 0; r < rows; r++) {
    const line: BrailleCell[] = []
    for (let c = 0; c < cols; c++) {
      let bits = 0
      let isRms = false
      for (const [side, i] of [[LEFT, c * 2], [RIGHT, c * 2 + 1]] as const) {
        const k = reach(peaks[i], half)
        const kr = reach(rms[i], half)
        for (let d = 0; d < 4; d++) {
          const y = r * 4 + d
          if (y >= mid - k && y < mid + k) {
            bits |= side[d]
            if (y >= mid - kr && y < mid + kr) isRms = true
          }
        }
      }
      line.push({ ch: String.fromCodePoint(0x2800 + bits), isRms })
    }
    lines.push(line)
  }
  return lines
}

// Average loudness bright, the peaks around it darker; played in blue, the
// rest in grey.
export const WAVE_COLORS = {
  played: { rms: [95, 175, 255], peak: [45, 90, 140] },
  unplayed: { rms: [150, 150, 150], peak: [80, 80, 80] },
} as const

// The waveform in pixels on a see-through background: per column, the peaks
// from the middle out in the peak colour, the average loudness over them in
// the rms colour; columns left of `playedPx` in the played colours.
export function waveRgba(wave: Wave, width: number, height: number, playedPx: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const peaks = resample(wave.peak, width)
  const rms = resampleRms(wave.rms, width)
  const mid = height / 2
  const paint = (x: number, h: number, [r, g, b]: readonly number[]) => {
    for (let y = Math.max(0, Math.floor(mid - h)); y < Math.min(height, Math.ceil(mid + h)); y++) {
      const p = (y * width + x) * 4
      rgba[p] = r
      rgba[p + 1] = g
      rgba[p + 2] = b
      rgba[p + 3] = 255
    }
  }
  for (let x = 0; x < width; x++) {
    const colors = x < playedPx ? WAVE_COLORS.played : WAVE_COLORS.unplayed
    paint(x, reach(peaks[x], mid), colors.peak)
    paint(x, Math.min(reach(rms[x], mid), reach(peaks[x], mid)), colors.rms)
  }
  return rgba
}

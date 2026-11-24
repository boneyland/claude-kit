import type { Art } from '../media/art'
import { deleteImage, placeVirtual, transmitRgba } from './kitty'
import type { Cell } from './probe'
import { MOUSE_OFF } from '../mouse/sgr'

// The pictures on screen: each part (the art, the waveform) owns a run of
// image ids from `firstId`, one image per row of cells.
export type Graphics = {
  cell: Cell
  show(firstId: number, strips: Art[], cols: number): void
  drop(firstId: number, count: number): void
  dropAll(): void
}

// Pictures through the Kitty graphics protocol. Each write is a whole escape
// sequence that moves no cursor, so it is safe between Ink's frames.
export function kittyGraphics(write: (s: string) => void, cell: Cell): Graphics {
  const shown = new Map<number, number>() // firstId → rows shown
  const drop = (firstId: number, from: number, to: number) => {
    let out = ''
    for (let i = from; i < to; i++) out += deleteImage(firstId + i)
    if (out) write(out)
  }
  return {
    cell,
    show(firstId, strips, cols) {
      let out = ''
      strips.forEach((s, i) => (out += transmitRgba(firstId + i, s.width, s.height, s.rgba) + placeVirtual(firstId + i, cols, 1)))
      write(out)
      drop(firstId, strips.length, shown.get(firstId) ?? 0)
      shown.set(firstId, strips.length)
    },
    drop(firstId, count) {
      drop(firstId, 0, Math.max(count, shown.get(firstId) ?? 0))
      shown.delete(firstId)
    },
    dropAll() {
      for (const [firstId, count] of shown) drop(firstId, 0, count)
      shown.clear()
    },
  }
}

const LEAVE_ALT = '\x1b[?1049l'

// Back to the normal screen, the pictures deleted first so none stay behind,
// and the mouse reports off (harmless when they were never on).
export function leaveScreen(graphics: Graphics | undefined, write: (s: string) => void): void {
  graphics?.dropAll()
  write(MOUSE_OFF + LEAVE_ALT)
}

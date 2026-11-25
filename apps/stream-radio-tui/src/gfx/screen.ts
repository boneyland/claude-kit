import { deflate } from 'node:zlib'
import type { Art } from '../media/art'
import { deleteImage, placeVirtual, transmitDeflated } from './kitty'
import type { Cell } from './probe'
import { MOUSE_OFF } from '../mouse/sgr'

// The pictures on screen: each part (the art, the waveform) owns a run of
// image ids from `firstId`, one image per row of cells.
export type Graphics = {
  cell: Cell
  // Resolves once the strips are written, or passed over for a later show or drop.
  show(firstId: number, strips: Art[], cols: number): Promise<void>
  drop(firstId: number, count: number): void
  dropAll(): void
}

const deflated = (rgba: Uint8Array) =>
  new Promise<Buffer>((resolve, reject) => deflate(rgba, (error, out) => (error ? reject(error) : resolve(out))))

// Pictures through the Kitty graphics protocol. Each write is a whole escape
// sequence that moves no cursor, so it is safe between Ink's frames.
//
// The pixels are compressed in libuv's pool, not on the thread that reads the
// keys: a cover's worth takes tens of ms. A show still compressing when a later
// show or drop of the same ids comes is never written, so the screen ends as
// the last call left it.
export function kittyGraphics(write: (s: string) => void, cell: Cell): Graphics {
  const shown = new Map<number, number>() // firstId → rows shown
  const latest = new Map<number, number>() // firstId → the call that counts
  let calls = 0
  const drop = (firstId: number, from: number, to: number) => {
    let out = ''
    for (let i = from; i < to; i++) out += deleteImage(firstId + i)
    if (out) write(out)
  }
  return {
    cell,
    async show(firstId, strips, cols) {
      const call = ++calls
      latest.set(firstId, call)
      let packed: Buffer[]
      try {
        packed = await Promise.all(strips.map(s => deflated(s.rgba)))
      } catch {
        return
      }
      if (latest.get(firstId) !== call) return
      let out = ''
      strips.forEach((s, i) => (out += transmitDeflated(firstId + i, s.width, s.height, packed[i]) + placeVirtual(firstId + i, cols, 1)))
      write(out)
      drop(firstId, strips.length, shown.get(firstId) ?? 0)
      shown.set(firstId, strips.length)
    },
    drop(firstId, count) {
      latest.set(firstId, ++calls)
      drop(firstId, 0, Math.max(count, shown.get(firstId) ?? 0))
      shown.delete(firstId)
    },
    dropAll() {
      for (const firstId of latest.keys()) latest.set(firstId, ++calls)
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

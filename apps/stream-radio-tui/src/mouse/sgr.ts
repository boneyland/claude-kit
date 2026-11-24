// The terminal's mouse reports, in SGR form: ESC [ < button ; column ; row,
// then M for a press (or wheel) and m for a release. Turned on with ?1000
// (presses, releases, the wheel) and ?1006 (this form).

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'

// x, y: 0-based cells from the screen's top left.
export type MouseEvent = { kind: 'press' | 'release' | 'wheel'; button: 'left' | 'middle' | 'right' | 'none'; dir?: 'up' | 'down'; x: number; y: number }

export type MouseSource = (fn: (e: MouseEvent) => void) => () => void

const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
// The start of a report cut off by the end of a read. A bare ESC or ESC [
// is not held: it may be the Escape key or an arrow, which must not wait.
const PART = /\x1b\[<[\d;]*$/
const BUTTONS = ['left', 'middle', 'right'] as const

function eventOf(code: number, col: number, row: number, end: string): MouseEvent | undefined {
  const [x, y] = [col - 1, row - 1]
  if (code & 32) return undefined // motion
  // 66 and 67: a sideways wheel or touchpad swipe, which the list has no use for
  if (code & 64) return code & 2 ? undefined : { kind: 'wheel', button: 'none', dir: code & 1 ? 'down' : 'up', x, y }
  const button = BUTTONS[code & 3]
  if (!button) return undefined
  return { kind: end === 'M' ? 'press' : 'release', button, x, y }
}

// `held` (a report's start from the read before) and `chunk` split into the
// key text, which goes on to Ink, and the mouse events; `held` is what to
// keep for the next read.
export function splitMouse(held: string, chunk: string): { text: string; events: MouseEvent[]; held: string } {
  let all = held + chunk
  const part = PART.exec(all)
  const keep = part ? part[0] : ''
  if (keep) all = all.slice(0, -keep.length)
  const events: MouseEvent[] = []
  const text = all.replace(REPORT, (_m, code: string, col: string, row: string, end: string) => {
    const e = eventOf(Number(code), Number(col), Number(row), end)
    if (e) events.push(e)
    return ''
  })
  return { text, events, held: keep }
}

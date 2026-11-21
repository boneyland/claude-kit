// mpv prints one status line per update; we ask it for
// "NP<TAB>title<TAB>icy<TAB>meta<TAB>pause<TAB>seconds<TAB>chapter<TAB>END". mpv ends no line:
// it starts the next update with a newline, so END is what marks a line as whole.
export const STATUS_FORMAT =
  'NP\t${media-title:}\t${metadata/by-key/icy-title:}\t${metadata/by-key/title:}\t${pause:}\t${?percent-pos:${=time-pos}}\t${chapter-metadata/by-key/title:}\tEND'

// seconds: how far into the current file, whole seconds; null for a live stream
// (mpv has a percentage only for a file with an end, so the field is empty then).
// isPaused: null when the line does not say (a cut-off line), so nothing changes.
// chapter: the current chapter's title, empty when the file has none; null for a
// cut-off line. A video of several songs often names each song in a chapter.
export type Track = {
  title: string
  isPaused: boolean | null
  seconds: number | null
  chapter: string | null
}

// The last complete NP line in a chunk of mpv output (lines end in \r or \n).
// A song title (stream metadata) wins over the page's media title.
export function parseNowPlaying(text: string): Track | undefined {
  const lines = text.split(/[\r\n]+/).filter(line => line.startsWith('NP\t'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  const [, media = '', icy = '', meta = '', pause = '', pos = '', chapter = ''] = last.split('\t')
  const title = icy.trim() || meta.trim() || media.trim()

  const seconds = pos.trim() === '' || Number.isNaN(Number(pos)) ? null : Math.max(0, Math.floor(Number(pos)))

  const isPaused = pause.trim() === 'yes' ? true : pause.trim() === 'no' ? false : null

  // a cut-off line can end inside the chapter field; END marks it as whole
  const chapterTitle = last.endsWith('\tEND') ? chapter.trim() : null

  return title ? { title, isPaused, seconds, chapter: chapterTitle } : undefined
}

// mpv's output arrives in pieces that do not line up with its lines, and it
// does not end a status line until the next one is printed. Splits what has been
// read into the whole lines (up to the last END marker) and the unfinished rest,
// which waits for the next piece.
export function completeLines(buffer: string): { complete: string; rest: string } {
  const mark = buffer.lastIndexOf('\tEND')
  if (mark < 0) return { complete: '', rest: buffer.length > 10000 ? '' : buffer }
  const cut = mark + '\tEND'.length

  return { complete: buffer.slice(0, cut), rest: buffer.slice(cut) }
}

// A position as m:ss, or h:mm:ss from an hour on.
export function formatTime(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

export type Command =
  | { kind: 'stop' }
  | { kind: 'toggle' }
  | { kind: 'last' }
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'panel' }
  | { kind: 'play'; url: string }
  | { kind: 'error'; text: string }

export function parseArgs(args: string, fallback: string): Command {
  const word = args.trim()
  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  if (word === 'pause' || word === 'resume' || word === 'toggle') return { kind: 'toggle' }
  if (word === 'last') return { kind: 'last' }
  if (word === 'next') return { kind: 'next' }
  if (word === 'prev' || word === 'previous') return { kind: 'prev' }
  if (word === 'panel') return { kind: 'panel' }
  const url = word || fallback
  if (!url) return { kind: 'error', text: 'Usage: /stream <url> | last | pause | next | prev | panel | stop' }
  if (!/^https?:\/\/\S+$/.test(url)) {
    return { kind: 'error', text: `Not an http(s) URL: ${url}` }
  }

  return { kind: 'play', url }
}

// Terminal cells one code point takes: 0 for combining marks and joiners, 2 for
// wide characters (CJK, Hangul, fullwidth forms, most emoji, the media-control
// symbols), 1 for the rest. Close enough for a song title, without a table.
export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f)) {
    return 0
  }
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x23e9 && c <= 0x23fa) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function textWidth(text: string): number {
  let w = 0
  for (const ch of text) w += cellWidth(ch)
  return w
}

// The footer button's whole label, icon and time included, at most this many cells.
export const LABEL_COLUMNS = 40
// Between the end of a scrolling title and its start coming round again.
const MARQUEE_GAP = '   ·   '
// Ticks the title rests at its start each time round, so its beginning can be read.
export const MARQUEE_HOLD = 4
// Characters the title moves each tick.
export const MARQUEE_STEP = 2

// What fits after the fixed part of the label.
export const titleColumns = (prefix: string) => Math.max(1, LABEL_COLUMNS - textWidth(prefix))

// `text` in a window `width` cells wide, `tick` steps along: as is when it fits,
// else scrolling left MARQUEE_STEP characters a tick, looping through a gap, resting
// MARQUEE_HOLD ticks at the start of each round. Padded to `width` when a wide
// character would straddle the window's edge, so the label never jitters.
export function marquee(text: string, width: number, tick: number): string {
  if (textWidth(text) <= width) return text
  const loop = Array.from(text + MARQUEE_GAP)
  const steps = Math.ceil(loop.length / MARQUEE_STEP)
  const round = steps + MARQUEE_HOLD
  const step = Math.max(0, (((tick % round) + round) % round) - MARQUEE_HOLD) * MARQUEE_STEP
  let out = ''
  let used = 0
  for (let i = 0; used < width; i++) {
    const ch = loop[(step + i) % loop.length]!
    const w = cellWidth(ch)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out + ' '.repeat(width - used)
}

// The properties each session watches on the shared player's IPC socket.
export const WATCHED = [
  'media-title',
  'metadata',
  'pause',
  'duration',
  'chapter-metadata',
  'chapter',
  'playlist-pos',
  'playlist-count',
  'volume',
  'loop-file',
  'loop-playlist',
  'user-data/stream-radio/url',
  // a count another program raises after editing the queue: read it again
  'user-data/stream-radio/edited',
  // last: its first value means a player already playing, and finds the rest known
  'time-pos',
] as const

// One line of the watcher's output: a property change, or a file starting,
// loaded or ended (with why: eof, stop, quit, error, redirect).
export type PlayerEvent =
  | { event: 'property-change'; name: string; data?: unknown }
  | { event: 'start-file' | 'file-loaded' }
  | { event: 'end-file'; reason?: string; file_error?: string }

// The watcher's output arrives in pieces that do not line up with its lines:
// the whole lines read so far, as events, and the unfinished rest. A rest that
// grows past any sane line is dropped rather than kept growing.
export function splitEvents(buffer: string): { events: PlayerEvent[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const events: PlayerEvent[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && typeof (value as { event?: unknown }).event === 'string') events.push(value as PlayerEvent)
    } catch {
      // not a line of ours
    }
  }
  return { events, rest: rest.length > 1_000_000 ? '' : rest }
}

// A metadata map's value for `key`, any case (stream tags come as icy-title,
// files' as title or TITLE); empty when absent.
// C0 and C1 control characters, ESC among them. Titles, tags, chapter and
// file names come from files and sites anyone can make, and the screens that
// draw them would pass an escape sequence on to the terminal: OSC 52 sets the
// clipboard, others make the terminal answer into the input.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

// `text` without control characters; a line break or tab becomes a space.
export const plain = (text: string): string => text.replace(/[\t\n\r]/g, ' ').replace(CONTROL, '')

export function metaValue(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object') return ''
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (k.toLowerCase() === key && typeof v === 'string') return plain(v).trim()
  }
  return ''
}

// What the footer shows: a song title (stream metadata) wins over the page's
// media title.
export const trackTitle = (media: unknown, meta: unknown) =>
  metaValue(meta, 'icy-title') || metaValue(meta, 'title') || (typeof media === 'string' ? plain(media).trim() : '')

// The repeat mode mpv's loop-file and loop-playlist amount to.
export function repeatOf(loopFile: unknown, loopPlaylist: unknown): 'all' | 'one' | 'off' {
  const on = (v: unknown) => v !== undefined && v !== 'no' && v !== false && v !== 0
  return on(loopFile) ? 'one' : on(loopPlaylist) ? 'all' : 'off'
}

// A position as m:ss, or h:mm:ss from an hour on.
export function formatTime(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

// The terminal player's click rounding on its volume bar.
export const VOLUME_STEP = 5
export const clampVolume = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

// mpv's volume is cubic (loudness in dB is 60·log10(volume / 100)), so steps
// of a fixed size are 1 dB apart near the top and 18 dB near the bottom.
// One step multiplies or divides the volume by this, 3 dB either way.
const STEP_RATIO = 10 ** (3 / 60)
// The quietest step above silence (−78 dB): below it, a step down is silence.
const LOWEST = 5

// The volume one step up (dir 1) or down (-1) from `level`, each step the same
// change in loudness: the panel's − and +, /stream vol up and down, the
// terminal player's keys. The number stays mpv's own volume.
export function stepVolume(level: number, dir: 1 | -1): number {
  const at = clampVolume(level)
  if (dir > 0) return at < LOWEST ? LOWEST : Math.min(100, Math.max(at + 1, Math.round(at * STEP_RATIO)))
  return at <= LOWEST ? 0 : Math.max(LOWEST, Math.min(at - 1, Math.round(at / STEP_RATIO)))
}

// Whether the playlist starts over at its end (all), the song plays again (one),
// or playback ends (off).
export type Repeat = 'all' | 'one' | 'off'
export const nextRepeat = (r: Repeat): Repeat => (r === 'all' ? 'one' : r === 'one' ? 'off' : 'all')
// mpv's loop-file and loop-playlist for a repeat mode.
export const loopsFor = (r: Repeat) => ({ file: r === 'one' ? 'inf' : 'no', playlist: r === 'off' ? 'no' : 'inf' })

export type Command =
  | { kind: 'stop' }
  | { kind: 'toggle' }
  | { kind: 'last' }
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'panel' }
  | { kind: 'shuffle' }
  // mode: absent cycles all → one → off
  | { kind: 'repeat'; mode?: Repeat }
  // to: a level from 0 to 100; step: one step up or down from where it is
  | { kind: 'volume'; to?: number; step?: 1 | -1 }
  // seconds: where to go, or with isRelative how far from where it is (- back)
  | { kind: 'seek'; seconds: number; isRelative?: true }
  // url: an http(s) URL, or an absolute path when isLocal
  | { kind: 'play'; url: string; isLocal?: true }
  | { kind: 'error'; text: string }

// Where a local path is read from: the home folder for `~`, the session's folder
// for a relative path.
export type Where = { home: string; cwd: string }

const USAGE = 'Usage: /stream <url | file | folder> | last | pause | next | prev | vol [0-100 | up | down] | seek [+|-]<m:ss> | shuffle | repeat [all | one | off] | panel | stop'

// A URL, or a local file, folder or playlist as an absolute path: `~/…`,
// `/…`, `file://…` or relative to the session's folder. Quotes around it go.
// Whether the path exists is the caller's to check.
export function resolveTarget(raw: string, where: Where): Command {
  const target = raw.replace(/^(['"])(.*)\1$/, '$2').trim()
  if (/^https?:\/\/\S+$/.test(target)) return { kind: 'play', url: target }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith('file://')) {
    return { kind: 'error', text: `Not an http(s) URL or a local path: ${target}` }
  }
  // An mpv option would read as one; a path never needs to start with a dash.
  if (target.startsWith('-')) return { kind: 'error', text: `Not a URL or a path: ${target}` }
  let path = target
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(path.slice('file://'.length))
    } catch {
      return { kind: 'error', text: `Not a file URL: ${target}` }
    }
  }
  if (path === '~' || path.startsWith('~/')) {
    if (!where.home) return { kind: 'error', text: 'No home folder to read ~ from.' }
    path = where.home + path.slice(1)
  } else if (!path.startsWith('/')) {
    if (!where.cwd) return { kind: 'error', text: `Give a full path: ${target}` }
    path = `${where.cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
  }
  return { kind: 'play', url: path, isLocal: true }
}

export function parseArgs(args: string, fallback: string, where: Where = { home: '', cwd: '' }): Command {
  const word = args.trim()
  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  if (word === 'pause' || word === 'resume' || word === 'toggle') return { kind: 'toggle' }
  if (word === 'last') return { kind: 'last' }
  if (word === 'next') return { kind: 'next' }
  if (word === 'prev' || word === 'previous') return { kind: 'prev' }
  if (word === 'panel') return { kind: 'panel' }
  if (word === 'shuffle') return { kind: 'shuffle' }
  const rep = /^repeat(?:\s+(.*))?$/.exec(word)
  if (rep) {
    const mode = (rep[1] ?? '').trim()
    if (mode === '') return { kind: 'repeat' }
    if (mode === 'all' || mode === 'one' || mode === 'off') return { kind: 'repeat', mode }
    return { kind: 'error', text: 'Usage: /stream repeat [all | one | off]' }
  }
  const vol = /^vol(?:ume)?(?:\s+(.*))?$/.exec(word)
  if (vol) {
    const arg = (vol[1] ?? '').trim()
    if (arg === '' ) return { kind: 'volume' }
    if (arg === 'up' || arg === '+') return { kind: 'volume', step: 1 }
    if (arg === 'down' || arg === '-') return { kind: 'volume', step: -1 }
    const n = Number(arg.replace(/%$/, ''))
    if (arg !== '' && Number.isFinite(n)) return { kind: 'volume', to: clampVolume(n) }
    return { kind: 'error', text: 'Usage: /stream vol <0-100 | up | down>' }
  }
  const go = /^seek(?:\s+(.*))?$/.exec(word)
  if (go) {
    const time = /^([+-]?)((?:\d+:){0,2}\d+)$/.exec((go[1] ?? '').trim())
    const parts = time?.[2]?.split(':').map(Number) ?? []
    // seconds and, with hours, minutes are under 60 when a larger part comes first
    if (!time || parts.slice(1).some(n => n >= 60)) return { kind: 'error', text: 'Usage: /stream seek <m:ss | seconds | +seconds | -seconds>' }
    const seconds = parts.reduce((total, n) => total * 60 + n, 0)
    return time[1] ? { kind: 'seek', seconds: time[1] === '-' ? -seconds : seconds, isRelative: true } : { kind: 'seek', seconds }
  }
  const target = word || fallback
  if (!target) return { kind: 'error', text: USAGE }

  return resolveTarget(target, where)
}

// The last part of a path or URL: a local playlist entry's name when its file
// has no title tag.
export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

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
// How long the title rests at its start each time round, so its beginning can be read.
export const MARQUEE_HOLD_MS = 2400
// The defaults of the scrollChars and scrollMs settings.
export const SCROLL_CHARS = 4
export const SCROLL_MS = 1000

// Ticks of `ms` that make up the rest at the start; at least one.
export const holdTicks = (ms: number) => Math.max(1, Math.round(MARQUEE_HOLD_MS / ms))

// What fits after the fixed part of the label.
export const titleColumns = (prefix: string) => Math.max(1, LABEL_COLUMNS - textWidth(prefix))

// `text` cut to `width` cells, ending in an ellipsis when it did not fit.
export function fit(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

// `text` in a window `width` cells wide, `tick` steps along: as is when it fits,
// else scrolling left `chars` characters a tick, looping through a gap, resting
// `hold` ticks at the start of each round; `chars` 0 cuts it instead. Padded to
// `width` when a wide character would straddle the window's edge, so the label
// never jitters.
export function marquee(text: string, width: number, tick: number, chars = SCROLL_CHARS, hold = holdTicks(SCROLL_MS)): string {
  if (textWidth(text) <= width) return text
  if (chars <= 0) return fit(text, width)
  const loop = Array.from(text + MARQUEE_GAP)
  const steps = Math.ceil(loop.length / chars)
  const round = steps + hold
  const step = Math.max(0, (((tick % round) + round) % round) - hold) * chars
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

// A row of the panel's playlist: a folder, open or shut, or an entry to play.
// number counts the entries within their own folder; index is mpv's.
export type TreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; count: number; isOpen: boolean; hasCurrent: boolean }
  | { kind: 'item'; index: number; name: string; depth: number; number: number; where?: string }

type Node = { path: string; name: string; count: number; hasCurrent: boolean; children: ({ item: number } | { folder: Node })[] }

// The folders between `root` and `path`, outermost first; none for a path not
// under root.
export function foldersOf(path: string, root: string): string[] {
  if (!root || !path.startsWith(`${root}/`)) return []
  const parts = path.slice(root.length + 1).split('/').slice(0, -1)
  return parts.map((_, i) => `${root}/${parts.slice(0, i + 1).join('/')}`)
}

// The playlist as rows: entries under `root` grouped by their folders, in the
// order mpv plays them, with the folders in `open` showing what they hold.
// Without a root (a stream, a playlist file) the rows are the plain list.
export function playlistRows(items: readonly string[], paths: readonly string[], root: string, open: ReadonlySet<string>, current: number): TreeRow[] {
  const top: Node = { path: root, name: '', count: 0, hasCurrent: false, children: [] }
  const byPath = new Map<string, Node>()
  items.forEach((_, index) => {
    let node = top
    for (const folder of foldersOf(paths[index] ?? '', root)) {
      let next = byPath.get(folder)
      if (!next) {
        next = { path: folder, name: plain(baseName(folder)), count: 0, hasCurrent: false, children: [] }
        byPath.set(folder, next)
        node.children.push({ folder: next })
      }
      next.count += 1
      if (index === current) next.hasCurrent = true
      node = next
    }
    node.children.push({ item: index })
  })
  const rows: TreeRow[] = []
  const walk = (node: Node, depth: number) => {
    let number = 0
    for (const child of node.children) {
      if ('item' in child) {
        number += 1
        rows.push({ kind: 'item', index: child.item, name: items[child.item] ?? '?', depth, number })
      } else {
        const f = child.folder
        const isOpen = open.has(f.path)
        rows.push({ kind: 'folder', path: f.path, name: f.name, depth, count: f.count, isOpen, hasCurrent: f.hasCurrent })
        if (isOpen) walk(f, depth + 1)
      }
    }
  }
  walk(top, 0)
  return rows
}

// The entries whose name or folder holds every word of `text`, any case, as a
// plain list in play order: numbered by place in the playlist, each with the
// folder it is in under `root` (empty at the top).
export function filterRows(items: readonly string[], paths: readonly string[], root: string, text: string): TreeRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const rows: TreeRow[] = []
  items.forEach((name, index) => {
    const folders = foldersOf(paths[index] ?? '', root)
    const where = folders.length > 0 ? folders[folders.length - 1]!.slice(root.length + 1) : ''
    const haystack = `${name} ${where}`.toLowerCase()
    if (words.every(w => haystack.includes(w))) rows.push({ kind: 'item', index, name, depth: 0, number: index + 1, where })
  })
  return rows
}

// The library's pure model: a saved list's lines (kept as written, so a list
// edited by hand or by another player survives a rewrite), which song is which,
// the add-to-playlist marks, and the play history. No I/O.

import { videoOf } from './expand'

export type Song = { path: string; title?: string }
// A song read from a file keeps the lines it was written as (`text`, and in
// `info` its #EXTINF line with any lines between that and the song, such as
// #EXTVLCOPT), so a rewrite puts them back unchanged and in place: relative
// paths, empty titles and durations included.
export type ListLine = { kind: 'song'; song: Song; text?: string; info?: string[] } | { kind: 'other'; text: string }
export type ListFile = { lines: ListLine[] }
export type Mark = 'all' | 'some' | 'none'
export type Play = { at: number; path: string; title: string; artist?: string; duration?: number }

export const FAVOURITES = '★ Favourites'

const HEADER = '#EXTM3U'
const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p)

// Collapses //, . and .. in an absolute path and drops trailing slashes.
function tidy(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

// Only YouTube's own hosts carry a video id in ?v=.
function isYoutube(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return /(^|\.)youtube\.com$/i.test(h) || /^youtu\.be$/i.test(h)
  } catch {
    return false
  }
}

const isHeader = (l: ListLine | undefined) => l?.kind === 'other' && l.text.trim().toUpperCase() === HEADER

// How many lines up to and including the #EXTM3U header (the first non-blank
// line), or 0 when the file has none.
function headerEnd(lines: readonly ListLine[]): number {
  const i = lines.findIndex(l => !(l.kind === 'other' && l.text.trim() === ''))
  return i >= 0 && isHeader(lines[i]) ? i + 1 : 0
}

// What makes two entries the same song: the absolute local path, the YouTube
// video (yt:<id>), or the URL as written.
export function songKey(path: string, home: string): string {
  if (/^file:\/\//i.test(path)) {
    try {
      return tidy(decodeURIComponent(new URL(path).pathname))
    } catch {
      return path
    }
  }
  if (isUrl(path)) {
    const v = isYoutube(path) ? videoOf(path) : ''
    return v ? `yt:${v}` : path
  }
  if (path === '~' || path.startsWith('~/')) return tidy(`${home}/${path.slice(1)}`)
  return tidy(path)
}

// A list file's lines. A relative path is taken from `dir`; an #EXTINF title
// goes to the next song; everything else is kept as it is.
export function parseList(text: string, dir: string): ListFile {
  const lines: ListLine[] = []
  let title: string | undefined
  // from an #EXTINF line to the song it names
  let held: string[] = []
  const flush = () => {
    for (const t of held) lines.push({ kind: 'other', text: t })
    held = []
  }
  const src = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  if (src[src.length - 1] === '') src.pop()
  for (const raw of src) {
    const info = /^#EXTINF:[^,]*,(.*)$/i.exec(raw)
    if (info) {
      // a title with no song after it is kept as it was
      flush()
      held = [raw]
      title = info[1]!.trim() || undefined
    } else if (raw.trim() === '' || raw.trim().startsWith('#')) {
      if (held.length) held.push(raw)
      else lines.push({ kind: 'other', text: raw })
    } else {
      const p = raw.trim()
      const path = isUrl(p) || p.startsWith('/') ? p : tidy(`${dir}/${p}`)
      const line: ListLine = { kind: 'song', song: title === undefined ? { path } : { path, title }, text: raw }
      if (held.length) line.info = held
      lines.push(line)
      title = undefined
      held = []
    }
  }
  flush()
  return { lines }
}

// The file's text: #EXTM3U first, \n endings, a title line before titled songs.
export function listText(f: ListFile): string {
  const out: string[] = []
  if (headerEnd(f.lines) === 0) out.push(HEADER)
  for (const l of f.lines) {
    if (l.kind === 'other') out.push(l.text)
    else if (l.text !== undefined) {
      if (l.info) out.push(...l.info)
      out.push(l.text)
    } else {
      if (l.song.title) out.push(`#EXTINF:-1,${l.song.title.replace(/[\r\n]+/g, ' ')}`)
      out.push(l.song.path)
    }
  }
  return out.join('\n') + '\n'
}

export function songsOf(f: ListFile): Song[] {
  return f.lines.flatMap(l => (l.kind === 'song' ? [l.song] : []))
}

function keysOf(f: ListFile, home: string): Set<string> {
  return new Set(songsOf(f).map(s => songKey(s.path, home)))
}

export function markOf(f: ListFile, songs: readonly Song[], home: string): Mark {
  if (songs.length === 0) return 'none'
  const have = keysOf(f, home)
  const n = songs.filter(s => have.has(songKey(s.path, home))).length
  return n === 0 ? 'none' : n === songs.length ? 'all' : 'some'
}

// The songs not in the list yet go on the end, in the order given, once each.
export function addMissing(f: ListFile, songs: readonly Song[], home: string): { file: ListFile; added: number } {
  const seen = keysOf(f, home)
  const lines = [...f.lines]
  let added = 0
  for (const s of songs) {
    const k = songKey(s.path, home)
    if (seen.has(k)) continue
    seen.add(k)
    lines.push({ kind: 'song', song: s })
    added++
  }
  return { file: { lines }, added }
}

export function removeSongs(f: ListFile, songs: readonly Song[], home: string): { file: ListFile; removed: number } {
  const gone = new Set(songs.map(s => songKey(s.path, home)))
  const lines = f.lines.filter(l => l.kind === 'other' || !gone.has(songKey(l.song.path, home)))
  return { file: { lines }, removed: f.lines.length - lines.length }
}

// The song indexes `picks` mean in `f` as it is now: each pick's own place
// while the same song is still there, else another copy of it not already
// taken; a pick no longer in the list is left out. So acting on one row of a
// song listed twice acts on that row only, and a list changed meanwhile by
// another program still loses or moves the right song.
export function placesOf(f: ListFile, picks: readonly { index: number; song: Song }[], home: string): number[] {
  const keys = songsOf(f).map(s => songKey(s.path, home))
  const taken = new Set<number>()
  const out: number[] = []
  for (const { index, song } of picks) {
    const k = songKey(song.path, home)
    const at = keys[index] === k && !taken.has(index) ? index : keys.findIndex((x, i) => x === k && !taken.has(i))
    if (at < 0) continue
    taken.add(at)
    out.push(at)
  }
  return out
}

// The songs at song indexes `places` taken out, with the lines that belong to them.
export function removeAt(f: ListFile, places: readonly number[]): { file: ListFile; removed: number } {
  const gone = new Set(places)
  let n = -1
  const lines = f.lines.filter(l => l.kind === 'other' || !gone.has(++n))
  return { file: { lines }, removed: f.lines.length - lines.length }
}

// Every song in: take them out. Otherwise add the ones missing.
export function toggle(f: ListFile, songs: readonly Song[], home: string): ListFile {
  return markOf(f, songs, home) === 'all' ? removeSongs(f, songs, home).file : addMissing(f, songs, home).file
}

// The songs in `order` (old song indexes). Comment and unknown lines travel
// with the song after them; the #EXTM3U header and lines after the last song stay put.
export function moveSongs(f: ListFile, order: readonly number[]): ListFile {
  const n = headerEnd(f.lines)
  const head = f.lines.slice(0, n)
  const rest = f.lines.slice(n)
  const groups: ListLine[][] = []
  let pending: ListLine[] = []
  for (const l of rest) {
    pending.push(l)
    if (l.kind === 'song') {
      groups.push(pending)
      pending = []
    }
  }
  // anything not named in `order` keeps its place at the end; repeats are ignored
  const used = new Set<number>()
  const names = order.filter(i => Number.isInteger(i) && i >= 0 && i < groups.length && !used.has(i) && used.add(i))
  const missing = groups.map((_, i) => i).filter(i => !used.has(i))
  return { lines: [...head, ...[...names, ...missing].flatMap(i => groups[i]!), ...pending] }
}

// '' when `name` can be used for a new playlist, else what to tell the user.
export function checkName(name: string, existing: readonly string[]): string {
  if (name.trim() === '') return 'A playlist needs a name.'
  if (name !== name.trim()) return 'A playlist name can\'t start or end with a space.'
  if (name.includes('/')) return 'A playlist name can\'t contain "/".'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A playlist name can\'t contain control characters.'
  if (new TextEncoder().encode(name).length > 200) return 'That name is too long.'
  if (name.startsWith('.')) return 'A playlist name can\'t start with ".".'
  const low = name.toLowerCase()
  if ([FAVOURITES, 'fav', 'history'].some(r => r.toLowerCase() === low)) return `"${name}" is a reserved name.`
  if (existing.some(e => e.toLowerCase() === low)) return `There is already a playlist called "${name}".`
  return ''
}

// The plays in a history file, newest first; lines that aren't a play are skipped.
export function parseHistory(text: string): Play[] {
  const plays: Play[] = []
  for (const line of text.split('\n')) {
    let j: unknown
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof j !== 'object' || j === null) continue
    const o = j as Record<string, unknown>
    if (typeof o.at !== 'number' || !Number.isFinite(o.at) || typeof o.path !== 'string' || o.path === '') continue
    const play: Play = { at: o.at, path: o.path, title: typeof o.title === 'string' ? o.title : '' }
    if (typeof o.artist === 'string' && o.artist) play.artist = o.artist
    if (typeof o.duration === 'number' && Number.isFinite(o.duration)) play.duration = o.duration
    plays.push(play)
  }
  return plays.reverse()
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number) => String(n).padStart(2, '0')

// When a play happened, for a list row. `at` and `now` are unix seconds; the
// clock and the day boundaries are local time.
export function whenPlayed(at: number, now: number): string {
  const diff = now - at
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  const t = new Date(at * 1000)
  const n = new Date(now * 1000)
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(n) - day(t)) / 86_400_000)
  const clock = `${two(t.getHours())}:${two(t.getMinutes())}`
  if (days === 0) return `${Math.floor(diff / 3600)} h ago`
  if (days === 1) return `yesterday ${clock}`
  if (diff < 7 * 86_400) return `${DAYS[t.getDay()]} ${clock}`
  return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`
}

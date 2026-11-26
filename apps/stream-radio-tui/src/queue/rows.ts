import type { Queue } from '@core/host'
import type { Tags } from '../media/tags'
import { tilde } from '../ui/hooks'

// One song (or chapter) of the Queue tab. index: its place in mpv's
// queue; number: as shown, from 1.
export type FlatRow = { index: number; number: number; title: string; artist: string; where: string }

const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p)

// Where a song comes from: its folder (with ~), or a URL's site.
export function whereOf(path: string, home: string): string {
  if (!path) return ''
  if (isUrl(path)) {
    try {
      return new URL(path).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  const slash = path.lastIndexOf('/')
  return slash > 0 ? tilde(path.slice(0, slash), home) : ''
}

// The queue as one flat list: the title from the file's tags when read, else
// the queue's own name for it.
export function flatRows(q: Queue, tags: (path: string) => Tags | undefined, home: string): FlatRow[] {
  return q.items.map((item, index) => {
    const path = q.paths[index] ?? ''
    const t = path ? tags(path) : undefined
    return { index, number: index + 1, title: t?.title || item, artist: t?.artist ?? '', where: whereOf(path, home) }
  })
}

// The rows with every word of `text` in their title, artist or where.
export function filterFlat(rows: readonly FlatRow[], text: string): FlatRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter(r => {
    const hay = `${r.title} ${r.artist} ${r.where}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

// The dimmed part after a title: the artist, where it is, and any `more`, joined as ' · '; '' when none.
export const extraOf = (...parts: string[]): string => parts.filter(Boolean).join(' · ')

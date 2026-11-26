import type { Tags } from '../media/tags'

export type SortField = 'title' | 'artist' | 'albumArtist' | 'album' | 'folder'
const FIELDS: readonly SortField[] = ['title', 'artist', 'albumArtist', 'album', 'folder']
export const SORT_LABEL: Record<SortField, string> = { title: 'title', artist: 'artist', albumArtist: 'album artist', album: 'album', folder: 'folder' }

// The field after `f`; title when none yet, and after the last one none: as queued.
export const nextSortField = (f?: SortField): SortField | undefined => (f ? FIELDS[FIELDS.indexOf(f) + 1] : FIELDS[0])

// title: the row's shown title (from tags, else the queue's name for it).
export type SortRow = { path: string; title: string; tags?: Tags }

const collate = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

function keysOf(row: SortRow, field: SortField): string[] {
  switch (field) {
    case 'title':
      return [row.title]
    case 'folder': {
      const slash = row.path.lastIndexOf('/')
      return [row.path.slice(0, Math.max(0, slash)), row.path.slice(slash + 1)]
    }
    default:
      return [row.tags?.[field] ?? '']
  }
}

// The order to put the rows in: order[i] is the row now at i. Stable; rows
// with an empty key go last whichever way round.
export function sortOrder(rows: readonly SortRow[], field: SortField, isReversed: boolean): number[] {
  const keyed = rows.map((row, i) => ({ i, keys: keysOf(row, field) }))
  return keyed
    .sort((a, b) => {
      const [ea, eb] = [!a.keys[0], !b.keys[0]]
      if (ea !== eb) return ea ? 1 : -1
      for (let k = 0; k < a.keys.length; k++) {
        const c = collate(a.keys[k], b.keys[k])
        if (c) return isReversed ? -c : c
      }
      return a.i - b.i
    })
    .map(r => r.i)
}

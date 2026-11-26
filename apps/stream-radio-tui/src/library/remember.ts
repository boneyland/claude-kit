import type { Host } from '@core/host'
import type { SortField } from '../queue/sort'

// A playlist's sort, a view: the file keeps its own order. Custom order is no entry.
export type PlaylistSort = { field: SortField; isReversed: boolean }
export type PlaylistSorts = Record<string, PlaylistSort>

// Names are the user's: `constructor` or `__proto__` must not reach the prototype chain.
export const sortOf = (sorts: PlaylistSorts, name: string): PlaylistSort | undefined => (Object.hasOwn(sorts, name) ? sorts[name] : undefined)
// `sorts` with `name`'s sort set, or dropped when none (as an own key, whatever the name).
export const withSort = (sorts: PlaylistSorts, name: string, sort?: PlaylistSort): PlaylistSorts =>
  Object.fromEntries([...Object.entries(sorts).filter(([n]) => n !== name), ...(sort ? [[name, sort] as const] : [])])

const FIELDS: readonly string[] = ['title', 'artist', 'albumArtist', 'album', 'folder']

// The TUI's own file beside the player's: each playlist's remembered sort.
const fileOf = async (h: Host) => {
  const dir = await h.dataDir()
  return dir ? `${dir}/tui-playlists.json` : ''
}

// Never throws: nothing remembered, or garbage in the file, is no sorts.
export async function loadSorts(h: Host): Promise<PlaylistSorts> {
  try {
    const file = await fileOf(h)
    if (!file) return {}
    const raw = JSON.parse(await h.fs.read(file))?.sorts
    const entries: [string, PlaylistSort][] = []
    if (raw && typeof raw === 'object') {
      for (const [name, s] of Object.entries(raw as Record<string, { field?: unknown; isReversed?: unknown }>)) {
        if (s && typeof s.field === 'string' && FIELDS.includes(s.field)) entries.push([name, { field: s.field as SortField, isReversed: s.isReversed === true }])
      }
    }
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

// Never throws: a sort that can't be remembered is only forgotten.
export async function saveSorts(h: Host, sorts: PlaylistSorts): Promise<void> {
  try {
    const file = await fileOf(h)
    if (file) await h.fs.write(file, JSON.stringify({ sorts }))
  } catch {
    // nothing to do
  }
}

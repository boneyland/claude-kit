import { byName } from '@core/paths'
import type { Tags } from '../media/tags'

export type FileEntry = { path: string; name: string; kind: 'dir' | 'file'; mtimeMs: number }
// A folder's entries once read; while being read; or why it couldn't be.
export type Listing = FileEntry[] | 'loading' | { error: string }
export type FilesSort = 'name' | 'modified' | 'artist' | 'albumArtist'
export const FILES_SORTS: readonly FilesSort[] = ['name', 'modified', 'artist', 'albumArtist']
export const FILES_SORT_LABEL: Record<FilesSort, string> = { name: 'name', modified: 'modified', artist: 'artist', albumArtist: 'album artist' }

export type FileRow =
  | { kind: 'up' }
  | { kind: 'dir'; path: string; name: string; depth: number; isOpen: boolean }
  | { kind: 'file'; path: string; name: string; depth: number }
  | { kind: 'note'; text: string; depth: number }

// Files without the tag sorted by go last whichever way round, as in the
// Queue and Playlists (sortOrder): `sign` turns only the rest round.
function fileOrder(sort: FilesSort, tags: (path: string) => Tags | undefined, sign: number) {
  return (a: FileEntry, b: FileEntry): number => {
    if (sort === 'modified') return sign * (b.mtimeMs - a.mtimeMs || byName(a.name, b.name))
    if (sort === 'artist' || sort === 'albumArtist') {
      const [ta, tb] = [tags(a.path)?.[sort] ?? '', tags(b.path)?.[sort] ?? '']
      if (!ta !== !tb) return ta ? -1 : 1
      return sign * (byName(ta, tb) || byName(a.name, b.name))
    }
    return sign * byName(a.name, b.name)
  }
}

// The Files tab's rows: ../ first, then the root's folders (by name) and
// files (by `sort`), each open folder's rows under it; `isReversed` turns the
// files round, and the folders too when by name. The files of a folder in
// `ordered` (a YouTube playlist) keep the order they were listed in.
export function fileRows(
  root: string,
  listings: ReadonlyMap<string, Listing>,
  open: ReadonlySet<string>,
  sort: FilesSort,
  tags: (path: string) => Tags | undefined,
  ordered: ReadonlySet<string> = new Set(),
  isReversed = false,
): FileRow[] {
  const rows: FileRow[] = [{ kind: 'up' }]
  const sign = isReversed ? -1 : 1
  const order = fileOrder(sort, tags, sign)
  const dirSign = isReversed && sort === 'name' ? -1 : 1
  const walk = (folder: string, depth: number) => {
    const listing = listings.get(folder) ?? 'loading'
    if (listing === 'loading') return void rows.push({ kind: 'note', text: 'loading…', depth })
    if (!Array.isArray(listing)) return void rows.push({ kind: 'note', text: listing.error, depth })
    const dirs = listing.filter(e => e.kind === 'dir').sort((a, b) => dirSign * byName(a.name, b.name))
    const files = listing.filter(e => e.kind === 'file')
    if (!ordered.has(folder)) files.sort(order)
    for (const d of dirs) {
      const isOpen = open.has(d.path)
      rows.push({ kind: 'dir', path: d.path, name: d.name, depth, isOpen })
      if (isOpen) walk(d.path, depth + 1)
    }
    for (const f of files) rows.push({ kind: 'file', path: f.path, name: f.name, depth })
  }
  walk(root, 0)
  return rows
}

// The folder above `path`; '/' stays '/'.
export const parentOf = (path: string) => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// The rows with every word of `text` on the way down to them: in the folder
// and file names from the root, or a file's artist. A folder that matches
// keeps the rows showing under it; a match keeps the folders above it. ../
// stays; loading and error notes go. Only what has been read can match.
export function filterFileRows(rows: FileRow[], text: string, tags: (path: string) => Tags | undefined): FileRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  const out: FileRow[] = []
  // the names on the way down to the row, and the folders above it not yet kept
  const names: string[] = []
  const above: (FileRow | undefined)[] = []
  for (const row of rows) {
    if (row.kind === 'up') out.push(row)
    if (row.kind === 'up' || row.kind === 'note') continue
    names.length = above.length = row.depth
    names.push(row.name)
    const hay = `${names.join('/')} ${row.kind === 'file' ? (tags(row.path)?.artist ?? '') : ''}`.toLowerCase()
    const isMatch = words.every(w => hay.includes(w))
    above.push(row.kind === 'dir' && !isMatch ? row : undefined)
    if (!isMatch) continue
    for (let d = 0; d < row.depth; d++) {
      const dir = above[d]
      if (dir) out.push(dir)
      above[d] = undefined
    }
    out.push(row)
  }
  return out
}

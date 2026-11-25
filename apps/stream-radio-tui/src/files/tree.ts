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

function fileOrder(sort: FilesSort, tags: (path: string) => Tags | undefined) {
  return (a: FileEntry, b: FileEntry): number => {
    if (sort === 'modified') return b.mtimeMs - a.mtimeMs || byName(a.name, b.name)
    if (sort === 'artist' || sort === 'albumArtist') {
      const [ta, tb] = [tags(a.path)?.[sort] ?? '', tags(b.path)?.[sort] ?? '']
      if (!ta !== !tb) return ta ? -1 : 1
      return byName(ta, tb) || byName(a.name, b.name)
    }
    return byName(a.name, b.name)
  }
}

// The Files tab's rows: ../ first, then the root's folders (by name) and
// files (by `sort`), each open folder's rows under it. The files of a folder
// in `ordered` (a YouTube playlist) keep the order they were listed in.
export function fileRows(
  root: string,
  listings: ReadonlyMap<string, Listing>,
  open: ReadonlySet<string>,
  sort: FilesSort,
  tags: (path: string) => Tags | undefined,
  ordered: ReadonlySet<string> = new Set(),
): FileRow[] {
  const rows: FileRow[] = [{ kind: 'up' }]
  const order = fileOrder(sort, tags)
  const walk = (folder: string, depth: number) => {
    const listing = listings.get(folder) ?? 'loading'
    if (listing === 'loading') return void rows.push({ kind: 'note', text: 'loading…', depth })
    if (!Array.isArray(listing)) return void rows.push({ kind: 'note', text: listing.error, depth })
    const dirs = listing.filter(e => e.kind === 'dir').sort((a, b) => byName(a.name, b.name))
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

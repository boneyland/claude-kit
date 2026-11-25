import type { Host } from '@core/host'
import { isPlayable } from '@core/paths'
import type { FileEntry } from './tree'

// How many files are stat'ed at once for their modification times (here and in the tag book).
export const STATS_AT_ONCE = 32

// A folder's subfolders and the files mpv would play from it, with their
// modification times; dotfiles and dot-folders never.
export async function loadFolder(h: Host, path: string): Promise<FileEntry[]> {
  const base = path.replace(/\/+$/, '') || '/'
  const pathOf = (name: string) => `${base === '/' ? '' : base}/${name}`
  // 'other': a symlink (or a device); kept as what it points to, if that is a folder or a playable file
  const entries = (await h.fs.list(base)).filter(e => !e.name.startsWith('.') && (e.kind === 'dir' || e.kind === 'other' || (e.kind === 'file' && isPlayable(e.name))))
  const out: FileEntry[] = []
  for (let i = 0; i < entries.length; i += STATS_AT_ONCE) {
    const chunk = entries.slice(i, i + STATS_AT_ONCE)
    const stats = await Promise.all(
      chunk.map(e =>
        h.fs.stat(pathOf(e.name)).then(
          s => s,
          () => undefined,
        ),
      ),
    )
    chunk.forEach((e, k) => {
      const stat = stats[k]
      const kind = e.kind === 'other' ? stat?.kind : e.kind
      if (kind === 'dir' || (kind === 'file' && isPlayable(e.name))) out.push({ path: pathOf(e.name), name: e.name, kind, mtimeMs: stat?.mtimeMs ?? 0 })
    })
  }
  return out
}

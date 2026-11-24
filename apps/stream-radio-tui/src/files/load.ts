import type { Host } from '../../../../plugins/stream-radio/core/host'
import { isPlayable } from '../../../../plugins/stream-radio/core/paths'
import type { FileEntry } from './tree'

// How many files are stat'ed at once for their modification times.
const STATS_AT_ONCE = 32

// A folder's subfolders and the files mpv would play from it, with their
// modification times; dotfiles and dot-folders never.
export async function loadFolder(h: Host, path: string): Promise<FileEntry[]> {
  const base = path.replace(/\/+$/, '') || '/'
  const entries = (await h.fs.list(base)).filter(e => !e.name.startsWith('.') && (e.kind === 'dir' || (e.kind === 'file' && isPlayable(e.name))))
  const out: FileEntry[] = []
  for (let i = 0; i < entries.length; i += STATS_AT_ONCE) {
    const chunk = entries.slice(i, i + STATS_AT_ONCE)
    const stats = await Promise.all(
      chunk.map(e =>
        h.fs.stat(`${base === '/' ? '' : base}/${e.name}`).then(
          s => s.mtimeMs,
          () => 0,
        ),
      ),
    )
    chunk.forEach((e, k) => out.push({ path: `${base === '/' ? '' : base}/${e.name}`, name: e.name, kind: e.kind as 'dir' | 'file', mtimeMs: stats[k]! }))
  }
  return out
}

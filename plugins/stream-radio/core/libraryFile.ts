// The saved playlists on disk: one `<name>.m3u` per playlist in the library
// folder, written whole under library.lock so two programs' edits both land,
// and the play history file next to the player's other files.
import type { Host } from './host'
import { FAVOURITES, checkName, listText, parseHistory, parseList, songsOf, type ListFile, type Play, type Song } from './library'
import { byName, paths } from './paths'
import { QUEUE_LOCK_STALE_MS, withFileLock, writeWhole } from './storedFile'

export type ListInfo = { name: string; file: string; count: number; mtimeMs: number }

const EXT = '.m3u'
const EMPTY: ListFile = { lines: [] }

const fileOf = (dir: string, name: string) => `${dir}/${name}${EXT}`

export const BUSY = 'The playlists are busy; try again.'
export const GONE = 'That playlist is gone.'
// Neither XDG_DATA_HOME nor HOME is set: there is no folder to keep playlists in.
export const NO_LIBRARY = 'No folder for playlists: set HOME or XDG_DATA_HOME.'

// The playlists' names, Favourites first (listed even before its file
// exists), then the rest by name, from the folder listing alone: no file is
// read. A folder that is not there lists only Favourites.
export async function playlistNames(h: Host): Promise<string[]> {
  const dir = await h.libraryDir()
  if (!dir) return []
  return [FAVOURITES, ...(await namesIn(h, dir))]
}

// The playlist file a name is kept in ('' with no library folder).
export async function playlistFile(h: Host, name: string): Promise<string> {
  const dir = await h.libraryDir()
  return dir ? fileOf(dir, name) : ''
}

async function namesIn(h: Host, dir: string): Promise<string[]> {
  try {
    return (await h.fs.list(dir))
      .filter(e => e.kind !== 'dir' && !e.name.startsWith('.') && e.name.endsWith(EXT) && e.name.length > EXT.length)
      .map(e => e.name.slice(0, -EXT.length))
      .filter(n => n !== FAVOURITES)
      .sort(byName)
  } catch {
    return [] // no folder yet
  }
}

// The playlists as playlistNames orders them, each with its song count and
// modification time: every file is read, so only for views that show them.
export async function listPlaylists(h: Host): Promise<ListInfo[]> {
  const dir = await h.libraryDir()
  if (!dir) return []
  const info = async (name: string): Promise<ListInfo> => {
    const file = fileOf(dir, name)
    try {
      const [text, stat] = await Promise.all([h.fs.read(file), h.fs.stat(file)])
      return { name, file, count: songsOf(parseList(text, dir)).length, mtimeMs: stat.mtimeMs }
    } catch {
      return { name, file, count: 0, mtimeMs: 0 }
    }
  }
  return Promise.all([FAVOURITES, ...(await namesIn(h, dir))].map(info))
}

// Never throws: a playlist that is missing or cannot be read is empty.
export async function readPlaylist(h: Host, name: string): Promise<ListFile> {
  const dir = await h.libraryDir()
  if (!dir) return EMPTY
  try {
    return parseList(await h.fs.read(fileOf(dir, name)), dir)
  } catch {
    return EMPTY
  }
}

// The playlist as an edit reads it: missing is empty, but one that is there
// and cannot be read throws, so the edit does not write over it.
async function readForEdit(h: Host, dir: string, name: string): Promise<ListFile> {
  const file = fileOf(dir, name)
  try {
    return parseList(await h.fs.read(file), dir)
  } catch (error) {
    if (!(await h.fs.exists(file).catch(() => true))) return EMPTY
    throw error
  }
}

// Under the lock: reads the playlist, applies `fn`, writes the result whole
// (making the folder first). Resolves to the playlist as it now is; nothing is
// written when `fn` changed nothing. Else what to tell the person: BUSY when
// the lock could not be had, NO_LIBRARY with no folder, and GONE when
// `mustExist` and the file is not there (deleted or renamed elsewhere), so an
// edit never makes such a list again.
export async function editPlaylist(
  h: Host,
  name: string,
  fn: (f: ListFile) => ListFile,
  opts: { mustExist?: boolean } = {},
): Promise<ListFile | string> {
  const dir = await h.libraryDir()
  if (!dir) return NO_LIBRARY
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async (): Promise<ListFile | string> => {
    if (opts.mustExist && !(await h.fs.exists(fileOf(dir, name)).catch(() => true))) return GONE
    const was = await readForEdit(h, dir, name)
    const next = fn(was)
    if (listText(next) === listText(was)) return was
    await h.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
    await writeWhole(h, fileOf(dir, name), listText(next))
    return next
  })
  return done === 'busy' ? BUSY : done
}

// '' when done, else what to tell the person.
export async function createPlaylist(h: Host, name: string, songs: readonly Song[]): Promise<string> {
  const dir = await h.libraryDir()
  if (!dir) return NO_LIBRARY
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const bad = checkName(name, await playlistNames(h))
    if (bad) return bad
    await h.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
    await writeWhole(h, fileOf(dir, name), listText({ lines: songs.map(song => ({ kind: 'song' as const, song })) }))
    return ''
  })
  return done === 'busy' ? BUSY : done
}

export async function renamePlaylist(h: Host, from: string, to: string): Promise<string> {
  if (from === FAVOURITES) return `${FAVOURITES} can't be renamed.`
  const dir = await h.libraryDir()
  if (!dir) return NO_LIBRARY
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const existing = await playlistNames(h)
    if (!existing.includes(from)) return `There is no playlist called "${from}".`
    const bad = checkName(to, existing.filter(n => n !== from))
    if (bad) return bad
    const failed = (why: string) => `Could not rename "${from}": ${why}`
    const mv = async (a: string, b: string) => {
      const r = await h.run(['mv', '-n', '--', fileOf(dir, a), fileOf(dir, b)], { timeoutMs: 3000 })
      return r.exitCode === 0 ? '' : r.stderr.trim() || `mv exited ${r.exitCode}`
    }
    // A change of case only: on a case-insensitive file system `mv -n` sees the
    // target as there already and quietly does nothing, so go by another name.
    if (from.toLowerCase() === to.toLowerCase()) {
      const via = `.rename-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const first = await mv(from, via)
      if (first) return failed(first)
      const second = await mv(via, to)
      if (second) {
        await mv(via, from)
        return failed(second)
      }
    } else {
      const why = await mv(from, to)
      if (why) return failed(why)
    }
    // `mv -n` exits 0 even when it left things as they were
    const names = (await h.fs.list(dir).catch(() => [])).map(e => e.name)
    if (!names.includes(`${to}${EXT}`) || names.includes(`${from}${EXT}`)) return failed('the file did not move.')
    return ''
  })
  return done === 'busy' ? BUSY : done
}

export async function deletePlaylist(h: Host, name: string): Promise<string> {
  if (name === FAVOURITES) return `${FAVOURITES} can't be deleted.`
  const dir = await h.libraryDir()
  if (!dir) return NO_LIBRARY
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const removed = await h.run(['rm', '-f', '--', fileOf(dir, name)], { timeoutMs: 3000 })
    return removed.exitCode === 0 ? '' : `Could not delete "${name}": ${removed.stderr.trim()}`
  })
  return done === 'busy' ? BUSY : done
}

// The playlist file's modification time, 0 when it is not there: what views poll.
export async function listMtime(h: Host, name: string): Promise<number> {
  try {
    const dir = await h.libraryDir()
    return dir ? (await h.fs.stat(fileOf(dir, name))).mtimeMs : 0
  } catch {
    return 0
  }
}

// Newest first; missing or unreadable is empty.
export async function readHistory(h: Host): Promise<Play[]> {
  try {
    return parseHistory(await h.fs.read((await paths(h)).history))
  } catch {
    return []
  }
}

// Emptied in place, not replaced: mpv's history script appends to the file
// (O_APPEND), so a play it records as this runs lands in the emptied file
// instead of in a replaced one nobody reads.
export async function clearHistory(h: Host): Promise<void> {
  const r = await h.run(['sh', '-c', ': > "$1"', 'sh', (await paths(h)).history], { timeoutMs: 3000 })
  if (r.exitCode !== 0) throw new Error(`Could not clear Recently played: ${r.stderr.trim()}`)
}

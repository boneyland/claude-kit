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

// The playlists, Favourites first (listed even before its file exists), then
// the rest by name. A folder that is not there lists only Favourites.
export async function listPlaylists(h: Host): Promise<ListInfo[]> {
  const dir = await h.libraryDir()
  const info = async (name: string): Promise<ListInfo> => {
    const file = fileOf(dir, name)
    try {
      const [text, stat] = await Promise.all([h.fs.read(file), h.fs.stat(file)])
      return { name, file, count: songsOf(parseList(text, dir)).length, mtimeMs: stat.mtimeMs }
    } catch {
      return { name, file, count: 0, mtimeMs: 0 }
    }
  }
  let names: string[] = []
  try {
    names = (await h.fs.list(dir))
      .filter(e => e.kind !== 'dir' && !e.name.startsWith('.') && e.name.endsWith(EXT) && e.name.length > EXT.length)
      .map(e => e.name.slice(0, -EXT.length))
      .filter(n => n !== FAVOURITES)
      .sort(byName)
  } catch {
    // no folder yet
  }
  return Promise.all([FAVOURITES, ...names].map(info))
}

// Never throws: a playlist that is missing or cannot be read is empty.
export async function readPlaylist(h: Host, name: string): Promise<ListFile> {
  const dir = await h.libraryDir()
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
// written when `fn` changed nothing. 'busy' when the lock could not be had.
export async function editPlaylist(h: Host, name: string, fn: (f: ListFile) => ListFile): Promise<ListFile | 'busy'> {
  const dir = await h.libraryDir()
  const p = await paths(h)
  return withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const was = await readForEdit(h, dir, name)
    const next = fn(was)
    if (listText(next) === listText(was)) return was
    await h.run(['mkdir', '-p', dir], { timeoutMs: 3000 })
    await writeWhole(h, fileOf(dir, name), listText(next))
    return next
  })
}

const BUSY = 'The playlists are busy; try again.'

// '' when done, else what to tell the person.
export async function createPlaylist(h: Host, name: string, songs: readonly Song[]): Promise<string> {
  const dir = await h.libraryDir()
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const bad = checkName(name, (await listPlaylists(h)).map(l => l.name))
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
  const p = await paths(h)
  const done = await withFileLock(h, p.libraryLock, QUEUE_LOCK_STALE_MS, async () => {
    const existing = (await listPlaylists(h)).map(l => l.name)
    if (!existing.includes(from)) return `There is no playlist called "${from}".`
    const bad = checkName(to, existing.filter(n => n !== from))
    if (bad) return bad
    const moved = await h.run(['mv', '-n', '--', fileOf(dir, from), fileOf(dir, to)], { timeoutMs: 3000 })
    return moved.exitCode === 0 ? '' : `Could not rename "${from}": ${moved.stderr.trim()}`
  })
  return done === 'busy' ? BUSY : done
}

export async function deletePlaylist(h: Host, name: string): Promise<string> {
  if (name === FAVOURITES) return `${FAVOURITES} can't be deleted.`
  const dir = await h.libraryDir()
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
    return (await h.fs.stat(fileOf(await h.libraryDir(), name))).mtimeMs
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

export async function clearHistory(h: Host): Promise<void> {
  await writeWhole(h, (await paths(h)).history, '')
}

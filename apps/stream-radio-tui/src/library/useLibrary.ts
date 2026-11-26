import { useEffect, useRef } from 'react'
import type { Host } from '@core/host'
import { FAVOURITES, songsOf, type Play, type Song } from '@core/library'
import { listMtime, listPlaylists, readHistory, readPlaylist, type ListInfo } from '@core/libraryFile'
import { baseName } from '@core/nowplaying'
import { paths } from '@core/paths'
import { useRefState } from '../ui/hooks'
import { whereOf } from '../queue/rows'

// What openList takes for Recently played (no saved list can have the name).
export const HISTORY = 'history'
// How often a shown list, or the top level, is checked for changes on disk.
export const POLL_MS = 2000
const EXT = '.m3u'

// A list open in the Playlists tab. file: a saved list's .m3u, what the queue
// is called when it plays; plays: Recently played's, newest first, one per song.
export type OpenList = { name: string; kind: 'playlist' | 'favourites' | 'history'; songs: Song[]; plays?: Play[]; file?: string }

// A row of the Playlists tab. song: index is its place in the open list's
// songs (not in the rows, which a filter narrows); at: when it played (unix seconds).
export type LibraryRow = { kind: 'up' } | { kind: 'list'; info: ListInfo } | { kind: 'history' } | { kind: 'new' } | { kind: 'song'; song: Song; index: number; at?: number }

export type Library = {
  // Favourites first, then the saved lists by name; empty until first read
  lists: ListInfo[]
  isLoaded: boolean
  open: OpenList | undefined
  // now, in unix seconds, for when a play was; kept current while Recently played shows
  now: number
  // a saved list (or Favourites) by name, or HISTORY
  openList(name: string): void
  close(): void
  // reads what shows again, now
  refresh(): void
  // reads what shows again if it changed on disk
  check(): void
}

// A song's name in a row: its title in the list, else its file name.
export const songTitle = (s: Song) => s.title || baseName(s.path)

// The rows: the top level, or the open list's songs after ../ (with `filter`,
// those with every word of it in their title or where they are). order: the
// songs' places in the list in the order to show them (a sort); none: as in the file.
export function libraryRows(lib: Pick<Library, 'lists' | 'isLoaded' | 'open'>, filter: string, order?: readonly number[]): LibraryRow[] {
  const { open } = lib
  if (!open) {
    if (!lib.isLoaded) return []
    const [fav, ...rest] = lib.lists
    return [...(fav ? [{ kind: 'list' as const, info: fav }] : []), { kind: 'history' }, ...rest.map(info => ({ kind: 'list' as const, info })), { kind: 'new' }]
  }
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const places = order ?? open.songs.map((_, i) => i)
  const songs: LibraryRow[] = places.flatMap(index => {
    const song = open.songs[index]
    if (!song) return []
    const hay = `${songTitle(song)} ${whereOf(song.path, '')}`.toLowerCase()
    if (!words.every(w => hay.includes(w))) return []
    const at = open.plays?.[index]?.at
    return [at === undefined ? { kind: 'song' as const, song, index } : { kind: 'song' as const, song, index, at }]
  })
  return [{ kind: 'up' }, ...songs]
}

// The saved playlists and Recently played, read from disk while the tab
// shows (isShown) and checked every POLL_MS: an open list's file, Recently
// played's history.jsonl, or at the top level the folder and each list in it.
// A check reads again only what changed. An open saved list whose file has
// gone (deleted or renamed elsewhere) closes back to the top level, and onGone runs.
export function useLibrary(h: Host, isShown: boolean, onGone?: () => void): Library {
  const [listsRef, setLists] = useRefState<ListInfo[] | undefined>(undefined)
  const [openRef, setOpen] = useRefState<OpenList | undefined>(undefined)
  const [nowRef, setNow] = useRefState(0)
  // the list wanted open (HISTORY, a name, or undefined for the top level);
  // a read for anything else, started before a change, is dropped
  const want = useRef<string | undefined>(undefined)
  // what the last read saw of what shows; undefined: read again
  const seen = useRef<string | undefined>(undefined)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  // What changes on disk when what `target` shows changes.
  const stamp = async (target: string | undefined): Promise<string> => {
    if (target === HISTORY) {
      const file = (await paths(h)).history
      return String(await h.fs.stat(file).then(s => s.mtimeMs, () => 0))
    }
    if (target !== undefined) return String(await listMtime(h, target))
    const dir = await h.libraryDir()
    const names = dir ? ((await h.fs.list(dir).catch(() => [])) as { name: string }[]).map(e => e.name).filter(n => n.endsWith(EXT)).sort() : []
    const times = await Promise.all(names.map(n => listMtime(h, n.slice(0, -EXT.length))))
    return names.map((n, i) => `${n}\t${times[i]}`).join('\n')
  }

  const readOpen = async (target: string): Promise<OpenList> => {
    if (target === HISTORY) {
      const plays = await readHistory(h)
      return { name: 'Recently played', kind: 'history', songs: plays.map(p => (p.title ? { path: p.path, title: p.title } : { path: p.path })), plays }
    }
    const lists = listsRef.current?.some(l => l.name === target) ? listsRef.current : await listPlaylists(h)
    const file = lists.find(l => l.name === target)?.file
    const songs = songsOf(await readPlaylist(h, target))
    return { name: target, kind: target === FAVOURITES ? 'favourites' : 'playlist', songs, ...(file ? { file } : {}) }
  }

  const tickNow = async () => {
    const now = Math.floor((await h.now()) / 1000)
    // whenPlayed counts minutes: redraw no more than that needs
    if (alive.current && Math.floor(now / 30) !== Math.floor(nowRef.current / 30)) setNow(now)
  }

  // Reads what shows when it changed since the last read (always, with force).
  const check = async (force = false) => {
    const target = want.current
    try {
      const mark = await stamp(target)
      if (!alive.current || target !== want.current) return
      if (target === HISTORY) await tickNow()
      // Favourites lists before its file exists; any other list without one is gone
      if (target !== undefined && target !== HISTORY && target !== FAVOURITES && mark === '0') {
        want.current = undefined
        seen.current = undefined
        setOpen(undefined)
        onGone?.()
        return void check(true)
      }
      if (!force && mark === seen.current) return
      if (target === undefined) {
        const lists = await listPlaylists(h)
        if (!alive.current || target !== want.current) return
        seen.current = mark
        setLists(lists)
      } else {
        const open = await readOpen(target)
        if (!alive.current || target !== want.current) return
        seen.current = mark
        setOpen(open)
      }
    } catch (error) {
      h.log(`stream-radio: could not read the playlists: ${error instanceof Error ? error.message : String(error)}`, 'debug')
    }
  }

  useEffect(() => {
    if (!isShown) return
    void check(true)
    const timer = h.every(POLL_MS, () => void check())
    return () => timer.cancel()
  }, [isShown, h])

  return {
    lists: listsRef.current ?? [],
    isLoaded: listsRef.current !== undefined,
    open: openRef.current,
    now: nowRef.current,
    openList: name => {
      want.current = name
      seen.current = undefined
      void check(true)
    },
    close: () => {
      want.current = undefined
      seen.current = undefined
      setOpen(undefined)
      void check(true)
    },
    refresh: () => {
      seen.current = undefined
      void check(true)
    },
    check: () => void check(),
  }
}

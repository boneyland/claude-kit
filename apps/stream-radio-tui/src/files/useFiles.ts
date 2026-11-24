import { useEffect, useRef } from 'react'
import type { Host } from '../../../../plugins/stream-radio/core/host'
import { resolveTarget } from '../../../../plugins/stream-radio/core/nowplaying'
import { tilde, useRefState } from '../ui/hooks'
import { NO_SELECTION, type Selection } from '../ui/selection'
import type { TagBook } from '../ui/tagbook'
import { loadFolder } from './load'
import { lastFolder, rememberFolder } from './remember'
import { fileRows, parentOf, type FileRow, type FilesSort, type Listing } from './tree'
import { listPlaylist, type Video } from '../media/youtube'
import type { Tags } from '../media/tags'
import type { QueueEntry } from '../../../../plugins/stream-radio/core/player'

export type Files = {
  root: string
  // the root as the heading shows it: a folder path, or a YouTube playlist's title
  rootLabel(home: string): string
  rows: FileRow[]
  sel(): Selection
  setSel(sel: Selection): void
  top: number | undefined
  setTop(top: number | undefined): void
  sort: FilesSort
  setSort(sort: FilesSort): void
  // the tree's top folder; remembered for the next run
  setRoot(path: string): void
  goUp(): void
  // the folder holding `file`, the cursor on it once the folder is read
  reveal(file: string): void
  // isOpen: undefined flips it
  setOpen(path: string, isOpen?: boolean): void
  // a typed path or URL: '' when it became the root, else why not.
  // onBusy hears what is going on while a URL is listed.
  goTo(text: string, onBusy?: (text: string) => void): Promise<string>
  // a row's tags: a video's channel as its artist
  tags(path: string): Tags | undefined
  // what adding a row adds: a YouTube folder, each of its videos with its title
  entriesOf(row: FileRow): QueueEntry[]
}

// The root of a YouTube playlist listed in Files.
const YT = 'youtube:'

// The Files tab's state: the folder at the top, the folders read and opened,
// its cursor and picked rows. Listings are read in the background; rows
// show at once with "loading…" in place of a folder not yet read.
export function useFiles(h: Host, book: TagBook): Files {
  const [rootRef, setRootState] = useRefState('')
  const [listingsRef, setListings] = useRefState<ReadonlyMap<string, Listing>>(new Map())
  const [openRef, setOpenSet] = useRefState<ReadonlySet<string>>(new Set())
  const [selRef, setSel] = useRefState<Selection>(NO_SELECTION)
  const [topRef, setTop] = useRefState<number | undefined>(undefined)
  const [sortRef, setSort] = useRefState<FilesSort>('name')
  // videos listed from URLs, by URL; the playlists' videos, by playlist URL
  const videos = useRef(new Map<string, Video>()).current
  const playlists = useRef(new Map<string, { title: string; videos: Video[] }>()).current
  // the folder before a YouTube playlist, for ../
  const lastLocal = useRef('')
  // a file to put the cursor on once its row shows (see reveal)
  const revealing = useRef('')
  const isLive = useRef(true)
  useEffect(() => () => void (isLive.current = false), [])

  const putListing = (path: string, listing: Listing) => setListings(new Map(listingsRef.current).set(path, listing))
  const load = (path: string) => {
    const known = listingsRef.current.get(path)
    if (known === 'loading' || Array.isArray(known)) return
    putListing(path, 'loading')
    loadFolder(h, path).then(
      entries => {
        if (!isLive.current) return
        for (const e of entries) if (e.kind === 'file') book.know(e.path, e.mtimeMs)
        putListing(path, entries)
      },
      (error: unknown) => isLive.current && putListing(path, { error: `Can't read ${path}: ${error instanceof Error ? error.message : String(error)}` }),
    )
  }
  const showRoot = (path: string) => {
    if (!path.startsWith(YT)) lastLocal.current = path
    setRootState(path)
    setSel(NO_SELECTION)
    setTop(undefined)
    load(path)
  }
  const setRoot = (path: string) => {
    showRoot(path)
    void rememberFolder(h, path)
  }

  // the last folder browsed, else ~/Music, else home
  useEffect(() => {
    void (async () => {
      const remembered = await lastFolder(h)
      const home = await Promise.resolve()
        .then(() => h.home())
        .catch(() => '')
      const isDir = (p: string) =>
        Promise.resolve()
          .then(() => h.fs.stat(p))
          .then(
            s => s.kind === 'dir',
            () => false,
          )
      const start = remembered && (await isDir(remembered)) ? remembered : home && (await isDir(`${home}/Music`)) ? `${home}/Music` : home || '/'
      if (isLive.current && !rootRef.current) showRoot(start)
    })()
  }, [h])

  const tags = (path: string): Tags | undefined => {
    const v = videos.get(path)
    return v ? { title: v.title, artist: v.channel, albumArtist: '', album: '' } : book.get(path)
  }
  const rows = rootRef.current ? fileRows(rootRef.current, listingsRef.current, openRef.current, sortRef.current, tags, new Set(playlists.keys())) : []
  const revealAt = revealing.current ? rows.findIndex(r => r.kind === 'file' && r.path === revealing.current) : -1
  useEffect(() => {
    if (revealAt < 0) return
    revealing.current = ''
    setSel({ cursor: revealAt, anchor: revealAt, picked: [] })
    setTop(undefined)
  }, [revealAt])
  return {
    root: rootRef.current,
    rootLabel: home => {
      const root = rootRef.current
      if (!root) return 'loading…'
      if (root.startsWith(YT)) return `${playlists.get(root.slice(YT.length))?.title ?? root.slice(YT.length)} (YouTube)`
      return tilde(root, home)
    },
    tags,
    entriesOf: row => {
      if (row.kind !== 'file' && row.kind !== 'dir') return []
      const list = row.kind === 'dir' ? playlists.get(row.path) : undefined
      if (list) return list.videos.map(v => ({ path: v.url, title: v.title }))
      const v = videos.get(row.path)
      return [v ? { path: v.url, title: v.title } : { path: row.path }]
    },
    rows,
    sel: () => selRef.current,
    setSel,
    top: topRef.current,
    setTop,
    sort: sortRef.current,
    setSort,
    setRoot,
    goUp: () => {
      const root = rootRef.current
      if (!root) return
      // from a YouTube playlist, back to the folder before it
      if (root.startsWith(YT)) return showRoot(lastLocal.current || '/')
      setRoot(parentOf(root))
    },
    reveal: file => {
      revealing.current = file
      setRoot(parentOf(file))
    },
    setOpen: (path, isOpen) => {
      const open = new Set(openRef.current)
      if (isOpen ?? !open.has(path)) {
        open.add(path)
        load(path)
      } else open.delete(path)
      setOpenSet(open)
    },
    goTo: async (text, onBusy) => {
      const [home, cwd] = await Promise.all([
        Promise.resolve()
          .then(() => h.home())
          .catch(() => ''),
        Promise.resolve()
          .then(() => h.cwd())
          .catch(() => ''),
      ])
      const target = resolveTarget(text, { home, cwd })
      if (target.kind === 'error') return target.text
      if (target.kind !== 'play') return 'Type a folder path or a URL.'
      if (!target.isLocal) {
        onBusy?.(`Listing ${target.url}…`)
        const listed = await listPlaylist(h, target.url)
        if ('error' in listed) return listed.error
        if (!isLive.current) return ''
        const url = target.url
        playlists.set(url, { title: listed.title, videos: listed.entries })
        for (const v of listed.entries) videos.set(v.url, v)
        setListings(
          new Map(listingsRef.current)
            .set(YT + url, [{ path: url, name: listed.title, kind: 'dir', mtimeMs: 0 }])
            .set(url, listed.entries.map(v => ({ path: v.url, name: v.title, kind: 'file' as const, mtimeMs: 0 }))),
        )
        setOpenSet(new Set(openRef.current).add(url))
        showRoot(YT + url)
        return `${listed.entries.length} videos in ${listed.title}.`
      }
      const path = target.url.replace(/(.)\/+$/, '$1')
      const kind = await Promise.resolve()
        .then(() => h.fs.stat(path))
        .then(
          s => s.kind,
          () => undefined,
        )
      if (!kind || kind === 'other') return `No such folder: ${path}`
      // a file: the folder it is in
      setRoot(kind === 'dir' ? path : parentOf(path))
      return ''
    },
  }
}

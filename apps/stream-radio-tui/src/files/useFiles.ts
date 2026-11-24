import { useEffect, useRef } from 'react'
import type { Host } from '../../../../plugins/stream-radio/core/host'
import { resolveTarget } from '../../../../plugins/stream-radio/core/nowplaying'
import { useRefState } from '../ui/hooks'
import { NO_SELECTION, type Selection } from '../ui/selection'
import type { TagBook } from '../ui/tagbook'
import { loadFolder } from './load'
import { lastFolder, rememberFolder } from './remember'
import { fileRows, parentOf, type FileRow, type FilesSort, type Listing } from './tree'

export type Files = {
  root: string
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
  // isOpen: undefined flips it
  setOpen(path: string, isOpen?: boolean): void
  // a typed path or URL: '' when it became the root, else why not
  goTo(text: string): Promise<string>
}

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

  const rows = rootRef.current ? fileRows(rootRef.current, listingsRef.current, openRef.current, sortRef.current, book.get) : []
  return {
    root: rootRef.current,
    rows,
    sel: () => selRef.current,
    setSel,
    top: topRef.current,
    setTop,
    sort: sortRef.current,
    setSort,
    setRoot,
    goUp: () => rootRef.current && setRoot(parentOf(rootRef.current)),
    setOpen: (path, isOpen) => {
      const open = new Set(openRef.current)
      if (isOpen ?? !open.has(path)) {
        open.add(path)
        load(path)
      } else open.delete(path)
      setOpenSet(open)
    },
    goTo: async text => {
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
      if (!target.isLocal) return `Not a folder: ${target.url}`
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

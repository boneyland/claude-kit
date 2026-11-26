import { useEffect, useMemo, useRef } from 'react'
import type { Host } from '@core/host'
import { FAVOURITES, moveSongs, removeSongs, songKey, songsOf, type Song } from '@core/library'
import { GONE, planList, playList } from '@core/library-actions'
import { clearHistory, createPlaylist, deletePlaylist, editPlaylist, renamePlaylist } from '@core/libraryFile'
import { baseName } from '@core/nowplaying'
import { addToQueue, playEntries } from '@core/player'
import { moveBy, moveTo, type Moved } from '@core/queue'
import type { QueueEntry } from '@core/stored'
import type { TuiConfig } from '../config'
import type { Action, Mode } from '../keys'
import type { Hit } from '../mouse/Clickable'
import { useRefState } from '../ui/hooks'
import { nextSortField, SORT_LABEL, sortOrder } from '../queue/sort'
import { edit, type Line } from '../ui/lineEdit'
import { confirmMenu, favouritesMenu, historyMenu, listMenu, songMenu, type MenuItem } from '../ui/Menu'
import { clamp, clear, current, extend, NO_SELECTION, select, targets, toggle, type Held, type Selection } from '../ui/selection'
import type { TagBook } from '../ui/tagbook'
import type { Turns } from '../ui/turns'
import { loadSorts, saveSorts, sortOf, withSort, type PlaylistSort, type PlaylistSorts } from './remember'
import { HISTORY, libraryRows, songTitle, useLibrary, type Library, type LibraryRow } from './useLibrary'

const BUSY = 'The playlists are busy; try again.'
const HISTORY_READ_ONLY = "Recently played can't be edited; Clear it from its menu."
const PICK_INSIDE = 'Pick songs inside a playlist.'
const whenSorted = (sort: PlaylistSort) => `sorted by ${SORT_LABEL[sort.field]} — S to custom order to move`

// What the tab needs of the App around it.
export type PlaylistsUi = {
  mode(): Mode
  setMode(mode: Mode): void
  // a menu over row `at` of this tab
  showMenu(items: readonly MenuItem[], at: number): void
  say(text: string): void
  // whether every one of `songs` is in Favourites, for a menu's label
  allFavourite(songs: readonly Song[]): boolean
}

// The name being typed: for a new playlist, or a list's new name.
type Prompt = { kind: 'new' } | { kind: 'rename'; from: string }

export type PlaylistsTab = {
  lib: Library
  rows: LibraryRow[]
  sel(): Selection
  setSel(sel: Selection): void
  top: number | undefined
  setTop(top: number | undefined): void
  filter: string
  heading: string
  // mode name: what the line is for, and the line
  prompt: { label: string; line: Line } | undefined
  // the menu of row `at`; undefined for a row without one
  menuOf(at: number): readonly MenuItem[] | undefined
  // A press on row `at`, the view's first row `first`: on a list it opens, on
  // ../ goes back, on + New playlist… asks a name; on a song it selects, and
  // a double-click plays the list from it. Ctrl picks, Shift or Alt a range.
  onRow(at: number, hit: Hit, first: number): void
  // the songs * and P act on inside an open list: the picked, else the
  // cursor's (none on ../); undefined at the top level, where they act on nothing
  chosen(): Song[] | undefined
  // the open playlist's sort on the tab row: its field (custom order for none)
  // and which way round (none for custom order); undefined with no editable list open
  sortLabel: string | undefined
  isReversed: boolean | undefined
  // during a drag of songs: the row, and the row they would land above (rows.length: the end)
  drag: { from: number; to: number } | undefined
  onRowDrag(at: number, dy: number): void
  onRowRelease(): void
  // does what `a` means in this tab; false for an action it leaves to the App
  handle(a: Action): boolean
}

const entryOf = (s: Song): QueueEntry => (s.title ? { path: s.path, title: s.title } : { path: s.path })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const rowKey = (r: LibraryRow) => (r.kind === 'list' ? `list:${r.info.name}` : r.kind === 'song' ? `song:${r.index}:${r.song.path}` : r.kind)
const listName = (r: LibraryRow | undefined) => (r?.kind === 'list' ? r.info.name : r?.kind === 'history' ? HISTORY : undefined)

// The Playlists tab: the library, its rows, cursor, pick, scroll and filter,
// and what its keys do.
// playing: what plays; a list showing is checked again when it changes.
export function usePlaylistsTab(h: Host, config: TuiConfig, isShown: boolean, playing: string, { act, inTurn }: Turns, ui: PlaylistsUi, book: TagBook): PlaylistsTab {
  const lib = useLibrary(h, isShown, () => {
    setFilterState('')
    if (ui.mode() === 'filter') ui.setMode('list')
    ui.say(GONE)
  })
  useEffect(() => void (isShown && lib.check()), [playing])
  // the press before opened or left a list: a double-click's second press lands on the new rows
  const hasOpened = useRef(false)
  const [selRef, setSelState] = useRefState<Held | undefined>(undefined)
  const [topRef, setTop] = useRefState<number | undefined>(undefined)
  const [filterRef, setFilterState] = useRefState('')
  const [promptRef, setPrompt] = useRefState<{ for: Prompt; line: Line } | undefined>(undefined)
  // a drag of songs: the row pressed and where they would land
  const [dragRef, setDrag] = useRefState<{ from: number; to: number } | undefined>(undefined)
  // a press on a picked row selects it only when let go without a drag
  const pendingSelect = useRef<number | undefined>(undefined)
  // a drag refused (the list is sorted) and said so
  const isRefused = useRef(false)
  // each playlist's sort, a view: the file keeps its own order
  const [sortsRef, setSorts] = useRefState<PlaylistSorts>({})
  const saving = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    void loadSorts(h).then(was => setSorts(Object.fromEntries([...Object.entries(was), ...Object.entries(sortsRef.current)])))
  }, [h])
  const filter = filterRef.current.trim()
  const o = lib.open
  const sort = o && o.kind !== 'history' ? sortOf(sortsRef.current, o.name) : undefined
  const tagsSeen = book.version()
  const order = useMemo(
    () =>
      o && sort
        ? sortOrder(
            o.songs.map(song => {
              const tags = book.get(song.path)
              return { path: song.path, title: tags?.title || songTitle(song), tags }
            }),
            sort.field,
            sort.isReversed,
          )
        : undefined,
    [o, sort, book, tagsSeen],
  )
  // tags are read for a sort by them
  const needKey = o && sort && sort.field !== 'folder' ? o.songs.map(song => song.path).join('\n') : ''
  useEffect(() => book.need(needKey ? needKey.split('\n') : []), [book, needKey])
  const rows = useMemo(() => libraryRows(lib, filter, order), [lib.lists, lib.isLoaded, lib.open, filter, order])
  const key = useMemo(() => rows.map(rowKey).join('\n'), [rows])

  const sel = (): Selection => clamp(current(selRef.current, key) ?? NO_SELECTION, rows.length)
  const setSel = (next: Selection) => setSelState({ ...next, forKey: key })
  // the cursor on row `at`, against rows yet to be drawn: kept unpicked
  const putCursor = (at: number) => setSelState({ cursor: at, anchor: at, picked: [] })
  const setFilter = (text: string) => {
    setFilterState(text)
    setTop(undefined)
    putCursor(0)
  }

  const open = (name: string) => {
    setFilterState('')
    setTop(undefined)
    // on the first song, once it shows
    putCursor(1)
    lib.openList(name)
  }
  const close = () => {
    const was = lib.open
    setFilterState('')
    setTop(undefined)
    // back on the row of the list just left
    const at = was ? libraryRows({ ...lib, open: undefined }, '').findIndex(r => (r.kind === 'history' ? was.kind === 'history' : r.kind === 'list' && r.info.name === was.name)) : 0
    putCursor(Math.max(0, at))
    lib.close()
  }
  const ask = (p: Prompt) => {
    const text = p.kind === 'rename' ? p.from : ''
    setPrompt({ for: p, line: { text, at: text.length } })
    ui.setMode('name')
  }

  // The songs the action takes: the picked rows, else the cursor's.
  const chosenSongs = () => targets(sel()).flatMap(i => (rows[i]?.kind === 'song' ? [rows[i]] : [])) as Extract<LibraryRow, { kind: 'song' }>[]

  // the open list's songs as shown, and a song's place among them (index: in the file)
  const shownSongs = () => (o ? (order ? order.map(i => o.songs[i]!) : o.songs) : [])
  const shownIndex = (index: number) => (order ? order.indexOf(index) : index)
  const playFrom = (index: number) => {
    const o = lib.open
    if (!o) return
    act(() => playEntries(h, config, shownSongs().map(entryOf), o.file ?? '', shownIndex(index)))
  }
  const setSortsSaved = (next: PlaylistSorts) => {
    setSorts(next)
    saving.current = saving.current.then(() => saveSorts(h, next))
  }
  // `name` was renamed: its sort goes with it; or deleted: its sort goes
  const carrySort = (name: string, to?: string) => {
    const was = sortOf(sortsRef.current, name)
    if (!was) return
    const without = withSort(sortsRef.current, name)
    setSortsSaved(to ? withSort(without, to, was) : without)
  }
  // No sort: the file's own order (custom order).
  const sortBy = (next: PlaylistSort | undefined) => {
    if (!o || o.kind === 'history') return
    setSortsSaved(withSort(sortsRef.current, o.name, next))
    setTop(undefined)
    // the rows change places: the cursor on the first song
    putCursor(1)
  }
  const sortNext = () => {
    const field = nextSortField(sort?.field)
    sortBy(field ? { field, isReversed: false } : undefined)
  }
  const sortReverse = () => sortBy({ field: sort?.field ?? 'title', isReversed: !sort?.isReversed })

  // The picked songs (or the cursor's) moved as `make` says, in the file as it
  // is under the lock: by which songs they are, not the places they had when
  // keys were pressed, so a change by another program is neither lost nor undone.
  const moveChosen = (make: (keys: string[], from: number[], keyOf: (s: Song) => string) => Moved) => {
    const o = lib.open
    if (!o || o.kind === 'history') return
    if (sort) return ui.say(whenSorted(sort))
    const was = sel()
    const moving = chosenSongs().map(r => r.song)
    if (!moving.length) return
    const cursorRow = rows[was.cursor]
    const cursorSong = cursorRow?.kind === 'song' ? cursorRow.song : undefined
    act(() =>
      inTurn(async () => {
        const home = await h.home().catch(() => '')
        const keyOf = (s: Song) => songKey(s.path, home)
        const wanted = new Set(moving.map(keyOf))
        const done = await editPlaylist(h, o.name, f => {
          const keys = songsOf(f).map(s => keyOf(s))
          const from = keys.flatMap((k, i) => (wanted.has(k) ? [i] : []))
          return from.length ? moveSongs(f, make(keys, from, keyOf).order) : f
        })
        if (done === 'busy') return BUSY
        // the rows as they will be once the list is read again, the pick and cursor on the songs moved
        const after = libraryRows({ lists: lib.lists, isLoaded: lib.isLoaded, open: { ...o, songs: songsOf(done) } }, filterRef.current.trim())
        const placeOf = (key: string) => after.findIndex(r => r.kind === 'song' && keyOf(r.song) === key)
        const picked = after.flatMap((r, i) => (r.kind === 'song' && wanted.has(keyOf(r.song)) ? [i] : []))
        const at = cursorSong ? placeOf(keyOf(cursorSong)) : -1
        const cursor = at >= 0 ? at : was.cursor
        setSelState({ cursor, anchor: cursor, picked: was.picked.length ? picked : [], forKey: after.map(rowKey).join('\n') })
        setTop(undefined)
        lib.refresh()
      }),
    )
  }
  const moveBySteps = (by: 1 | -1) => moveChosen((keys, from) => moveBy(keys.length, from, by))
  // the songs above `target` (none: at the end)
  const moveAbove = (target: Song | undefined) =>
    moveChosen((keys, from, keyOf) => {
      const to = target ? keys.indexOf(keyOf(target)) : keys.length
      return to < 0 ? { order: keys.map((_, i) => i), picked: from } : moveTo(keys.length, from, to)
    })
  // list: the one a menu named; else the cursor's at the top level, or the songs inside one
  // songs: the ones a song's menu was opened on
  const add = (where: 'end' | 'next', list?: string, given?: readonly Song[]) => {
    const next = where === 'next' ? ' to play next' : ''
    const name = list ?? (lib.open ? undefined : listName(rows[sel().cursor]))
    if (name) {
      return act(() =>
        inTurn(async () => {
          const plan = await planList(h, name)
          if (typeof plan === 'string') return plan
          return (await addToQueue(h, config, plan.entries, where)) || `Added ${plural(plan.entries.length, 'song')}${next}.`
        }),
      )
    }
    const songs = given ?? chosenSongs().map(r => r.song)
    if (!songs.length) return
    setSel(clear(sel()))
    act(() => inTurn(async () => (await addToQueue(h, config, songs.map(entryOf), where)) || `Added ${plural(songs.length, 'song')}${next}.`))
  }
  // from: the songs a song's menu was opened on, and their list
  const remove = (from?: { list: string; songs: readonly Song[] }) => {
    const o = lib.open
    const row = rows[sel().cursor]
    if (from) return removeFrom(from.list, from.songs)
    if (!o) {
      // a list at the top level: Delete playlist, which asks first
      if (row?.kind === 'history') return ui.say(HISTORY_READ_ONLY)
      if (row?.kind === 'list') return row.info.name === FAVOURITES ? ui.say(`${FAVOURITES} can't be deleted.`) : handleList({ kind: 'deleteList', name: row.info.name })
      return
    }
    if (o.kind === 'history') return ui.say(HISTORY_READ_ONLY)
    removeFrom(o.name, chosenSongs().map(r => r.song))
  }
  // Takes `songs` out of list `name`, by which songs they are (not where).
  const removeFrom = (name: string, songs: readonly Song[]) => {
    if (!songs.length) return
    setSel(clear(sel()))
    act(() =>
      inTurn(async () => {
        const home = await h.home().catch(() => '')
        let removed = 0
        const done = await editPlaylist(h, name, f => {
          const r = removeSongs(f, songs, home)
          removed = r.removed
          return r.file
        })
        if (done === 'busy') return BUSY
        lib.refresh()
        return `Removed ${plural(removed, 'song')} from ${name}.`
      }),
    )
  }
  // Delete playlist, Clear, Rename and Play, from a list's menu: on the list
  // the action names, whatever row the cursor is on by now.
  const handleList = (a: Action): boolean => {
    const at = sel().cursor
    switch (a.kind) {
      case 'playList': {
        const { name } = a
        const by = sortOf(sortsRef.current, name)
        if (!by) act(() => playList(h, config, name, 0))
        else
          // a sorted list plays in the order it shows
          act(async () => {
            const plan = await planList(h, name)
            if (typeof plan === 'string') return plan
            const entries = plan.entries
            // the tags a tag sort goes by, read first: songs not yet read would sort last
            if (by.field !== 'folder') await book.ready(entries.map(e => e.path))
            const shown = sortOrder(
              entries.map(e => {
                const tags = book.get(e.path)
                return { path: e.path, title: tags?.title || e.title || baseName(e.path), tags }
              }),
              by.field,
              by.isReversed,
            )
            return playEntries(h, config, shown.map(i => entries[i]!), plan.source, 0)
          })
        return true
      }
      case 'rename':
        if (a.name !== FAVOURITES && a.name !== HISTORY) ask({ kind: 'rename', from: a.name })
        return true
      case 'deleteList': {
        const { name } = a
        if (name === FAVOURITES || name === HISTORY) return true
        if (!a.isSure) ui.showMenu(confirmMenu(`Delete "${name}"`, { kind: 'deleteList', name, isSure: true }), at)
        else
          act(() =>
            inTurn(async () => {
              const said = await deletePlaylist(h, name)
              if (!said) carrySort(name)
              lib.refresh()
              return said || `Deleted "${name}".`
            }),
          )
        return true
      }
      case 'clearHistory':
        if (!a.isSure) ui.showMenu(confirmMenu('Clear Recently played', { kind: 'clearHistory', isSure: true }), at)
        else
          act(() =>
            inTurn(async () => {
              await clearHistory(h)
              lib.refresh()
              return 'Cleared Recently played.'
            }),
          )
        return true
    }
    return true
  }
  const submitName = () => {
    const p = promptRef.current
    setPrompt(undefined)
    ui.setMode('list')
    if (!p) return
    const name = p.line.text
    act(() =>
      inTurn(async () => {
        if (p.for.kind === 'rename' && name === p.for.from) return ''
        const said = p.for.kind === 'new' ? await createPlaylist(h, name, []) : await renamePlaylist(h, p.for.from, name)
        if (said) return said
        if (p.for.kind === 'rename') carrySort(p.for.from, name)
        lib.refresh()
        return p.for.kind === 'new' ? `Made the playlist "${name}".` : `Renamed "${p.for.from}" to "${name}".`
      }),
    )
  }
  const enter = (at: number) => {
    const row = rows[at]
    switch (row?.kind) {
      case 'up':
        return close()
      case 'list':
        return open(row.info.name)
      case 'history':
        return open(HISTORY)
      case 'new':
        return ask({ kind: 'new' })
      case 'song':
        return playFrom(row.index)
    }
  }

  const handle = (a: Action): boolean => {
    const mode = ui.mode()
    if (mode === 'name') {
      const p = promptRef.current
      if (a.kind === 'lineEdit' && p) setPrompt({ ...p, line: edit(p.line, a.edit) })
      else if (a.kind === 'submit') submitName()
      else if (a.kind === 'cancel') {
        setPrompt(undefined)
        ui.setMode('list')
      } else return false
      return true
    }
    if (mode === 'filter') {
      switch (a.kind) {
        case 'type':
          setFilter(filterRef.current + a.text)
          return true
        case 'erase':
          setFilter(edit({ text: filterRef.current, at: filterRef.current.length }, { kind: 'erase' }).text)
          return true
        case 'submit': {
          ui.setMode('list')
          // the filter as typed: keys in one go may not have redrawn the rows yet
          const first = libraryRows(lib, filterRef.current.trim(), order).find(r => r.kind === 'song')
          if (first?.kind === 'song') playFrom(first.index)
          else ui.say('Nothing matches.')
          return true
        }
        case 'cancel':
          setFilter('')
          ui.setMode('list')
          return true
      }
      return false
    }
    const at = sel().cursor
    switch (a.kind) {
      case 'enter': {
        const play = a.play
        if (play) act(() => playEntries(h, config, play.songs.map(entryOf), play.source, play.index))
        else enter(at)
        return true
      }
      case 'openFolder':
        if (!lib.open && listName(rows[at])) enter(at)
        return true
      case 'shutFolder':
      case 'folderUp':
        if (lib.open) close()
        return true
      case 'add':
        add(a.where, a.list, a.songs)
        return true
      case 'remove':
        remove(a.from)
        return true
      case 'filterMode':
        // the open list only
        if (lib.open) ui.setMode('filter')
        return true
      case 'playList':
      case 'rename':
      case 'deleteList':
      case 'clearHistory':
        return handleList(a)
      // a list's row isn't songs: * and P act on songs inside one (the App does that)
      case 'favourite':
      case 'addToList':
        if (lib.open || a.songs || a.isPlaying) return false
        ui.say(PICK_INSIDE)
        return true
      // sorting and moving are of a playlist's songs (not Recently played's, nor the lists)
      case 'sortNext':
      case 'sortReverse':
        if (o && o.kind !== 'history') (a.kind === 'sortNext' ? sortNext : sortReverse)()
        return true
      case 'move':
        moveBySteps(a.by)
        return true
      // nothing to clear here
      case 'clearQueue':
        return true
    }
    return false
  }

  const heading = !o
    ? 'Playlists'
    : filter
      ? `${o.name} · ${rows.length - 1} of ${plural(o.songs.length, 'song')} match`
      : `${o.name} · ${plural(o.songs.length, o.kind === 'history' ? 'play' : 'song')}`
  const p = promptRef.current
  return {
    lib,
    rows,
    sel,
    setSel,
    top: topRef.current,
    setTop,
    filter: filterRef.current,
    heading,
    prompt: p && { label: p.for.kind === 'new' ? 'New playlist name: ' : `Rename "${p.for.from}" to: `, line: p.line },
    menuOf: at => {
      const row = rows[at]
      if (row?.kind === 'song' && o) {
        const s = sel()
        const chosen = s.picked.includes(at) ? s.picked : [at]
        const songs = chosen.flatMap(i => (rows[i]?.kind === 'song' ? [(rows[i] as Extract<LibraryRow, { kind: 'song' }>).song] : []))
        return songMenu({ all: shownSongs(), source: o.file ?? '', index: shownIndex(row.index), songs, isFavourite: ui.allFavourite(songs), ...(o.kind === 'history' ? {} : { list: o.name }) })
      }
      if (row?.kind === 'history') return historyMenu(HISTORY)
      if (row?.kind === 'list') return row.info.name === FAVOURITES ? favouritesMenu(FAVOURITES) : listMenu(row.info.name)
      return undefined
    },
    onRow: (at, hit, first) => {
      const wasOpened = hasOpened.current
      hasOpened.current = false
      if (hit.isDouble && wasOpened) return
      setTop(first)
      if (hit.mods.ctrl) return setSel(toggle(sel(), at))
      if (hit.mods.shift || hit.mods.alt) return setSel(extend(sel(), at))
      const row = rows[at]
      pendingSelect.current = undefined
      // a picked row may be about to be dragged with the rest
      if (row?.kind === 'song' && !hit.isDouble && o && o.kind !== 'history' && sel().picked.includes(at)) {
        pendingSelect.current = at
        return setSel({ ...sel(), cursor: at })
      }
      setSel(select(sel(), at))
      if (row?.kind === 'song') return hit.isDouble ? enter(at) : undefined
      hasOpened.current = row?.kind === 'up' || row?.kind === 'list' || row?.kind === 'history'
      enter(at)
    },
    sortLabel: o && o.kind !== 'history' ? (sort ? SORT_LABEL[sort.field] : 'custom order') : undefined,
    isReversed: sort?.isReversed,
    drag: dragRef.current,
    // dy: rows from the row pressed
    onRowDrag: (at, dy) => {
      pendingSelect.current = undefined
      if (!o || o.kind === 'history' || rows[at]?.kind !== 'song') return
      if (sort) {
        // said once per drag; the release ends it
        if (!isRefused.current) ui.say(whenSorted(sort))
        isRefused.current = true
        return
      }
      // not above ../
      setDrag({ from: at, to: Math.max(1, Math.min(at + dy, rows.length)) })
    },
    onRowRelease: () => {
      const drag = dragRef.current
      isRefused.current = false
      setDrag(undefined)
      if (pendingSelect.current !== undefined) {
        setSel(select(sel(), pendingSelect.current))
        pendingSelect.current = undefined
      }
      if (!drag || drag.to === drag.from) return
      const target = rows[drag.to]
      moveAbove(target?.kind === 'song' ? target.song : undefined)
    },
    chosen: () => (o ? chosenSongs().map(r => r.song) : undefined),
    handle,
  }
}

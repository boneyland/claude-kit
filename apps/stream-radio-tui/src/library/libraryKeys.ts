import { useEffect, useMemo, useRef } from 'react'
import type { Host } from '@core/host'
import { FAVOURITES, removeSongs, type Song } from '@core/library'
import { planList, playList } from '@core/library-actions'
import { clearHistory, createPlaylist, deletePlaylist, editPlaylist, renamePlaylist } from '@core/libraryFile'
import { addToQueue, playEntries } from '@core/player'
import type { QueueEntry } from '@core/stored'
import type { TuiConfig } from '../config'
import type { Action, Mode } from '../keys'
import type { Hit } from '../mouse/Clickable'
import { useRefState } from '../ui/hooks'
import { edit, type Line } from '../ui/lineEdit'
import { confirmMenu, favouritesMenu, historyMenu, listMenu, songMenu, type MenuItem } from '../ui/Menu'
import { clamp, clear, current, extend, NO_SELECTION, select, targets, toggle, type Held, type Selection } from '../ui/selection'
import type { Turns } from '../ui/turns'
import { HISTORY, libraryRows, useLibrary, type Library, type LibraryRow } from './useLibrary'

const BUSY = 'The playlists are busy; try again.'
const HISTORY_READ_ONLY = "Recently played can't be edited; Clear it from its menu."
const GONE = 'That playlist is gone.'
const PICK_INSIDE = 'Pick songs inside a playlist.'

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
export function usePlaylistsTab(h: Host, config: TuiConfig, isShown: boolean, playing: string, { act, inTurn }: Turns, ui: PlaylistsUi): PlaylistsTab {
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
  const filter = filterRef.current.trim()
  const rows = useMemo(() => libraryRows(lib, filter), [lib.lists, lib.isLoaded, lib.open, filter])
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

  const playFrom = (index: number) => {
    const o = lib.open
    if (!o) return
    act(() => playEntries(h, config, o.songs.map(entryOf), o.file ?? '', index))
  }
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
      case 'playList':
        act(() => playList(h, config, a.name, 0))
        return true
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
          const first = libraryRows(lib, filterRef.current.trim()).find(r => r.kind === 'song')
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
      // sorting and moving inside a playlist come later; nothing to clear here
      case 'sortNext':
      case 'sortReverse':
      case 'move':
      case 'clearQueue':
        return true
    }
    return false
  }

  const o = lib.open
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
        return songMenu({ all: o.songs, source: o.file ?? '', index: row.index, songs, isFavourite: ui.allFavourite(songs), ...(o.kind === 'history' ? {} : { list: o.name }) })
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
      setSel(select(sel(), at))
      if (row?.kind === 'song') return hit.isDouble ? enter(at) : undefined
      hasOpened.current = row?.kind === 'up' || row?.kind === 'list' || row?.kind === 'history'
      enter(at)
    },
    chosen: () => (o ? chosenSongs().map(r => r.song) : undefined),
    handle,
  }
}

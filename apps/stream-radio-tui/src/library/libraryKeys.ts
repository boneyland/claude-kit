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
import { confirmMenu, FAVOURITES_MENU, HISTORY_MENU, HISTORY_SONG_MENU, LIST_MENU, LIST_SONG_MENU, type MenuItem } from '../ui/Menu'
import { clamp, clear, current, extend, NO_SELECTION, select, targets, toggle, type Held, type Selection } from '../ui/selection'
import type { Turns } from '../ui/turns'
import { HISTORY, libraryRows, useLibrary, type Library, type LibraryRow } from './useLibrary'

const BUSY = 'The playlists are busy; try again.'
const HISTORY_READ_ONLY = "Recently played can't be edited; Clear it from its menu."

// What the tab needs of the App around it.
export type PlaylistsUi = {
  mode(): Mode
  setMode(mode: Mode): void
  // a menu over row `at` of this tab
  showMenu(items: readonly MenuItem[], at: number): void
  say(text: string): void
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
  const lib = useLibrary(h, isShown)
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
  const add = (where: 'end' | 'next') => {
    const row = rows[sel().cursor]
    const next = where === 'next' ? ' to play next' : ''
    const name = listName(row)
    if (!lib.open && name) {
      return act(() =>
        inTurn(async () => {
          const plan = await planList(h, name)
          if (typeof plan === 'string') return plan
          return (await addToQueue(h, config, plan.entries, where)) || `Added ${plural(plan.entries.length, 'song')}${next}.`
        }),
      )
    }
    const songs = chosenSongs()
    if (!songs.length) return
    setSel(clear(sel()))
    act(() => inTurn(async () => (await addToQueue(h, config, songs.map(r => entryOf(r.song)), where)) || `Added ${plural(songs.length, 'song')}${next}.`))
  }
  const remove = () => {
    const o = lib.open
    const row = rows[sel().cursor]
    if (!o) {
      // a list at the top level: Delete playlist, which asks first
      if (row?.kind === 'history') return ui.say(HISTORY_READ_ONLY)
      if (row?.kind === 'list') return row.info.name === FAVOURITES ? ui.say(`${FAVOURITES} can't be deleted.`) : handleList({ kind: 'deleteList' })
      return
    }
    if (o.kind === 'history') return ui.say(HISTORY_READ_ONLY)
    const songs = chosenSongs().map(r => r.song)
    if (!songs.length) return
    setSel(clear(sel()))
    act(() =>
      inTurn(async () => {
        const home = await h.home().catch(() => '')
        let removed = 0
        const done = await editPlaylist(h, o.name, f => {
          const r = removeSongs(f, songs, home)
          removed = r.removed
          return r.file
        })
        if (done === 'busy') return BUSY
        lib.refresh()
        return `Removed ${plural(removed, 'song')} from ${o.name}.`
      }),
    )
  }
  // Delete playlist, Clear, Rename and Play, from a list's menu (the cursor's row).
  const handleList = (a: Action): boolean => {
    const at = sel().cursor
    const row = rows[at]
    const name = listName(row)
    if (!name || lib.open) return true
    switch (a.kind) {
      case 'playList':
        act(() => playList(h, config, name, 0))
        return true
      case 'rename':
        if (row?.kind === 'list' && name !== FAVOURITES) ask({ kind: 'rename', from: name })
        return true
      case 'deleteList':
        if (row?.kind !== 'list' || name === FAVOURITES) return true
        if (!a.isSure) ui.showMenu(confirmMenu(`Delete "${name}"`, { kind: 'deleteList', isSure: true }), at)
        else
          act(() =>
            inTurn(async () => {
              const said = await deletePlaylist(h, name)
              lib.refresh()
              return said || `Deleted "${name}".`
            }),
          )
        return true
      case 'clearHistory':
        if (row?.kind !== 'history') return true
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
          const first = rows.find(r => r.kind === 'song')
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
      case 'enter':
        enter(at)
        return true
      case 'openFolder':
        if (!lib.open && listName(rows[at])) enter(at)
        return true
      case 'shutFolder':
      case 'folderUp':
        if (lib.open) close()
        return true
      case 'add':
        add(a.where)
        return true
      case 'remove':
        remove()
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
      if (row?.kind === 'song') return o?.kind === 'history' ? HISTORY_SONG_MENU : LIST_SONG_MENU
      if (row?.kind === 'history') return HISTORY_MENU
      if (row?.kind === 'list') return row.info.name === FAVOURITES ? FAVOURITES_MENU : LIST_MENU
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
    handle,
  }
}

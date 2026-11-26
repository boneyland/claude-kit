import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, useApp, useInput } from 'ink'
import { Text } from './Text'
import { nextRepeat, stepVolume } from '@core/nowplaying'
import { addToQueue, CONNECTING, expandEntries, LOADING, pick, playQueue, resumeQueue, seek, setRepeat, setVolume, step, stopPlaying, toggleShuffle, togglePause } from '@core/player'
import { createPlaylist, listMtime } from '@core/libraryFile'
import { FAVOURITES, type Song } from '@core/library'
import { checklistRows, playingSong, toggleFavourite, toggleIn, type ChecklistRow } from '@core/library-actions'
import { keyAction, NO_KEY, type Action, type Keys, type LibraryOn, type Mode } from '../keys'
import type { Session } from '../session'
import { Help, helpTop } from './Help'
import { Hints } from './Hints'
import { tilde, trackOf, useArt, useDuration, useHome, usePeaks, usePlayer, useRefState, useSettling, useSize, useTags, useHomeEnd, Settling, type View } from './hooks'
import type { Media } from '../media'
import type { MouseSource } from '../mouse/sgr'
import { MouseProvider, type Hit } from '../mouse/Clickable'
import type { Graphics } from '../gfx/screen'
import { firstRow } from './List'
import { QueueView } from './QueueView'
import { editCells, FilesView } from './FilesView'
import { edit, indexAt, type Line } from './lineEdit'
import { chapterMenu, filesMenu, Menu, queueMenu, type MenuItem } from './Menu'
import { Checklist } from './Checklist'
import { useFavourites } from '../library/useFavourites'
import { useFiles } from '../files/useFiles'
import { FILES_SORTS, FILES_SORT_LABEL } from '../files/tree'
import { stepTab, Tabs, type Tab } from './Tabs'
import { NamePrompt, PlaylistsView } from './PlaylistsView'
import { usePlaylistsTab } from '../library/libraryKeys'
import { POLL_MS, songTitle } from '../library/useLibrary'
import { useTagBook } from './tagbook'
import type { TagReader } from '../media/tags'
import { filterFlat, flatRows } from '../queue/rows'
import { SORT_LABEL } from '../queue/sort'
import { useQueue } from '../queue/useQueue'
import { clamp, clear, current, extend, NO_SELECTION, select, targets, toggle, type Selection } from './selection'
import { useTurns } from './turns'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// Rows the wheel moves the list by.
const WHEEL_ROWS = 3
// How soon a second Ctrl-C must come to quit, or a second C to clear the queue.
const INTERRUPT_MS = 2000

// Lines besides the list and now playing: title, tab row, list heading, the
// text line, the rule, the status line, two hint lines; and one left free, as
// Ink clears the whole screen at each frame that fills it.
const FIXED_ROWS = 9
const WIDE_COLUMNS = 80
const PICK_INSIDE = 'Pick songs inside a playlist.'

// What * and P act on, made when pressed (or when a menu opened): songs
// (toExpand: Files rows, folders still to be expanded), or the song playing.
type Target = { songs: readonly Song[]; toExpand?: boolean } | { isPlaying: true }
const targetOf = (on: LibraryOn): Target | undefined => (on.isPlaying ? { isPlaying: true } : on.songs ? { songs: on.songs, ...(on.toExpand ? { toExpand: true } : {}) } : undefined)

// media: the files and mpv the pane draws pictures from; graphics: where the
// pictures go, when the terminal can show them. Neither in most tests.
// tags: reads songs' tags; music-metadata unless a test gives another.
type Props = { session: Session; subscribe: (fn: () => void) => () => void; media?: Media; graphics?: Graphics; mouse?: MouseSource; tags?: TagReader }

// mouse: the clicks and wheel read out of stdin; none in most tests.
export function App({ session, subscribe, media, graphics, mouse, tags }: Props) {
  const view = usePlayer(session, subscribe)
  return <MouseProvider source={mouse}>{view ? <Player session={session} view={view} media={media} graphics={graphics} tagReader={tags} /> : null}</MouseProvider>
}

function Player({ session, view, media, graphics, tagReader }: { session: Session; view: View; media?: Media; graphics?: Graphics; tagReader?: TagReader }) {
  const h = session.host
  const { exit } = useApp()
  const { columns, rows: lines } = useSize()
  const duration = useDuration(h, view.playing, view.elapsed)
  const home = useHome(h)
  const track = trackOf(view)
  const peaks = usePeaks(media, track.file)
  const tags = useTags(h, view.playing)
  const isWide = columns >= WIDE_COLUMNS
  // the pictures wait for a resize to settle; the text does not
  const isSettling = useSettling(`${columns}x${lines}`)
  const art = useArt(media, track, !!graphics && isWide)
  // Read by the key handler through .current: see useRefState.
  const [modeRef, setMode] = useRefState<Mode>('list')
  // Queue when there is something in it, else Files
  const [tabRef, setTabState] = useRefState<Tab>(view.queue.kind !== 'none' ? 'queue' : 'files')
  // Another tab leaves a line being typed: each tab's filter is its own.
  const setTab = (t: Tab) => {
    if (t !== tabRef.current && ['filter', 'name', 'open'].includes(modeRef.current)) {
      closeChecklist()
      setMode('list')
    }
    setTabState(t)
  }
  const tab = tabRef.current
  const book = useTagBook(h, tagReader)
  const files = useFiles(h, book)
  const fRows = files.rows
  // the Files location being edited in its heading (mode open)
  const [lineRef, setLine] = useRefState<Line>({ text: '', at: 0 })
  // a drag in the Queue: the row pressed and where the rows would land
  const [dragRef, setDrag] = useRefState<{ from: number; to: number } | undefined>(undefined)
  // a row's menu, open: its items, the row (a place in the tab's rows), the item chosen
  const [menuRef, setMenu] = useRefState<{ items: readonly MenuItem[]; at: number; choice: number } | undefined>(undefined)
  // Add to playlist's checklist, open (or under its name prompt, for + New
  // playlist…): the songs it was opened on, its rows, the row chosen, and the
  // list row it opened from (a place in the tab's rows)
  const [checkRef, setCheck] = useRefState<{ songs: readonly Song[]; rows: ChecklistRow[]; choice: number; at: number } | undefined>(undefined)
  // the checklist's new playlist's name, being typed (mode name)
  const [newNameRef, setNewName] = useRefState<Line | undefined>(undefined)
  // a press on a picked row selects it only when let go without a drag
  const pendingSelect = useRef<number | undefined>(undefined)
  // the key list's first line shown
  const [helpTopRef, setHelpTop] = useRefState(0)
  // when Ctrl-C was last pressed; 0 for not lately
  const interruptAt = useRef(0)
  // when C was last pressed; 0 for not lately
  const clearAt = useRef(0)
  const mode = modeRef.current
  const [notice, setNotice] = useState('')
  useEffect(() => void (view.statusSeq > 0 && setNotice(view.status)), [view.statusSeq])

  const { act, inTurn } = useTurns(setNotice)
  const favs = useFavourites(h, view.playing)
  const allFavourite = (songs: readonly Song[]) => songs.length > 0 && songs.every(s => favs.has(s.path))
  const queueTab = useQueue(h, session.config, view, book, home, { act, inTurn })
  const q = view.queue
  // a video's chapters: the video, which the view doesn't name, from the queue
  const [chapterVideo, setChapterVideo] = useState('')
  useEffect(() => {
    if (q.kind !== 'chapters') return
    let isLive = true
    playingSong(h).then(
      s => isLive && setChapterVideo(s?.path ?? ''),
      () => undefined,
    )
    return () => {
      isLive = false
    }
  }, [q.kind, view.playing, h])
  // the file or URL playing, for its ★
  const playingPath = !view.playing ? '' : q.kind === 'playlist' ? (q.paths[q.current] ?? '') : q.kind === 'chapters' ? chapterVideo : view.lastUrl
  const filter = view.filter.trim()
  const rows = queueTab.rows
  const fKey = useMemo(() => fRows.map(r => (r.kind === 'file' || r.kind === 'dir' ? r.path : r.kind)).join('\n'), [fRows])
  const qSel = queueTab.sel
  const setQSel = queueTab.setSel
  const filesSel = (): Selection => clamp(current(files.sel(), fKey) ?? NO_SELECTION, fRows.length)
  const setF = (sel: Selection) => files.setSel({ ...sel, forKey: fKey })
  const isEditable = queueTab.isEditable
  const showMenu = (items: readonly MenuItem[], at: number) => {
    setMenu({ items, at, choice: 0 })
    setMode('menu')
  }
  const pl = usePlaylistsTab(h, session.config, tab === 'playlists', view.playing, { act, inTurn }, { mode: () => modeRef.current, setMode, showMenu, say: setNotice, allFavourite }, book, home)
  // The tab showing: its selection, rows and scroll.
  const isQueueTab = () => tabRef.current === 'queue'
  const isPlaylistsTab = () => tabRef.current === 'playlists'
  const curSel = () => (isQueueTab() ? qSel() : isPlaylistsTab() ? pl.sel() : filesSel())
  const setCurSel = (sel: Selection) => (isQueueTab() ? setQSel(sel) : isPlaylistsTab() ? pl.setSel(sel) : setF(sel))
  const curCount = () => (isQueueTab() ? rows.length : isPlaylistsTab() ? pl.rows.length : fRows.length)
  const setCurTop = (top: number | undefined) => (isQueueTab() ? queueTab.setTop(top) : isPlaylistsTab() ? pl.setTop(top) : files.setTop(top))
  const selected = qSel().cursor
  const picked = qSel().picked

  const setFilter = (fn: (text: string) => string) => {
    queueTab.refilter()
    void h.vars.change('filter', fn)
  }

  // Adds the picked Files rows (or the cursor's), folders whole, in row order.
  const addFiles = (where: 'end' | 'next') => {
    const sel = filesSel()
    const chosen = targets(sel).flatMap(i => {
      const r = fRows[i]
      return r && (r.kind === 'file' || r.kind === 'dir') ? [r] : []
    })
    if (!chosen.length) return
    setF(clear(sel))
    const songs = chosen.filter(r => r.kind === 'file').length
    const folders = chosen.length - songs
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
    const said = `Added ${[songs ? plural(songs, 'song') : '', folders ? plural(folders, 'folder') : ''].filter(Boolean).join(' and ')}${where === 'next' ? ' to play next' : ''}.`
    act(() => inTurn(async () => (await addToQueue(h, session.config, chosen.flatMap(r => files.entriesOf(r)), where)) || said))
  }
  // The menu of row `at` of the tab showing; the cursor moves there unless it is picked.
  const openMenu = (at: number) => {
    const sel = curSel()
    // the rows it acts on: the picked, when it opens on one of them
    const on = sel.picked.includes(at) ? sel.picked : [at]
    const items = isQueueTab()
      ? rows[at]
        ? isEditable()
          ? (() => {
              const songs = queueSongs(on)
              return queueMenu({ songs, isFavourite: allFavourite(songs) })
            })()
          : chapterMenu(favs.has(playingPath))
        : undefined
      : isPlaylistsTab()
        ? pl.menuOf(at)
        : fRows[at]?.kind === 'file' || fRows[at]?.kind === 'dir'
          ? (() => {
              const songs = filesEntries(on)
              // a folder's songs aren't known yet: it offers Favourite
              const isFavourite = on.every(i => fRows[i]?.kind === 'file') && allFavourite(songs)
              return filesMenu({ songs, toExpand: true, isFavourite })
            })()
          : undefined
    if (!items) return
    setCurSel(sel.picked.includes(at) ? { ...sel, cursor: at } : select(sel, at))
    showMenu(items, at)
  }
  const closeMenu = () => {
    setMenu(undefined)
    setMode('list')
  }
  // A click outside the open menu, or the checklist, only closes it.
  const dismissMenu = () => {
    if (modeRef.current === 'checklist') {
      closeChecklist()
      setMode('list')
      return true
    }
    if (modeRef.current !== 'menu') return false
    closeMenu()
    return true
  }

  // The Queue's songs at rows `at`: each one's file or URL, and its title.
  const queueSongs = (at: readonly number[]): Song[] =>
    at.flatMap(i => {
      const r = rows[i]
      const path = r ? q.paths[r.index] : undefined
      return r && path ? [r.title ? { path, title: r.title } : { path }] : []
    })
  // The Files rows `at` as Add to queue takes them: a folder whole, still to expand.
  const filesEntries = (at: readonly number[]): Song[] =>
    at.flatMap(i => {
      const r = fRows[i]
      return r && (r.kind === 'file' || r.kind === 'dir') ? files.entriesOf(r) : []
    })
  // What * and P act on in the tab showing: the picked rows, else the
  // cursor's; with no row to act on, the song playing. undefined: nothing
  // (the cursor on ../); 'top': the Playlists tab's lists, not songs.
  const keyTarget = (): Target | 'top' | undefined => {
    const on = targets(curSel())
    if (isQueueTab()) {
      if (!rows.length || q.kind !== 'playlist') return { isPlaying: true }
      const songs = queueSongs(on)
      return songs.length ? { songs } : undefined
    }
    if (isPlaylistsTab()) {
      const songs = pl.chosen()
      if (!songs) return 'top'
      if (songs.length) return { songs }
      return pl.rows.some(r => r.kind === 'song') ? undefined : { isPlaying: true }
    }
    const entries = filesEntries(on)
    if (entries.length) return { songs: entries, toExpand: true }
    return fRows.some(r => r.kind === 'file' || r.kind === 'dir') ? undefined : { isPlaying: true }
  }
  // The songs a target means now: a folder's through its subfolders, as Add
  // to queue has them (note: its word on a cap it hit); a chapter video whole.
  const songsOf = async (t: Target): Promise<{ songs: Song[]; note: string }> => {
    if ('isPlaying' in t) {
      const s = await playingSong(h)
      return { songs: s ? [s] : [], note: '' }
    }
    if (!t.toExpand) return { songs: [...t.songs], note: '' }
    const x = await expandEntries(h, t.songs)
    return { songs: x.songs.map(e => (e.title ? { path: e.path, title: e.title } : { path: e.path })), note: x.note }
  }
  const withNote = (said: string, note: string) => [said, note].filter(Boolean).join(' ')
  const noSongs = (t: Target) => ('isPlaying' in t ? 'Nothing playing.' : 'No songs there.')
  // Favourites, or a list, changed from here: what shows it reads it again.
  const libraryChanged = (name: string) => {
    if (name === FAVOURITES) favs.refresh()
    if (isPlaylistsTab()) pl.lib.refresh()
  }
  // The pick is spent, as Add to queue spends it, so the reply shows.
  const spendPick = () => {
    const sel = curSel()
    if (sel.picked.length) setCurSel(clear(sel))
  }
  // From a key (on: {}) or a menu: the target, or why there is none.
  const libraryTarget = (on: LibraryOn): Target | undefined => {
    const given = targetOf(on)
    if (given) return given
    const t = keyTarget()
    if (t === 'top') return void setNotice(PICK_INSIDE)
    return t
  }
  const favourite = (on: LibraryOn) => {
    const t = libraryTarget(on)
    if (!t) return
    spendPick()
    act(() =>
      inTurn(async () => {
        const { songs, note } = await songsOf(t)
        if (!songs.length) return note || noSongs(t)
        const said = await toggleFavourite(h, songs)
        libraryChanged(FAVOURITES)
        return withNote(said, note)
      }),
    )
  }

  // The checklist: opened on a target's songs, its marks read from the list files.
  const openChecklist = (on: LibraryOn) => {
    const t = libraryTarget(on)
    if (!t) return
    const at = curSel().cursor
    spendPick()
    act(() =>
      inTurn(async () => {
        const { songs, note } = await songsOf(t)
        if (!songs.length) return note || noSongs(t)
        const rows = await checklistRows(h, songs)
        // a key pressed meanwhile (a filter, another menu) keeps its mode
        if (modeRef.current !== 'list') return note
        setCheck({ songs, rows, choice: 0, at })
        setMode('checklist')
        return note
      }),
    )
  }
  const closeChecklist = () => {
    setCheck(undefined)
    setNewName(undefined)
  }
  // The marks again, from the files as they are now; choice: the row to choose.
  const remark = async (songs: readonly Song[], choice?: (rows: ChecklistRow[]) => number) => {
    const rows = await checklistRows(h, songs)
    const c = checkRef.current
    if (!c || c.songs !== songs) return
    const at = choice ? choice(rows) : c.choice
    setCheck({ ...c, rows, choice: Math.max(0, Math.min(at, rows.length)) })
  }
  // While the checklist is open its lists' files are looked at every POLL_MS; the
  // marks are read again when one moved (a list edited elsewhere).
  const checkSongs = checkRef.current?.songs
  useEffect(() => {
    if (!checkSongs) return
    let isLive = true
    let times = new Map<string, number>()
    const look = async (isBaseline: boolean) => {
      const c = checkRef.current
      if (!c || c.songs !== checkSongs) return
      const now = new Map(await Promise.all(c.rows.map(async r => [r.name, await listMtime(h, r.name)] as const)))
      const isMoved = [...now].some(([name, t]) => times.get(name) !== t)
      times = now
      if (isMoved && !isBaseline && isLive) await remark(checkSongs)
    }
    void look(true).catch(() => undefined)
    const timer = h.every(POLL_MS, () => void look(false).catch(() => undefined))
    return () => {
      isLive = false
      timer.cancel()
    }
  }, [checkSongs, h])
  const toggleRow = (i: number) => {
    const c = checkRef.current
    if (!c) return
    setCheck({ ...c, choice: i })
    const row = c.rows[i]
    if (!row) {
      // + New playlist…
      setNewName({ text: '', at: 0 })
      return setMode('name')
    }
    act(() =>
      inTurn(async () => {
        const said = await toggleIn(h, row.name, c.songs)
        libraryChanged(row.name)
        await remark(c.songs)
        return said
      }),
    )
  }
  const submitNewName = () => {
    const c = checkRef.current
    const name = newNameRef.current?.text ?? ''
    setNewName(undefined)
    setMode(c ? 'checklist' : 'list')
    if (!c) return
    act(() =>
      inTurn(async () => {
        const said = await createPlaylist(h, name, c.songs)
        if (said) return said
        libraryChanged(name)
        await remark(c.songs, rows => rows.findIndex(r => r.name === name))
        return `Made the playlist "${name}".`
      }),
    )
  }
  // The keys while the checklist, or its name prompt, is open; false for one it leaves.
  const handleChecklist = (a: Action): boolean => {
    const c = checkRef.current
    if (!c) return false
    if (modeRef.current === 'name') {
      const line = newNameRef.current
      if (!line) return false
      if (a.kind === 'lineEdit') setNewName(edit(line, a.edit))
      else if (a.kind === 'submit') submitNewName()
      else if (a.kind === 'cancel') {
        setNewName(undefined)
        setMode('checklist')
      } else return false
      return true
    }
    const count = c.rows.length + 1
    switch (a.kind) {
      case 'up':
      case 'down':
        setCheck({ ...c, choice: (c.choice + (a.kind === 'up' ? -1 : 1) + count) % count })
        return true
      case 'submit':
        toggleRow(c.choice)
        return true
      case 'cancel':
        closeChecklist()
        setMode('list')
        return true
    }
    return false
  }
  const pickMenu = (i: number) => {
    const item = menuRef.current?.items[i]
    closeMenu()
    if (item) handle(item.action)
  }

  const handle = (a: Action) => {
    const at = curSel().cursor
    const row = rows[at]
    const fileRow = fRows[at]
    const mode = modeRef.current
    const inRange = (n: number) => Math.max(0, Math.min(n, curCount() - 1))
    if ((mode === 'checklist' || mode === 'name') && handleChecklist(a)) return
    if (isPlaylistsTab() && mode !== 'menu' && mode !== 'help' && mode !== 'checklist' && pl.handle(a)) return
    switch (a.kind) {
      case 'up':
      case 'down':
        if (mode === 'menu' && menuRef.current) {
          const m = menuRef.current
          return setMenu({ ...m, choice: (m.choice + (a.kind === 'up' ? -1 : 1) + m.items.length) % m.items.length })
        }
        if (mode === 'help') return setHelpTop(helpTop(helpTopRef.current + (a.kind === 'up' ? -1 : 1), bodyHeight, tabRef.current))
        setCurTop(undefined)
        {
          // the arrows move the cursor and keep the pick, so Space can add to it
          const to = inRange(at + (a.kind === 'up' ? -1 : 1))
          return setCurSel({ cursor: to, anchor: to, picked: curSel().picked })
        }
      case 'jump': {
        if (mode === 'help') return setHelpTop(helpTop(a.by === 'all' ? a.dir * Infinity : helpTopRef.current + a.dir * bodyHeight, bodyHeight, tabRef.current))
        setCurTop(undefined)
        // a page keeps a row of the last one in view
        const to = inRange(a.by === 'all' ? a.dir * Infinity : at + a.dir * Math.max(1, listHeight - 1))
        return setCurSel({ cursor: to, anchor: to, picked: curSel().picked })
      }
      case 'extendPick':
        setCurTop(undefined)
        return setCurSel(extend(curSel(), inRange(at + a.by)))
      case 'togglePick':
        return setCurSel(toggle(curSel(), at))
      case 'clearPick':
        return setCurSel(clear(curSel()))
      case 'move':
        return queueTab.move(a.by)
      case 'remove':
        return queueTab.remove()
      case 'clearQueue': {
        if (!isQueueTab() || !isEditable()) return
        // a lone C only asks: hundreds of songs gone at one key is too easy
        const now = Date.now()
        const isAgain = now - clearAt.current <= INTERRUPT_MS
        clearAt.current = isAgain ? 0 : now
        if (!a.isSure && !isAgain) return setNotice(`Press C again to clear all ${q.items.length} songs.`)
        clearAt.current = 0
        return queueTab.clear()
      }
      case 'sortNext':
        if (!isQueueTab()) return files.setSort(FILES_SORTS[(FILES_SORTS.indexOf(files.sort) + 1) % FILES_SORTS.length])
        return queueTab.sortNext()
      case 'sortReverse':
        return isQueueTab() ? queueTab.sortReverse() : undefined
      case 'enter':
        if (isQueueTab()) return row ? act(() => pick(h, session.config, row.index)) : undefined
        if (fileRow?.kind === 'up') return files.goUp()
        if (fileRow?.kind === 'dir') return files.setOpen(fileRow.path)
        if (fileRow?.kind === 'file') addFiles('end')
        return
      case 'add':
        return isQueueTab() ? undefined : addFiles(a.where)
      case 'menu':
        return openMenu(at)
      case 'favourite':
        return favourite(a)
      case 'addToList':
        return openChecklist(a)
      case 'folderUp':
        return isQueueTab() ? undefined : files.goUp()
      case 'goPlaying': {
        const file = trackOf(view).file
        if (!file) return setNotice(view.playing ? "What's playing isn't a file here." : 'Nothing is playing.')
        setTab('files')
        return files.reveal(file)
      }
      case 'shutFolder':
      case 'openFolder':
        if (!isQueueTab() && fileRow?.kind === 'dir') files.setOpen(fileRow.path, a.kind === 'openFolder')
        return
      case 'tab':
        return setTab(stepTab(tabRef.current, a.dir))
      case 'pause':
        return act(async () => {
          // stopped with a queue: play it, its song from the start, as the
          // mod's ▶ does (l resumes mid-song)
          const [playing, queue] = await Promise.all([h.vars.read('playing'), h.vars.read('queue')])
          if (!playing && queue.kind !== 'none') return playQueue(h, session.config, session.config.defaultUrl)
          return (await togglePause(h)) ? '' : 'The player is not ready yet.'
        })
      case 'next':
      case 'prev':
        return act(() => step(h, a.kind === 'next' ? 1 : -1))
      case 'seek':
        return act(() => inTurn(() => seek(h, a.by, true)))
      case 'volume':
        return act(() => inTurn(async () => setVolume(h, session.config.volume, stepVolume(await h.vars.read('volume'), a.dir))))
      case 'shuffle':
        return act(() => toggleShuffle(h))
      case 'repeat':
        return act(() => inTurn(async () => setRepeat(h, nextRepeat(await h.vars.read('repeat')))))
      case 'filterMode':
        return setMode('filter')
      case 'openMode':
        // o edits the Files tab's location, from nothing
        setTab('files')
        setLine({ text: '', at: 0 })
        return setMode('open')
      case 'last':
        return act(async () => {
          // what plays is the queue, so resuming it again would only jump back;
          // a play still loading or connecting is not playing yet: `l` wins
          if (view.playing && view.playing !== LOADING && view.playing !== CONNECTING) return `Already playing ${view.playing}.`
          return resumeQueue(h, session.config, session.config.defaultUrl)
        })
      case 'stop':
        return act(async () => {
          await stopPlaying(h, session.config)
          return 'Stopped.'
        })
      case 'help':
        setHelpTop(0)
        return setMode('help')
      case 'closeHelp':
        return setMode('list')
      case 'interrupt': {
        // a lone Ctrl-C (copy habit, say) only warns; a second soon after quits
        const at = Date.now()
        const isAgain = at - interruptAt.current <= INTERRUPT_MS
        interruptAt.current = isAgain ? 0 : at
        if (!isAgain) return setNotice('Press Ctrl+C again to quit.')
        session.close()
        return exit()
      }
      case 'quit':
        session.close()
        return exit()
      case 'type':
      case 'erase': {
        // Backspace takes off a whole character: an emoji is two UTF-16 units
        const change = (t: string) => (a.kind === 'type' ? t + a.text : edit({ text: t, at: t.length }, { kind: 'erase' }).text)
        return mode === 'filter' ? setFilter(change) : undefined
      }
      case 'lineEdit':
        return setLine(edit(lineRef.current, a.edit))
      case 'submit':
        if (mode === 'menu') return pickMenu(menuRef.current?.choice ?? 0)
        setMode('list')
        if (mode === 'filter') {
          // The store, not the last render: typing may not have redrawn yet.
          return act(async () => {
            const [queue, text] = await Promise.all([h.vars.read('queue'), h.vars.read('filter')])
            const first = filterFlat(flatRows(queue, book.get, home), text.trim())[0]
            return first ? pick(h, session.config, first.index) : 'Nothing matches.'
          })
        }
        const text = lineRef.current.text
        return act(async () => {
          if (!text.trim()) return ''
          return files.goTo(text.trim(), setNotice)
        })
      case 'cancel':
        if (mode === 'menu') return closeMenu()
        if (mode === 'filter') setFilter(() => '')
        return setMode('list')
    }
  }
  const onKey = (input: string, key: Keys) => {
    const a = keyAction(input, key, modeRef.current, { tab: tabRef.current, hasPick: curSel().picked.length > 0 })
    if (a) handle(a)
  }
  useInput(onKey)
  useHomeEnd(k => onKey('', { ...NO_KEY, [k]: true }))

  const sideWidth = isWide ? Math.max(28, Math.floor(columns * 0.35)) : columns
  const listWidth = isWide ? columns - sideWidth : columns
  const listHeight = Math.max(1, lines - FIXED_ROWS - (isWide ? 0 : NOW_PLAYING_ROWS + 1))
  // The lines between the title and the text line: the list and the pane.
  const bodyHeight = listHeight + 2 + (isWide ? 0 : NOW_PLAYING_ROWS + 1)
  const heading = filter
    ? `${rows.length} of ${q.items.length} ${q.kind === 'chapters' ? 'chapters' : 'songs'} match`
    : q.kind === 'playlist'
      ? `Queue${q.root ? ` · ${tilde(q.root, home)}` : ''}`
      : q.kind === 'chapters'
        ? 'Chapters'
        : 'No queue or chapters.'
  const shownFilter = tab === 'playlists' ? pl.filter : view.filter
  const newName = newNameRef.current
  const textLine =
    mode === 'name' && newName ? (
      <NamePrompt label="New playlist name: " line={newName} width={columns} />
    ) : mode === 'name' && pl.prompt ? (
      <NamePrompt label={pl.prompt.label} line={pl.prompt.line} width={columns} />
    ) : mode === 'filter' ? (
      `/ filter: ${shownFilter}_`
    ) : mode === 'open' ? (
      'go to a folder or URL · Enter goes there · Esc leaves it'
    ) : shownFilter.trim() ? (
      `/ filter: ${shownFilter.trim()}`
    ) : (
      ' '
    )
  // Only with a known length: a live stream has no bar to click.
  const onSeek = (share: number) => duration > 0 && act(() => seek(h, share * duration))
  const onVolume = (level: number) => act(() => inTurn(() => setVolume(h, session.config.volume, level)))
  const first = firstRow(selected, rows.length, listHeight, queueTab.top)
  // A click selects and holds the view where it is; a double-click does what
  // Enter does. Ctrl-click picks one row; Shift- or Alt-click a range.
  const onRow = (index: number, hit: Hit) => {
    if (dismissMenu()) return
    queueTab.setTop(first)
    pendingSelect.current = undefined
    const sel = qSel()
    if (hit.mods.ctrl) return setQSel(toggle(sel, index))
    if (hit.mods.shift || hit.mods.alt) return setQSel(extend(sel, index))
    if (hit.isDouble) {
      setQSel(select(sel, index))
      return handle({ kind: 'enter' })
    }
    // a picked row may be about to be dragged with the rest
    if (sel.picked.includes(index)) {
      pendingSelect.current = index
      return setQSel({ ...sel, cursor: index })
    }
    setQSel(select(sel, index))
  }
  // dy: rows from the row pressed
  const onRowDrag = (index: number, dy: number) => {
    pendingSelect.current = undefined
    if (!isEditable()) return
    setDrag({ from: index, to: Math.max(0, Math.min(index + dy, rows.length)) })
  }
  const onRowRelease = () => {
    const drag = dragRef.current
    setDrag(undefined)
    if (pendingSelect.current !== undefined) {
      setQSel(select(qSel(), pendingSelect.current))
      pendingSelect.current = undefined
    }
    if (!drag || drag.to === drag.from) return
    queueTab.moveTo(drag.to < rows.length ? rows[drag.to].index : q.items.length)
  }
  const onWheel = (dir: 'up' | 'down') => queueTab.setTop(firstRow(selected, rows.length, listHeight, first + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  const fSel = filesSel()
  const fFirst = firstRow(fSel.cursor, fRows.length, listHeight, files.top)
  const onFilesWheel = (dir: 'up' | 'down') => files.setTop(firstRow(fSel.cursor, fRows.length, listHeight, fFirst + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  // ../ goes up and a folder opens or shuts, at a click; a file only selects.
  const onFileRow = (index: number, hit: Hit) => {
    if (dismissMenu() || leaveEdit()) return
    files.setTop(fFirst)
    const sel = filesSel()
    if (hit.mods.ctrl) return setF(toggle(sel, index))
    if (hit.mods.shift || hit.mods.alt) return setF(extend(sel, index))
    const row = fRows[index]
    // the second press of a double-click on ../ lands on the new folder's ../: one level is enough
    if (row?.kind === 'up') return hit.isDouble ? undefined : files.goUp()
    setF(select(sel, index))
    if (hit.isDouble && (row?.kind === 'file' || row?.kind === 'dir')) {
      // the first click of the two opened or shut it: put that back
      if (row.kind === 'dir') files.setOpen(row.path)
      return addFiles('end')
    }
    if (row?.kind === 'dir') files.setOpen(row.path)
  }
  // A click outside the location being edited only leaves it, as Esc does.
  const leaveEdit = () => {
    if (modeRef.current !== 'open' && modeRef.current !== 'name') return false
    closeChecklist()
    setMode('list')
    return true
  }
  // A click on the Files heading edits the location in place, the cursor
  // where it landed (at the end from the prefix, or from a YouTube playlist's title,
  // which edits as its URL); while editing, it moves the cursor there.
  const onHeading = (x: number) => {
    const cells = editCells(listWidth)
    if (modeRef.current === 'open') return setLine({ ...lineRef.current, at: indexAt(lineRef.current, cells, Math.max(0, x)) })
    if (dismissMenu()) return
    const text = files.rootText(home)
    if (!text) return
    const isAsShown = text === files.rootLabel(home)
    setLine({ text, at: isAsShown && x >= 0 ? indexAt({ text, at: 0 }, cells, x) : text.length })
    setMode('open')
  }
  const plSel = pl.sel()
  const plFirst = firstRow(plSel.cursor, pl.rows.length, listHeight, pl.top)
  const onPlWheel = (dir: 'up' | 'down') => pl.setTop(firstRow(plSel.cursor, pl.rows.length, listHeight, plFirst + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  const onPlRow = (index: number, hit: Hit) => dismissMenu() || leaveEdit() || pl.onRow(index, hit, plFirst)
  // the shown songs' tags, for their artist (the newest asked is read first)
  const plShownKey = tab === 'playlists' ? pl.rows.slice(plFirst, plFirst + listHeight).flatMap(r => (r.kind === 'song' ? [r.song.path] : [])).join('\n') : ''
  useEffect(() => book.need(plShownKey ? plShownKey.split('\n') : []), [book, plShownKey])
  const fShown = tab === 'files' ? fRows.slice(fFirst, fFirst + listHeight) : []
  const fShownKey = fShown.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n')
  // every file's tags when sorting by them; the shown ones' first
  const fAllKey = useMemo(
    () => (tab === 'files' && (files.sort === 'artist' || files.sort === 'albumArtist') ? fRows.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n') : ''),
    [tab, files.sort, fRows],
  )
  useEffect(() => book.need(fAllKey ? fAllKey.split('\n') : []), [book, fAllKey])
  useEffect(() => book.need(fShownKey ? fShownKey.split('\n') : []), [book, fShownKey])
  const shown = tab === 'queue' ? rows.slice(first, first + listHeight) : []
  const shownKey = shown.map(r => q.paths[r.index] ?? '').join('\n')
  // every song's tags, for sorting; the shown rows' first (the newest asked is read first)
  const allKey = useMemo(() => (tab === 'queue' ? q.paths.join('\n') : ''), [tab, q.paths])
  useEffect(() => book.need(allKey ? allKey.split('\n') : []), [book, allKey])
  useEffect(() => book.need(shownKey ? shownKey.split('\n') : []), [book, shownKey])
  const menu = menuRef.current
  const menuTop = (() => {
    if (!menu) return 0
    const rowY = 2 + menu.at - (tab === 'queue' ? first : tab === 'playlists' ? plFirst : fFirst)
    const height = menu.items.length + 2
    // below the row, or above it when that would run past the list
    return rowY + 1 + height <= listHeight + 2 ? rowY + 1 : Math.max(0, rowY - height)
  })()
  const check = checkRef.current
  // the checklist's rows (+ New playlist… among them) that fit in the list's box, with its title and frame
  const checkRows = Math.max(1, listHeight - 1)
  const checkTop = (() => {
    if (!check) return 0
    const rowY = 2 + check.at - (tab === 'queue' ? first : tab === 'playlists' ? plFirst : fFirst)
    // title, the rows shown and the frame
    const height = Math.min(check.rows.length + 1, checkRows) + 3
    // below the row, or above it when that would run past the list; at the top when neither fits
    return rowY + 1 + height <= listHeight + 2 ? rowY + 1 : Math.max(0, rowY - height)
  })()
  const list = (
    <Box flexDirection="column" width={listWidth}>
      <Tabs
        tab={tab}
        width={listWidth}
        onTab={t => dismissMenu() || (leaveEdit(), setTab(t))}
        sortLabel={
          tab === 'files'
            ? FILES_SORT_LABEL[files.sort]
            : tab === 'queue' && q.kind === 'playlist'
              ? queueTab.sort.field
                ? SORT_LABEL[queueTab.sort.field]
                : 'as queued'
              : tab === 'playlists'
                ? pl.sortLabel
                : undefined
        }
        isReversed={tab === 'queue' && q.kind === 'playlist' ? (queueTab.sort.field ? queueTab.sort.isReversed : undefined) : tab === 'playlists' ? pl.isReversed : undefined}
        onSort={() => dismissMenu() || handle({ kind: 'sortNext' })}
        onReverse={() => dismissMenu() || handle({ kind: 'sortReverse' })}
      />
      {tab === 'queue' ? (
        <QueueView
          heading={heading}
          rows={rows}
          selected={selected}
          picked={new Set(picked)}
          dropAt={dragRef.current?.to}
          current={q.current}
          isFavourite={i => favs.has(q.paths[i] ?? '')}
          height={listHeight}
          width={listWidth}
          first={first}
          onRow={onRow}
          onRowDrag={onRowDrag}
          onRowRelease={onRowRelease}
          onMenu={openMenu}
          onWheel={onWheel}
        />
      ) : tab === 'playlists' ? (
        <PlaylistsView
          heading={pl.heading}
          rows={pl.rows}
          selected={plSel.cursor}
          picked={new Set(plSel.picked)}
          dropAt={pl.drag?.to}
          height={listHeight}
          width={listWidth}
          first={plFirst}
          now={pl.lib.now}
          isFavourite={song => favs.has(song.path)}
          onRow={onPlRow}
          onRowDrag={pl.onRowDrag}
          onRowRelease={pl.onRowRelease}
          onMenu={openMenu}
          onWheel={onPlWheel}
        />
      ) : (
        <FilesView
          heading={files.rootLabel(home)}
          editing={mode === 'open' ? lineRef.current : undefined}
          onHeading={onHeading}
          rows={fRows}
          selected={fSel.cursor}
          picked={new Set(fSel.picked)}
          height={listHeight}
          width={listWidth}
          first={fFirst}
          tags={files.tags}
          isFavourite={r => favs.has(files.entriesOf(r)[0]?.path ?? '')}
          onRow={onFileRow}
          onMenu={openMenu}
          onWheel={onFilesWheel}
        />
      )}
      {/* last, so it is drawn over the rows */}
      {menu && mode === 'menu' ? <Menu items={menu.items} selected={menu.choice} x={4} y={menuTop} onPick={pickMenu} /> : null}
      {check && mode === 'checklist' ? <Checklist rows={check.rows} selected={check.choice} x={4} y={checkTop} height={checkRows} onToggle={toggleRow} onNew={() => toggleRow(check.rows.length)} onClose={() => dismissMenu()} /> : null}
    </Box>
  )

  const drag = dragRef.current
  const statusLine =
    tab === 'queue' && drag && drag.to !== drag.from
      ? `Let go to move ${Math.max(1, picked.length)} song${picked.length > 1 ? 's' : ''} ${drag.to < rows.length ? `above ${rows[drag.to].number}. ${rows[drag.to].title}` : 'to the end'}.`
      : tab === 'playlists' && pl.drag && pl.drag.to !== pl.drag.from
        ? `Let go to move ${Math.max(1, plSel.picked.length)} song${plSel.picked.length > 1 ? 's' : ''} ${(r => (r?.kind === 'song' ? `above ${songTitle(r.song)}` : 'to the end'))(pl.rows[pl.drag.to])}.`
        : (tab === 'queue' ? picked : tab === 'playlists' ? plSel.picked : fSel.picked).length
        ? `${(tab === 'queue' ? picked : tab === 'playlists' ? plSel.picked : fSel.picked).length} picked · Space picks/unpicks · Esc clears`
        : notice
  return (
    <Settling.Provider value={isSettling}>
      <Box flexDirection="column" width={columns}>
        <Text bold>stream-radio</Text>
        {mode === 'help' ? (
          <Help top={helpTopRef.current} height={bodyHeight} width={columns} tab={tab} />
        ) : isWide ? (
          <Box flexDirection="row" height={listHeight + 2}>
            {list}
            <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} width={sideWidth}>
              <NowPlaying view={view} duration={duration} width={sideWidth - 2} isFavourite={favs.has(playingPath)} onAction={handle} onVolume={onVolume} onSeek={onSeek} full={{ height: listHeight + 2, tags, peaks, pixels: graphics ? { graphics, art } : undefined }} />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <NowPlaying view={view} duration={duration} width={columns} isFavourite={favs.has(playingPath)} onAction={handle} onVolume={onVolume} onSeek={onSeek} />
            </Box>
            <Box height={listHeight + 2}>{list}</Box>
          </Box>
        )}
        <Text wrap="truncate-end">{textLine}</Text>
        <Text dimColor>{'─'.repeat(columns)}</Text>
        <Text wrap="truncate-end">{statusLine || ' '}</Text>
        <Hints mode={mode} isWide={isWide} tab={tab} />
      </Box>
    </Settling.Provider>
  )
}

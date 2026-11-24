import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { nextRepeat, stepVolume } from '../../../../plugins/stream-radio/core/nowplaying'
import { addToQueue, pick, removeFromQueue, reorderQueue, resume, seek, setRepeat, setVolume, step, stopPlaying, toggleShuffle, togglePause } from '../../../../plugins/stream-radio/core/player'
import { moveBy, moveTo, type Moved } from '../../../../plugins/stream-radio/core/queue'
import { keyAction, type Action, type Mode } from '../keys'
import type { Session } from '../session'
import { Help, helpTop } from './Help'
import { Hints } from './Hints'
import { tilde, trackOf, useArt, useDuration, useHome, usePeaks, usePlayer, useRefState, useSettling, useSize, useTags, Settling, type View } from './hooks'
import type { Media } from '../media'
import type { MouseSource } from '../mouse/sgr'
import { MouseProvider, type Hit } from '../mouse/Clickable'
import type { Graphics } from '../gfx/screen'
import { firstRow } from './List'
import { PlaylistView } from './PlaylistView'
import { FilesView } from './FilesView'
import { CHAPTER_MENU, FILES_MENU, Menu, PLAYLIST_MENU, type MenuItem } from './Menu'
import { useFiles } from '../files/useFiles'
import { FILES_SORTS, FILES_SORT_LABEL } from '../files/tree'
import { Tabs, type Tab } from './Tabs'
import { useTagBook } from './tagbook'
import type { TagReader } from '../media/tags'
import { filterFlat, flatRows, type FlatRow } from '../playlist/rows'
import type { Queue } from '../../../../plugins/stream-radio/core/host'
import { nextSortField, SORT_LABEL, sortOrder, type SortField } from '../playlist/sort'
import { clamp, clear, extend, NO_SELECTION, remap, select, targets, toggle, type Selection } from './selection'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// A selection and the rows it was made against (see plKeyOf).
type Held = Selection & { forKey?: string }
// The Playlist's rows as a key: each one's file or URL (a chapter's name), in order.
const plKeyOf = (queue: Queue, rows: readonly FlatRow[]) => rows.map(r => queue.paths[r.index] || queue.items[r.index]).join('\n')
// The selection, its pick dropped when the rows are no longer those it was made against.
const current = (held: Held | undefined, key: string): Held | undefined =>
  held && held.forKey !== undefined && held.forKey !== key ? { ...held, picked: [] } : held

// Rows the wheel moves the list by.
const WHEEL_ROWS = 3
// How soon a second Ctrl-C must come to quit.
const INTERRUPT_MS = 2000

// Lines besides the list and now playing: title, tab row, list heading, the
// text line, the rule, the status line, two hint lines; and one left free, as
// Ink clears the whole screen at each frame that fills it.
const FIXED_ROWS = 9
const WIDE_COLUMNS = 80

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
  // Playlist when there is something in it, else Files
  const [tabRef, setTab] = useRefState<Tab>(view.queue.kind !== 'none' ? 'playlist' : 'files')
  const tab = tabRef.current
  const book = useTagBook(h, tagReader)
  const files = useFiles(h, book)
  const fRows = files.rows
  const [typedRef, setTyped] = useRefState('')
  // the Playlist's cursor and picked rows (places in its rows); undefined
  // follows the playing song
  const [plSelRef, setPlSel] = useRefState<Held | undefined>(undefined)
  // the Playlist's last sort, for R and the tab row
  const [sortRef, setSort] = useRefState<{ field?: SortField; isReversed: boolean }>({ isReversed: false })
  // a drag in the Playlist: the row pressed and where the rows would land
  const [dragRef, setDrag] = useRefState<{ from: number; to: number } | undefined>(undefined)
  // a row's menu, open: its items, the row (a place in the tab's rows), the item chosen
  const [menuRef, setMenu] = useRefState<{ items: readonly MenuItem[]; at: number; choice: number } | undefined>(undefined)
  // a press on a picked row selects it only when let go without a drag
  const pendingSelect = useRef<number | undefined>(undefined)
  // the list's first row once the wheel or a click has placed it; undefined
  // keeps the view centred on the selection, as the keys move it
  const [topRef, setTop] = useRefState<number | undefined>(undefined)
  // the key list's first line shown
  const [helpTopRef, setHelpTop] = useRefState(0)
  // when Ctrl-C was last pressed; 0 for not lately
  const interruptAt = useRef(0)
  const mode = modeRef.current
  const [notice, setNotice] = useState('')
  useEffect(() => void (view.statusSeq > 0 && setNotice(view.status)), [view.statusSeq])

  const q = view.queue
  const filter = view.filter.trim()
  const allRows = flatRows(q, book.get, home)
  const rows = filter ? filterFlat(allRows, filter) : allRows
  const playingRow = rows.findIndex(r => r.index === q.current)
  // What the rows are, in order: a pick made against other rows has lapsed
  // (a shuffle, another session's edit, tags changing what a filter matches,
  // a folder opened above it), so it never acts on rows nobody picked.
  const plKey = plKeyOf(q, rows)
  const fKey = fRows.map(r => (r.kind === 'file' || r.kind === 'dir' ? r.path : r.kind)).join('\n')
  // The Playlist's selection as it is now, within its rows.
  const plSel = (): Selection => {
    const at = Math.max(0, playingRow)
    return clamp(current(plSelRef.current, plKey) ?? { cursor: at, anchor: at, picked: [] }, rows.length)
  }
  // key: the rows it is made against; the ones showing unless said
  const setPl = (sel: Selection | undefined, key = plKey) => setPlSel(sel && { ...sel, forKey: key })
  const filesSel = (): Selection => clamp(current(files.sel(), fKey) ?? NO_SELECTION, fRows.length)
  const setF = (sel: Selection) => files.setSel({ ...sel, forKey: fKey } as Held)
  // whether the Playlist holds queue entries (not a video's chapters) to edit
  const isEditable = () => view.queue.kind === 'playlist'
  // The tab showing: its selection, rows and scroll.
  const isPl = () => tabRef.current === 'playlist'
  const curSel = () => (isPl() ? plSel() : filesSel())
  const setCurSel = (sel: Selection) => (isPl() ? setPl(sel) : setF(sel))
  const curCount = () => (isPl() ? rows.length : fRows.length)
  const setCurTop = (top: number | undefined) => (isPl() ? setTop(top) : files.setTop(top))
  const selectedNow = () => plSel().cursor
  const selected = selectedNow()
  const picked = plSel().picked

  // Volume and repeat step from the value as it is when their turn comes, not
  // from the last render: keys in one stdin chunk would all read the same one.
  const turns = useRef<Promise<unknown>>(Promise.resolve())
  const inTurn = (work: () => Promise<string | void>) => {
    const run = turns.current.then(work)
    turns.current = run.catch(() => undefined)
    return run
  }
  const act = (work: () => Promise<string | void>) => {
    work().then(
      reply => setNotice(reply ?? ''),
      error => setNotice(`stream-radio failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }
  const setFilter = (fn: (text: string) => string) => {
    setPl(undefined)
    setTop(undefined)
    void h.vars.change('filter', fn)
  }

  // The queue and the Playlist's rows as the store has them now: an edit's
  // turn may come after an earlier edit changed them.
  const freshRows = async () => {
    const [queue, text] = await Promise.all([h.vars.read('queue'), h.vars.read('filter')])
    const all = flatRows(queue, book.get, home)
    return { queue, rows: text.trim() ? filterFlat(all, text.trim()) : all }
  }
  // Moves the picked rows (or the cursor's); the pick follows them.
  const moveRows = (make: (count: number, picked: number[]) => Moved) =>
    act(() =>
      inTurn(async () => {
        const { queue, rows } = await freshRows()
        const sel = clamp(current(plSelRef.current, plKeyOf(queue, rows)) ?? plSel(), rows.length)
        const from = targets(sel).flatMap(at => (rows[at] ? [rows[at].index] : []))
        if (!from.length) return
        const moved = make(queue.items.length, from)
        if (moved.order.every((old, i) => old === i)) return
        // the rows shown after the move, by their new indexes
        const shownOld = new Set(rows.map(r => r.index))
        const shownNew = moved.order.flatMap((old, i) => (shownOld.has(old) ? [i] : []))
        // the rows as they will be once the move is in the store
        const nameOf = (i: number) => queue.paths[i] || queue.items[i]
        setPl(remap(sel, moved.picked.map(n => shownNew.indexOf(n))), shownNew.map(i => nameOf(moved.order[i]!)).join('\n'))
        setTop(undefined)
        return reorderQueue(h, moved.order)
      }),
    )
  const sortBy = (field: SortField, isReversed: boolean) => {
    setSort({ field, isReversed })
    act(() =>
      inTurn(async () => {
        const queue = await h.vars.read('queue')
        const sortRows = queue.items.map((item, i) => {
          const path = queue.paths[i] ?? ''
          const tags = book.get(path)
          return { path, title: tags?.title || item, tags }
        })
        const unread = field === 'title' || field === 'folder' ? 0 : sortRows.filter(r => r.path.startsWith('/') && !r.tags).length
        // the cursor follows the playing song again, not a place now holding another
        setPl(undefined)
        const reply = await reorderQueue(h, sortOrder(sortRows, field, isReversed))
        return reply || (unread ? `Sorted; ${unread} songs' tags weren't read yet, so they went last.` : '')
      }),
    )
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
    if (isPl() ? !rows[at] : fRows[at]?.kind !== 'file' && fRows[at]?.kind !== 'dir') return
    setCurSel(sel.picked.includes(at) ? { ...sel, cursor: at } : select(sel, at))
    setMenu({ items: isPl() ? (isEditable() ? PLAYLIST_MENU : CHAPTER_MENU) : FILES_MENU, at, choice: 0 })
    setMode('menu')
  }
  const closeMenu = () => {
    setMenu(undefined)
    setMode('list')
  }
  // A click outside the open menu only closes it.
  const dismissMenu = () => {
    if (modeRef.current !== 'menu') return false
    closeMenu()
    return true
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
      case 'extendPick':
        setCurTop(undefined)
        return setCurSel(extend(curSel(), inRange(at + a.by)))
      case 'togglePick':
        return setCurSel(toggle(curSel(), at))
      case 'clearPick':
        return setCurSel(clear(curSel()))
      case 'move':
        if (!isEditable()) return
        return moveRows((count, from) => moveBy(count, from, a.by))
      case 'remove':
        if (!isEditable()) return
        // in its turn, from the queue as it is then: an earlier move or add may change it
        return act(() =>
          inTurn(async () => {
            const { queue, rows } = await freshRows()
            const key = plKeyOf(queue, rows)
            const sel = clamp(current(plSelRef.current, key) ?? plSel(), rows.length)
            const indexes = targets(sel).flatMap(i => (rows[i] ? [rows[i].index] : []))
            if (!indexes.length) return
            setPl(clear(sel), key)
            return removeFromQueue(h, session.config, indexes)
          }),
        )
      case 'sortNext':
        if (!isPl()) return files.setSort(FILES_SORTS[(FILES_SORTS.indexOf(files.sort) + 1) % FILES_SORTS.length])
        if (!isEditable()) return
        return sortBy(nextSortField(sortRef.current.field), false)
      case 'sortReverse':
        if (!isPl() || !isEditable()) return
        return sortBy(sortRef.current.field ?? 'title', !sortRef.current.isReversed)
      case 'enter':
        if (isPl()) return row ? act(() => pick(h, row.index)) : undefined
        if (fileRow?.kind === 'up') return files.goUp()
        if (fileRow?.kind === 'dir') return files.setOpen(fileRow.path)
        if (fileRow?.kind === 'file') addFiles('end')
        return
      case 'add':
        return isPl() ? undefined : addFiles(a.where)
      case 'menu':
        return openMenu(at)
      case 'shutFolder':
      case 'openFolder':
        if (!isPl() && fileRow?.kind === 'dir') files.setOpen(fileRow.path, a.kind === 'openFolder')
        return
      case 'tab':
        return setTab(tabRef.current === 'files' ? 'playlist' : 'files')
      case 'pause':
        return act(async () => ((await togglePause(h)) ? '' : 'The player is not ready yet.'))
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
        // o edits the Files tab's location
        setTab('files')
        setTyped('')
        return setMode('open')
      case 'last':
        return act(async () => {
          if (!view.lastUrl) return 'Nothing played yet: add songs from the Files tab.'
          // lastUrl is what plays, so starting it again would only jump back
          if (view.playing) return `Already playing ${view.playing}.`
          resume(h, session.config, view.lastUrl, view.resumeAt)
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
        const edit = (t: string) => (a.kind === 'type' ? t + a.text : t.slice(0, -1))
        return mode === 'filter' ? setFilter(edit) : setTyped(edit(typedRef.current))
      }
      case 'submit':
        if (mode === 'menu') return pickMenu(menuRef.current?.choice ?? 0)
        setMode('list')
        if (mode === 'filter') {
          // The store, not the last render: typing may not have redrawn yet.
          return act(async () => {
            const [queue, text] = await Promise.all([h.vars.read('queue'), h.vars.read('filter')])
            const first = filterFlat(flatRows(queue, book.get, home), text.trim())[0]
            return first ? pick(h, first.index) : 'Nothing matches.'
          })
        }
        const text = typedRef.current
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
  useInput((input, key) => {
    const a = keyAction(input, key, modeRef.current, { tab: tabRef.current, hasPick: curSel().picked.length > 0 })
    if (a) handle(a)
  })

  const sideWidth = isWide ? Math.max(28, Math.floor(columns * 0.35)) : columns
  const listWidth = isWide ? columns - sideWidth : columns
  const listHeight = Math.max(1, lines - FIXED_ROWS - (isWide ? 0 : NOW_PLAYING_ROWS + 1))
  // The lines between the title and the text line: the list and the pane.
  const bodyHeight = listHeight + 2 + (isWide ? 0 : NOW_PLAYING_ROWS + 1)
  const heading = filter
    ? `${rows.length} of ${q.items.length} ${q.kind === 'chapters' ? 'chapters' : 'songs'} match`
    : q.kind === 'playlist'
      ? `Playlist${q.root ? ` · ${tilde(q.root, home)}` : ''}`
      : q.kind === 'chapters'
        ? 'Chapters'
        : 'No playlist or chapters.'
  const textLine = mode === 'filter' ? `/ filter: ${view.filter}_` : mode === 'open' ? `o go to: ${typedRef.current}_` : filter ? `/ filter: ${filter}` : ' '
  // Only with a known length: a live stream has no bar to click.
  const onSeek = (share: number) => duration > 0 && act(() => seek(h, share * duration))
  const onVolume = (level: number) => act(() => inTurn(() => setVolume(h, session.config.volume, level)))
  const first = firstRow(selected, rows.length, listHeight, topRef.current)
  // A click selects and holds the view where it is; a double-click does what
  // Enter does. Ctrl-click picks one row; Shift- or Alt-click a range.
  const onRow = (index: number, hit: Hit) => {
    if (dismissMenu()) return
    setTop(first)
    pendingSelect.current = undefined
    const sel = plSel()
    if (hit.mods.ctrl) return setPl(toggle(sel, index))
    if (hit.mods.shift || hit.mods.alt) return setPl(extend(sel, index))
    if (hit.isDouble) {
      setPl(select(sel, index))
      return handle({ kind: 'enter' })
    }
    // a picked row may be about to be dragged with the rest
    if (sel.picked.includes(index)) {
      pendingSelect.current = index
      return setPl({ ...sel, cursor: index })
    }
    setPl(select(sel, index))
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
      setPl(select(plSel(), pendingSelect.current))
      pendingSelect.current = undefined
    }
    if (!drag || drag.to === drag.from) return
    const to = drag.to < rows.length ? rows[drag.to].index : q.items.length
    moveRows((count, from) => moveTo(count, from, to))
  }
  const onWheel = (dir: 'up' | 'down') => setTop(firstRow(selected, rows.length, listHeight, first + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  const fSel = filesSel()
  const fFirst = firstRow(fSel.cursor, fRows.length, listHeight, files.top)
  const onFilesWheel = (dir: 'up' | 'down') => files.setTop(firstRow(fSel.cursor, fRows.length, listHeight, fFirst + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  // ../ goes up and a folder opens or shuts, at a click; a file only selects.
  const onFileRow = (index: number, hit: Hit) => {
    if (dismissMenu()) return
    files.setTop(fFirst)
    const sel = filesSel()
    if (hit.mods.ctrl) return setF(toggle(sel, index))
    if (hit.mods.shift || hit.mods.alt) return setF(extend(sel, index))
    const row = fRows[index]
    if (row?.kind === 'up') return files.goUp()
    setF(select(sel, index))
    if (hit.isDouble && (row?.kind === 'file' || row?.kind === 'dir')) {
      // the first click of the two opened or shut it: put that back
      if (row.kind === 'dir') files.setOpen(row.path)
      return addFiles('end')
    }
    if (row?.kind === 'dir') files.setOpen(row.path)
  }
  const fShown = tab === 'files' ? fRows.slice(fFirst, fFirst + listHeight) : []
  const fShownKey = fShown.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n')
  // every file's tags when sorting by them; the shown ones' first
  const fAllKey = tab === 'files' && (files.sort === 'artist' || files.sort === 'albumArtist') ? fRows.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n') : ''
  useEffect(() => book.need(fAllKey ? fAllKey.split('\n') : []), [book, fAllKey])
  useEffect(() => book.need(fShownKey ? fShownKey.split('\n') : []), [book, fShownKey])
  const shown = tab === 'playlist' ? rows.slice(first, first + listHeight) : []
  const shownKey = shown.map(r => q.paths[r.index] ?? '').join('\n')
  // every song's tags, for sorting; the shown rows' first (the newest asked is read first)
  const allKey = tab === 'playlist' ? q.paths.join('\n') : ''
  useEffect(() => book.need(allKey ? allKey.split('\n') : []), [book, allKey])
  useEffect(() => book.need(shownKey ? shownKey.split('\n') : []), [book, shownKey])
  const menu = menuRef.current
  const menuTop = (() => {
    if (!menu) return 0
    const rowY = 2 + menu.at - (tab === 'playlist' ? first : fFirst)
    const height = menu.items.length + 2
    // below the row, or above it when that would run past the list
    return rowY + 1 + height <= listHeight + 2 ? rowY + 1 : Math.max(0, rowY - height)
  })()
  const list = (
    <Box flexDirection="column" width={listWidth}>
      <Tabs
        tab={tab}
        width={listWidth}
        onTab={t => dismissMenu() || setTab(t)}
        sortLabel={
          tab === 'files'
            ? FILES_SORT_LABEL[files.sort]
            : q.kind === 'playlist'
              ? sortRef.current.field
                ? `${SORT_LABEL[sortRef.current.field]}${sortRef.current.isReversed ? ' ↑' : ''}`
                : 'as queued'
              : undefined
        }
        onSort={() => dismissMenu() || handle({ kind: 'sortNext' })}
      />
      {tab === 'playlist' ? (
        <PlaylistView
          heading={heading}
          rows={rows}
          selected={selected}
          picked={new Set(picked)}
          dropAt={dragRef.current?.to}
          current={q.current}
          height={listHeight}
          width={listWidth}
          first={first}
          onRow={onRow}
          onRowDrag={onRowDrag}
          onRowRelease={onRowRelease}
          onMenu={openMenu}
          onWheel={onWheel}
        />
      ) : (
        <FilesView
          heading={`Files · ${files.rootLabel(home)}`}
          rows={fRows}
          selected={fSel.cursor}
          picked={new Set(fSel.picked)}
          height={listHeight}
          width={listWidth}
          first={fFirst}
          tags={files.tags}
          onRow={onFileRow}
          onMenu={openMenu}
          onWheel={onFilesWheel}
        />
      )}
      {/* last, so it is drawn over the rows */}
      {menu && mode === 'menu' ? <Menu items={menu.items} selected={menu.choice} x={4} y={menuTop} onPick={pickMenu} /> : null}
    </Box>
  )

  const drag = dragRef.current
  const statusLine =
    tab === 'playlist' && drag && drag.to !== drag.from
      ? `Let go to move ${Math.max(1, picked.length)} song${picked.length > 1 ? 's' : ''} ${drag.to < rows.length ? `above ${rows[drag.to].number}. ${rows[drag.to].title}` : 'to the end'}.`
      : (tab === 'playlist' ? picked : fSel.picked).length
        ? `${(tab === 'playlist' ? picked : fSel.picked).length} picked · Space picks/unpicks · Esc clears`
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
              <NowPlaying view={view} duration={duration} width={sideWidth - 2} onAction={handle} onVolume={onVolume} onSeek={onSeek} full={{ height: listHeight + 2, tags, peaks, pixels: graphics ? { graphics, art } : undefined }} />
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <NowPlaying view={view} duration={duration} width={columns} onAction={handle} onVolume={onVolume} onSeek={onSeek} />
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

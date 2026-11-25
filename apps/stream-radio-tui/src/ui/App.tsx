import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, useApp, useInput } from 'ink'
import { Text } from './Text'
import { nextRepeat, stepVolume } from '@core/nowplaying'
import { addToQueue, CONNECTING, LOADING, pick, playQueue, resumeQueue, seek, setRepeat, setVolume, step, stopPlaying, toggleShuffle, togglePause } from '@core/player'
import { keyAction, NO_KEY, type Action, type Keys, type Mode } from '../keys'
import type { Session } from '../session'
import { Help, helpTop } from './Help'
import { Hints } from './Hints'
import { tilde, trackOf, useArt, useDuration, useHome, usePeaks, usePlayer, useRefState, useSettling, useSize, useTags, useHomeEnd, Settling, type View } from './hooks'
import type { Media } from '../media'
import type { MouseSource } from '../mouse/sgr'
import { MouseProvider, type Hit } from '../mouse/Clickable'
import type { Graphics } from '../gfx/screen'
import { firstRow } from './List'
import { PlaylistView } from './PlaylistView'
import { editCells, FilesView } from './FilesView'
import { edit, indexAt, type Line } from './lineEdit'
import { CHAPTER_MENU, FILES_MENU, Menu, PLAYLIST_MENU, type MenuItem } from './Menu'
import { useFiles } from '../files/useFiles'
import { FILES_SORTS, FILES_SORT_LABEL } from '../files/tree'
import { Tabs, type Tab } from './Tabs'
import { useTagBook } from './tagbook'
import type { TagReader } from '../media/tags'
import { filterFlat, flatRows } from '../playlist/rows'
import { SORT_LABEL } from '../playlist/sort'
import { usePlaylist } from '../playlist/usePlaylist'
import { clamp, clear, current, extend, NO_SELECTION, select, targets, toggle, type Selection } from './selection'
import { useTurns } from './turns'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// Rows the wheel moves the list by.
const WHEEL_ROWS = 3
// How soon a second Ctrl-C must come to quit, or a second C to clear the playlist.
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
  // the Files location being edited in its heading (mode open)
  const [lineRef, setLine] = useRefState<Line>({ text: '', at: 0 })
  // a drag in the Playlist: the row pressed and where the rows would land
  const [dragRef, setDrag] = useRefState<{ from: number; to: number } | undefined>(undefined)
  // a row's menu, open: its items, the row (a place in the tab's rows), the item chosen
  const [menuRef, setMenu] = useRefState<{ items: readonly MenuItem[]; at: number; choice: number } | undefined>(undefined)
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
  const playlist = usePlaylist(h, session.config, view, book, home, { act, inTurn })
  const q = view.queue
  const filter = view.filter.trim()
  const rows = playlist.rows
  const fKey = useMemo(() => fRows.map(r => (r.kind === 'file' || r.kind === 'dir' ? r.path : r.kind)).join('\n'), [fRows])
  const plSel = playlist.sel
  const setPl = playlist.setSel
  const filesSel = (): Selection => clamp(current(files.sel(), fKey) ?? NO_SELECTION, fRows.length)
  const setF = (sel: Selection) => files.setSel({ ...sel, forKey: fKey })
  const isEditable = playlist.isEditable
  // The tab showing: its selection, rows and scroll.
  const isPl = () => tabRef.current === 'playlist'
  const curSel = () => (isPl() ? plSel() : filesSel())
  const setCurSel = (sel: Selection) => (isPl() ? setPl(sel) : setF(sel))
  const curCount = () => (isPl() ? rows.length : fRows.length)
  const setCurTop = (top: number | undefined) => (isPl() ? playlist.setTop(top) : files.setTop(top))
  const selected = plSel().cursor
  const picked = plSel().picked

  const setFilter = (fn: (text: string) => string) => {
    playlist.refilter()
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
        return playlist.move(a.by)
      case 'remove':
        return playlist.remove()
      case 'clearPlaylist': {
        if (!isPl() || !isEditable()) return
        // a lone C only asks: hundreds of songs gone at one key is too easy
        const now = Date.now()
        const isAgain = now - clearAt.current <= INTERRUPT_MS
        clearAt.current = isAgain ? 0 : now
        if (!a.isSure && !isAgain) return setNotice(`Press C again to clear all ${q.items.length} songs.`)
        clearAt.current = 0
        return playlist.clear()
      }
      case 'sortNext':
        if (!isPl()) return files.setSort(FILES_SORTS[(FILES_SORTS.indexOf(files.sort) + 1) % FILES_SORTS.length])
        return playlist.sortNext()
      case 'sortReverse':
        return isPl() ? playlist.sortReverse() : undefined
      case 'enter':
        if (isPl()) return row ? act(() => pick(h, session.config, row.index)) : undefined
        if (fileRow?.kind === 'up') return files.goUp()
        if (fileRow?.kind === 'dir') return files.setOpen(fileRow.path)
        if (fileRow?.kind === 'file') addFiles('end')
        return
      case 'add':
        return isPl() ? undefined : addFiles(a.where)
      case 'menu':
        return openMenu(at)
      case 'folderUp':
        return isPl() ? undefined : files.goUp()
      case 'goPlaying': {
        const file = trackOf(view).file
        if (!file) return setNotice(view.playing ? "What's playing isn't a file here." : 'Nothing is playing.')
        setTab('files')
        return files.reveal(file)
      }
      case 'shutFolder':
      case 'openFolder':
        if (!isPl() && fileRow?.kind === 'dir') files.setOpen(fileRow.path, a.kind === 'openFolder')
        return
      case 'tab':
        return setTab(tabRef.current === 'files' ? 'playlist' : 'files')
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
      ? `Playlist${q.root ? ` · ${tilde(q.root, home)}` : ''}`
      : q.kind === 'chapters'
        ? 'Chapters'
        : 'No playlist or chapters.'
  const textLine = mode === 'filter' ? `/ filter: ${view.filter}_` : mode === 'open' ? 'go to a folder or URL · Enter goes there · Esc leaves it' : filter ? `/ filter: ${filter}` : ' '
  // Only with a known length: a live stream has no bar to click.
  const onSeek = (share: number) => duration > 0 && act(() => seek(h, share * duration))
  const onVolume = (level: number) => act(() => inTurn(() => setVolume(h, session.config.volume, level)))
  const first = firstRow(selected, rows.length, listHeight, playlist.top)
  // A click selects and holds the view where it is; a double-click does what
  // Enter does. Ctrl-click picks one row; Shift- or Alt-click a range.
  const onRow = (index: number, hit: Hit) => {
    if (dismissMenu()) return
    playlist.setTop(first)
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
    playlist.moveTo(drag.to < rows.length ? rows[drag.to].index : q.items.length)
  }
  const onWheel = (dir: 'up' | 'down') => playlist.setTop(firstRow(selected, rows.length, listHeight, first + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
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
    if (modeRef.current !== 'open') return false
    setMode('list')
    return true
  }
  // A click on the Files heading edits the location in place, the cursor
  // where it landed (at the end from the prefix, or from a playlist's title,
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
  const fShown = tab === 'files' ? fRows.slice(fFirst, fFirst + listHeight) : []
  const fShownKey = fShown.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n')
  // every file's tags when sorting by them; the shown ones' first
  const fAllKey = useMemo(
    () => (tab === 'files' && (files.sort === 'artist' || files.sort === 'albumArtist') ? fRows.flatMap(r => (r.kind === 'file' ? [r.path] : [])).join('\n') : ''),
    [tab, files.sort, fRows],
  )
  useEffect(() => book.need(fAllKey ? fAllKey.split('\n') : []), [book, fAllKey])
  useEffect(() => book.need(fShownKey ? fShownKey.split('\n') : []), [book, fShownKey])
  const shown = tab === 'playlist' ? rows.slice(first, first + listHeight) : []
  const shownKey = shown.map(r => q.paths[r.index] ?? '').join('\n')
  // every song's tags, for sorting; the shown rows' first (the newest asked is read first)
  const allKey = useMemo(() => (tab === 'playlist' ? q.paths.join('\n') : ''), [tab, q.paths])
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
        onTab={t => dismissMenu() || (leaveEdit(), setTab(t))}
        sortLabel={
          tab === 'files'
            ? FILES_SORT_LABEL[files.sort]
            : q.kind === 'playlist'
              ? playlist.sort.field
                ? SORT_LABEL[playlist.sort.field]
                : 'as queued'
              : undefined
        }
        isReversed={tab === 'playlist' && q.kind === 'playlist' && playlist.sort.field ? playlist.sort.isReversed : undefined}
        onSort={() => dismissMenu() || handle({ kind: 'sortNext' })}
        onReverse={() => dismissMenu() || handle({ kind: 'sortReverse' })}
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

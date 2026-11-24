import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { nextRepeat, stepVolume } from '../../../../plugins/stream-radio/core/nowplaying'
import { locate, pick, removeFromQueue, reorderQueue, resume, seek, setRepeat, setVolume, start, step, stopPlaying, toggleShuffle, togglePause } from '../../../../plugins/stream-radio/core/player'
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
import { Tabs, type Tab } from './Tabs'
import { useTagBook } from './tagbook'
import type { TagReader } from '../media/tags'
import { filterFlat, flatRows } from '../playlist/rows'
import { nextSortField, SORT_LABEL, sortOrder, type SortField } from '../playlist/sort'
import { clamp, clear, extend, remap, select, targets, toggle, type Selection } from './selection'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

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
  const [typedRef, setTyped] = useRefState('')
  // the Playlist's cursor and picked rows (places in its rows); undefined
  // follows the playing song
  const [plSelRef, setPlSel] = useRefState<Selection | undefined>(undefined)
  // the Playlist's last sort, for R and the tab row
  const [sortRef, setSort] = useRefState<{ field?: SortField; isReversed: boolean }>({ isReversed: false })
  // a drag in the Playlist: the row pressed and where the rows would land
  const [dragRef, setDrag] = useRefState<{ from: number; to: number } | undefined>(undefined)
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
  // The Playlist's selection as it is now, within its rows.
  const plSel = (): Selection => {
    const at = Math.max(0, playingRow)
    return clamp(plSelRef.current ?? { cursor: at, anchor: at, picked: [] }, rows.length)
  }
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
    setPlSel(undefined)
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
        const sel = clamp(plSelRef.current ?? plSel(), rows.length)
        const from = targets(sel).flatMap(at => (rows[at] ? [rows[at].index] : []))
        if (!from.length) return
        const moved = make(queue.items.length, from)
        if (moved.order.every((old, i) => old === i)) return
        // the rows shown after the move, by their new indexes
        const shownOld = new Set(rows.map(r => r.index))
        const shownNew = moved.order.flatMap((old, i) => (shownOld.has(old) ? [i] : []))
        setPlSel(remap(sel, moved.picked.map(n => shownNew.indexOf(n))))
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
        if (plSelRef.current) setPlSel(clear(plSelRef.current))
        const reply = await reorderQueue(h, sortOrder(sortRows, field, isReversed))
        return reply || (unread ? `Sorted; ${unread} songs' tags weren't read yet, so they went last.` : '')
      }),
    )
  }

  const handle = (a: Action) => {
    const at = selectedNow()
    const row = rows[at]
    const mode = modeRef.current
    switch (a.kind) {
      case 'up':
      case 'down':
        if (mode === 'help') return setHelpTop(helpTop(helpTopRef.current + (a.kind === 'up' ? -1 : 1), bodyHeight))
        setTop(undefined)
        {
          // the arrows move the cursor and keep the pick, so Space can add to it
          const to = Math.max(0, Math.min(at + (a.kind === 'up' ? -1 : 1), rows.length - 1))
          return setPlSel({ cursor: to, anchor: to, picked: plSel().picked })
        }
      case 'extendPick':
        setTop(undefined)
        return setPlSel(extend(plSel(), Math.max(0, Math.min(at + a.by, rows.length - 1))))
      case 'togglePick':
        return setPlSel(toggle(plSel(), at))
      case 'clearPick':
        return setPlSel(clear(plSel()))
      case 'move':
        return moveRows((count, from) => moveBy(count, from, a.by))
      case 'remove': {
        const sel = plSel()
        const indexes = targets(sel).flatMap(i => (rows[i] ? [rows[i].index] : []))
        if (!indexes.length) return
        setPlSel(clear(sel))
        return act(() => inTurn(() => removeFromQueue(h, session.config, indexes)))
      }
      case 'sortNext':
        return sortBy(nextSortField(sortRef.current.field), false)
      case 'sortReverse':
        return sortBy(sortRef.current.field ?? 'title', !sortRef.current.isReversed)
      case 'enter':
        if (tabRef.current === 'playlist' && row) act(() => pick(h, row.index))
        return
      case 'shutFolder':
      case 'openFolder':
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
        setTyped('')
        return setMode('open')
      case 'last':
        return act(async () => {
          if (!view.lastUrl) return 'Nothing played yet: press o to open a URL or path.'
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
          const parsed = await locate(h, text.trim(), session.config.defaultUrl)
          if (parsed.kind === 'play') return start(h, session.config, parsed.url)
          return parsed.kind === 'error' ? parsed.text : 'Type a URL or a path to a file or folder.'
        })
      case 'cancel':
        if (mode === 'filter') setFilter(() => '')
        return setMode('list')
    }
  }
  useInput((input, key) => {
    const a = keyAction(input, key, modeRef.current, { tab: tabRef.current, hasPick: tabRef.current === 'playlist' && plSel().picked.length > 0 })
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
  const textLine = mode === 'filter' ? `/ filter: ${view.filter}_` : mode === 'open' ? `o open: ${typedRef.current}_` : filter ? `/ filter: ${filter}` : ' '
  // Only with a known length: a live stream has no bar to click.
  const onSeek = (share: number) => duration > 0 && act(() => seek(h, share * duration))
  const onVolume = (level: number) => act(() => inTurn(() => setVolume(h, session.config.volume, level)))
  const first = firstRow(selected, rows.length, listHeight, topRef.current)
  // A click selects and holds the view where it is; a double-click does what
  // Enter does. Ctrl-click picks one row; Shift- or Alt-click a range.
  const onRow = (index: number, hit: Hit) => {
    setTop(first)
    pendingSelect.current = undefined
    const sel = plSel()
    if (hit.mods.ctrl) return setPlSel(toggle(sel, index))
    if (hit.mods.shift || hit.mods.alt) return setPlSel(extend(sel, index))
    if (hit.isDouble) {
      setPlSel(select(sel, index))
      return handle({ kind: 'enter' })
    }
    // a picked row may be about to be dragged with the rest
    if (sel.picked.includes(index)) {
      pendingSelect.current = index
      return setPlSel({ ...sel, cursor: index })
    }
    setPlSel(select(sel, index))
  }
  // dy: rows from the row pressed
  const onRowDrag = (index: number, dy: number) => {
    pendingSelect.current = undefined
    setDrag({ from: index, to: Math.max(0, Math.min(index + dy, rows.length)) })
  }
  const onRowRelease = () => {
    const drag = dragRef.current
    setDrag(undefined)
    if (pendingSelect.current !== undefined) {
      setPlSel(select(plSel(), pendingSelect.current))
      pendingSelect.current = undefined
    }
    if (!drag || drag.to === drag.from) return
    const to = drag.to < rows.length ? rows[drag.to].index : q.items.length
    moveRows((count, from) => moveTo(count, from, to))
  }
  const onWheel = (dir: 'up' | 'down') => setTop(firstRow(selected, rows.length, listHeight, first + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  const shown = tab === 'playlist' ? rows.slice(first, first + listHeight) : []
  const shownKey = shown.map(r => q.paths[r.index] ?? '').join('\n')
  // every song's tags, for sorting; the shown rows' first (the newest asked is read first)
  const allKey = tab === 'playlist' ? q.paths.join('\n') : ''
  useEffect(() => book.need(allKey ? allKey.split('\n') : []), [book, allKey])
  useEffect(() => book.need(shownKey ? shownKey.split('\n') : []), [book, shownKey])
  const list = (
    <Box flexDirection="column" width={listWidth}>
      <Tabs
        tab={tab}
        width={listWidth}
        onTab={setTab}
        sortLabel={tab === 'playlist' && q.kind === 'playlist' ? (sortRef.current.field ? `${SORT_LABEL[sortRef.current.field]}${sortRef.current.isReversed ? ' ↑' : ''}` : 'as queued') : undefined}
        onSort={() => handle({ kind: 'sortNext' })}
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
          onWheel={onWheel}
        />
      ) : (
        <Text dimColor>Files</Text>
      )}
    </Box>
  )

  const drag = dragRef.current
  const statusLine =
    tab === 'playlist' && drag && drag.to !== drag.from
      ? `Let go to move ${Math.max(1, picked.length)} song${picked.length > 1 ? 's' : ''} ${drag.to < rows.length ? `above ${rows[drag.to].number}. ${rows[drag.to].title}` : 'to the end'}.`
      : tab === 'playlist' && picked.length
        ? `${picked.length} picked · Space picks/unpicks · Esc clears`
        : notice
  return (
    <Settling.Provider value={isSettling}>
      <Box flexDirection="column" width={columns}>
        <Text bold>stream-radio</Text>
        {mode === 'help' ? (
          <Help top={helpTopRef.current} height={bodyHeight} width={columns} />
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
        <Hints mode={mode} isWide={isWide} />
      </Box>
    </Settling.Provider>
  )
}

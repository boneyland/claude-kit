import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { filterRows, nextRepeat, playlistRows, stepVolume } from '../../../../plugins/stream-radio/core/nowplaying'
import { locate, pick, resume, seek, setRepeat, setVolume, start, step, stopPlaying, toggleShuffle, togglePause } from '../../../../plugins/stream-radio/core/player'
import { keyAction, type Action, type Mode } from '../keys'
import type { Session } from '../session'
import { Help, helpTop } from './Help'
import { Hints } from './Hints'
import { tilde, trackOf, useArt, useDuration, useHome, usePeaks, usePlayer, useRefState, useSize, useTags, type View } from './hooks'
import type { Media } from '../media'
import type { MouseSource } from '../mouse/sgr'
import { MouseProvider, type Hit } from '../mouse/Clickable'
import type { Graphics } from '../gfx/screen'
import { firstRow, isCurrent, isOnArrow, List } from './List'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// Rows the wheel moves the list by.
const WHEEL_ROWS = 3

// Lines besides the list and now playing: title, list heading, the text line,
// the rule, the status line, two hint lines; and one left free, as Ink clears
// the whole screen at each frame that fills it.
const FIXED_ROWS = 8
const WIDE_COLUMNS = 80

// media: the files and mpv the pane draws pictures from; graphics: where the
// pictures go, when the terminal can show them. Neither in most tests.
type Props = { session: Session; subscribe: (fn: () => void) => () => void; media?: Media; graphics?: Graphics; mouse?: MouseSource }

// mouse: the clicks and wheel read out of stdin; none in most tests.
export function App({ session, subscribe, media, graphics, mouse }: Props) {
  const view = usePlayer(session, subscribe)
  return <MouseProvider source={mouse}>{view ? <Player session={session} view={view} media={media} graphics={graphics} /> : null}</MouseProvider>
}

function Player({ session, view, media, graphics }: { session: Session; view: View; media?: Media; graphics?: Graphics }) {
  const h = session.host
  const { exit } = useApp()
  const { columns, rows: lines } = useSize()
  const duration = useDuration(h, view.playing, view.elapsed)
  const home = useHome(h)
  const track = trackOf(view)
  const peaks = usePeaks(media, track.file)
  const tags = useTags(h, view.playing)
  const isWide = columns >= WIDE_COLUMNS
  const art = useArt(media, track, !!graphics && isWide)
  // Read by the key handler through .current: see useRefState.
  const [modeRef, setMode] = useRefState<Mode>('list')
  const [typedRef, setTyped] = useRefState('')
  // the row picked with the arrows; undefined follows the playing one
  const [cursorRef, setCursor] = useRefState<number | undefined>(undefined)
  // the list's first row once the wheel or a click has placed it; undefined
  // keeps the view centred on the selection, as the keys move it
  const [topRef, setTop] = useRefState<number | undefined>(undefined)
  // the key list's first line shown
  const [helpTopRef, setHelpTop] = useRefState(0)
  const mode = modeRef.current
  const [notice, setNotice] = useState('')
  useEffect(() => void (view.statusSeq > 0 && setNotice(view.status)), [view.statusSeq])

  const q = view.queue
  const filter = view.filter.trim()
  const rows = useMemo(
    () => (filter ? filterRows(q.items, q.paths, q.root, filter) : playlistRows(q.items, q.paths, q.root, new Set(view.openFolders), q.current)),
    [q, view.openFolders, filter],
  )
  const playingRow = rows.findIndex(r => isCurrent(r, q.current))
  const selectedNow = () => Math.max(0, Math.min(cursorRef.current ?? playingRow, rows.length - 1))
  const selected = selectedNow()

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
  // isOpen: undefined flips it, as the store has it now
  const setOpen = (path: string, isOpen?: boolean) =>
    void h.vars.change('openFolders', list =>
      (isOpen ?? !list.includes(path)) ? [...new Set([...list, path])] : list.filter(p => p !== path),
    )
  const setFilter = (fn: (text: string) => string) => {
    setCursor(undefined)
    setTop(undefined)
    void h.vars.change('filter', fn)
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
        return setCursor(Math.max(0, Math.min(at + (a.kind === 'up' ? -1 : 1), rows.length - 1)))
      case 'enter':
        if (row?.kind === 'folder') return setOpen(row.path)
        if (row?.kind === 'item') act(() => pick(h, row.index))
        return
      case 'shutFolder':
      case 'openFolder':
        if (row?.kind === 'folder') setOpen(row.path, a.kind === 'openFolder')
        return
      case 'pause':
        return act(async () => ((await togglePause(h)) ? '' : 'The player is not ready yet.'))
      case 'next':
      case 'prev':
        return act(() => step(h, a.kind === 'next' ? 1 : -1))
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
            const first = filterRows(queue.items, queue.paths, queue.root, text.trim()).find(r => r.kind === 'item')
            return first?.kind === 'item' ? pick(h, first.index) : 'Nothing matches.'
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
    const a = keyAction(input, key, modeRef.current)
    if (a) handle(a)
  })

  const sideWidth = isWide ? Math.max(28, Math.floor(columns * 0.35)) : columns
  const listWidth = isWide ? columns - sideWidth : columns
  const listHeight = Math.max(1, lines - FIXED_ROWS - (isWide ? 0 : NOW_PLAYING_ROWS + 1))
  // The lines between the title and the text line: the list and the pane.
  const bodyHeight = listHeight + 1 + (isWide ? 0 : NOW_PLAYING_ROWS + 1)
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
  // Enter does; a click on a folder's arrow opens or shuts it at once.
  const onRow = (index: number, hit: Hit) => {
    const row = rows[index]
    setTop(first)
    setCursor(index)
    // the second press of a double-click on the arrow would only undo the first
    if (row && isOnArrow(row, hit.x) && row.kind === 'folder') return hit.isDouble ? undefined : setOpen(row.path)
    if (hit.isDouble) handle({ kind: 'enter' })
  }
  const onWheel = (dir: 'up' | 'down') => setTop(firstRow(selected, rows.length, listHeight, first + (dir === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)))
  const list = (
    <List heading={heading} rows={rows} selected={selected} current={q.current} height={listHeight} width={listWidth} first={first} onRow={onRow} onWheel={onWheel} />
  )

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>stream-radio</Text>
      {mode === 'help' ? (
        <Help top={helpTopRef.current} height={bodyHeight} width={columns} />
      ) : isWide ? (
        <Box flexDirection="row" height={listHeight + 1}>
          {list}
          <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} width={sideWidth}>
            <NowPlaying view={view} duration={duration} width={sideWidth - 2} onAction={handle} onVolume={onVolume} onSeek={onSeek} full={{ height: listHeight + 1, tags, peaks, pixels: graphics ? { graphics, art } : undefined }} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <NowPlaying view={view} duration={duration} width={columns} onAction={handle} onVolume={onVolume} onSeek={onSeek} />
          </Box>
          <Box height={listHeight + 1}>{list}</Box>
        </Box>
      )}
      <Text wrap="truncate-end">{textLine}</Text>
      <Text dimColor>{'─'.repeat(columns)}</Text>
      <Text wrap="truncate-end">{notice || ' '}</Text>
      <Hints mode={mode} isWide={isWide} />
    </Box>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { filterRows, nextRepeat, playlistRows } from '../../../../plugins/stream-radio/core/nowplaying'
import { locate, pick, resume, setRepeat, setVolume, start, step, stopPlaying, toggleShuffle, togglePause } from '../../../../plugins/stream-radio/core/player'
import { keyAction, type Action, type Mode } from '../keys'
import type { Session } from '../session'
import { Hints } from './Hints'
import { tilde, trackOf, useArt, useDuration, useHome, usePeaks, usePlayer, useRefState, useSize, useTags, type View } from './hooks'
import type { Media } from '../media'
import type { MouseSource } from '../mouse/sgr'
import type { Graphics } from '../gfx/screen'
import { isCurrent, List } from './List'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// Lines besides the list and now playing: title, list heading, the text line,
// the rule, the status line, two hint lines; and one left free, as Ink clears
// the whole screen at each frame that fills it.
const FIXED_ROWS = 8
const WIDE_COLUMNS = 80

// media: the files and mpv the pane draws pictures from; graphics: where the
// pictures go, when the terminal can show them. Neither in most tests.
type Props = { session: Session; subscribe: (fn: () => void) => () => void; media?: Media; graphics?: Graphics; mouse?: MouseSource }

export function App({ session, subscribe, media, graphics }: Props) {
  const view = usePlayer(session, subscribe)
  return view ? <Player session={session} view={view} media={media} graphics={graphics} /> : null
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
    void h.vars.change('filter', fn)
  }

  const handle = (a: Action) => {
    const at = selectedNow()
    const row = rows[at]
    const mode = modeRef.current
    switch (a.kind) {
      case 'up':
      case 'down':
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
        return act(() => inTurn(async () => setVolume(h, session.config.volume, (await h.vars.read('volume')) + a.by)))
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
  const heading = filter
    ? `${rows.length} of ${q.items.length} ${q.kind === 'chapters' ? 'chapters' : 'songs'} match`
    : q.kind === 'playlist'
      ? `Playlist${q.root ? ` · ${tilde(q.root, home)}` : ''}`
      : q.kind === 'chapters'
        ? 'Chapters'
        : 'No playlist or chapters.'
  const textLine = mode === 'filter' ? `/ filter: ${view.filter}_` : mode === 'open' ? `o open: ${typedRef.current}_` : filter ? `/ filter: ${filter}` : ' '
  const list = <List heading={heading} rows={rows} selected={selected} current={q.current} height={listHeight} width={listWidth} />

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>stream-radio</Text>
      {isWide ? (
        <Box flexDirection="row" height={listHeight + 1}>
          {list}
          <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} width={sideWidth}>
            <NowPlaying view={view} duration={duration} width={sideWidth - 2} full={{ height: listHeight + 1, tags, peaks, pixels: graphics ? { graphics, art } : undefined }} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <NowPlaying view={view} duration={duration} width={columns} />
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

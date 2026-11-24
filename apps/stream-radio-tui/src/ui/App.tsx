import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { filterRows, nextRepeat, playlistRows } from '../../../../plugins/stream-radio/core/nowplaying'
import { locate, pick, resume, setRepeat, setVolume, start, step, stopPlaying, toggleShuffle, togglePause } from '../../../../plugins/stream-radio/core/player'
import { keyAction, type Action, type Mode } from '../keys'
import type { Session } from '../session'
import { Hints } from './Hints'
import { useDuration, usePlayer, useSize, type View } from './hooks'
import { isCurrent, List } from './List'
import { NOW_PLAYING_ROWS, NowPlaying } from './NowPlaying'

// Lines besides the list and now playing: title, list heading, the text line,
// the rule, the status line, two hint lines; and one left free, as Ink clears
// the whole screen at each frame that fills it.
const FIXED_ROWS = 8
const WIDE_COLUMNS = 80

type Props = { session: Session; subscribe: (fn: () => void) => () => void }

export function App({ session, subscribe }: Props) {
  const view = usePlayer(session, subscribe)
  return view ? <Player session={session} view={view} /> : null
}

function Player({ session, view }: { session: Session; view: View }) {
  const h = session.host
  const { exit } = useApp()
  const { columns, rows: lines } = useSize()
  const duration = useDuration(h, view.playing, view.elapsed >= 0)
  const [mode, setMode] = useState<Mode>('list')
  const [typed, setTyped] = useState('')
  // the row picked with the arrows; undefined follows the playing one
  const [cursor, setCursor] = useState<number>()
  const [notice, setNotice] = useState('')
  useEffect(() => void (view.status && setNotice(view.status)), [view.status])

  const q = view.queue
  const filter = view.filter.trim()
  const rows = useMemo(
    () => (filter ? filterRows(q.items, q.paths, q.root, filter) : playlistRows(q.items, q.paths, q.root, new Set(view.openFolders), q.current)),
    [q, view.openFolders, filter],
  )
  const playingRow = rows.findIndex(r => isCurrent(r, q.current))
  const selected = Math.max(0, Math.min(cursor ?? playingRow, rows.length - 1))
  const row = rows[selected]

  const act = (work: () => Promise<string | void>) => {
    work().then(
      reply => setNotice(reply ?? ''),
      error => setNotice(`stream-radio failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }
  const setOpen = (path: string, isOpen: boolean) =>
    void h.vars.change('openFolders', list => (isOpen ? [...new Set([...list, path])] : list.filter(p => p !== path)))
  const setFilter = (fn: (text: string) => string) => {
    setCursor(undefined)
    void h.vars.change('filter', fn)
  }

  const handle = (a: Action) => {
    switch (a.kind) {
      case 'up':
      case 'down':
        return setCursor(Math.max(0, Math.min(selected + (a.kind === 'up' ? -1 : 1), rows.length - 1)))
      case 'enter':
        if (row?.kind === 'folder') return setOpen(row.path, !row.isOpen)
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
        return act(() => setVolume(h, session.config.volume, view.volume + a.by))
      case 'shuffle':
        return act(() => toggleShuffle(h))
      case 'repeat':
        return act(() => setRepeat(h, nextRepeat(view.repeat)))
      case 'filterMode':
        return setMode('filter')
      case 'openMode':
        setTyped('')
        return setMode('open')
      case 'last':
        return act(async () => {
          if (!view.lastUrl) return 'Nothing played yet: press o to open a URL or path.'
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
        return mode === 'filter' ? setFilter(edit) : setTyped(edit)
      }
      case 'submit':
        setMode('list')
        if (mode === 'filter') {
          const first = rows.find(r => r.kind === 'item')
          return act(async () => (first?.kind === 'item' ? pick(h, first.index) : 'Nothing matches.'))
        }
        return act(async () => {
          const parsed = await locate(h, typed.trim(), session.config.defaultUrl)
          if (parsed.kind === 'play') return start(h, session.config, parsed.url)
          return parsed.kind === 'error' ? parsed.text : 'Type a URL or a path to a file or folder.'
        })
      case 'cancel':
        if (mode === 'filter') setFilter(() => '')
        return setMode('list')
    }
  }
  useInput((input, key) => {
    const a = keyAction(input, key, mode)
    if (a) handle(a)
  })

  const isWide = columns >= WIDE_COLUMNS
  const sideWidth = isWide ? Math.max(28, Math.floor(columns * 0.35)) : columns
  const listWidth = isWide ? columns - sideWidth : columns
  const listHeight = Math.max(1, lines - FIXED_ROWS - (isWide ? 0 : NOW_PLAYING_ROWS + 1))
  const heading = filter
    ? `${rows.length} of ${q.items.length} ${q.kind === 'chapters' ? 'chapters' : 'songs'} match`
    : q.kind === 'playlist'
      ? `Playlist${q.root ? ` · ${q.root}` : ''}`
      : q.kind === 'chapters'
        ? 'Chapters'
        : 'No playlist or chapters.'
  const textLine = mode === 'filter' ? `/ filter: ${view.filter}_` : mode === 'open' ? `o open: ${typed}_` : filter ? `/ filter: ${filter}` : ' '
  const list = <List heading={heading} rows={rows} selected={selected} current={q.current} height={listHeight} width={listWidth} />

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>stream-radio</Text>
      {isWide ? (
        <Box flexDirection="row" height={listHeight + 1}>
          {list}
          <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} width={sideWidth}>
            <NowPlaying view={view} duration={duration} width={sideWidth - 2} />
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

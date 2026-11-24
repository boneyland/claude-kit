import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  fit,
  formatTime,
  holdTicks,
  marquee,
  nextRepeat,
  type Repeat,
  VOLUME_STEP,
  filterRows,
  playlistRows,
  type TreeRow,
  SCROLL_CHARS,
  SCROLL_MS,
  textWidth,
  titleColumns,
} from '../core/nowplaying'

import {
  NO_QUEUE,
  NO_RESUME,
  checkDefault,
  connect,
  isFollowing,
  detach,
  loadLast,
  loadRepeat,
  loadVolume,
  locate,
  pick,
  releaseLock,
  resumable,
  resume,
  setRepeat,
  setVolume,
  start,
  step,
  stopPlaying,
  stopPoller,
  togglePause,
  toggleShuffle,
} from '../core/player'
import type { Host, PlayerKeys, StateStore } from '../core/host'
import { migrateFromStore } from '../core/saved'
import { hostOf } from './host-claude'

// The panel reads these two through $.state for their versions.
const QUEUE = { plugin: 'stream-radio', key: 'queue' } as const
const OPEN_FOLDERS = { plugin: 'stream-radio', key: 'openFolders' } as const

// The player's state (core/host.ts PlayerKeys), one atom per key: the drawing
// reads them, the core changes them through the Host's store below.
// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)
const elapsed = atom({ plugin: 'stream-radio', key: 'elapsed' } as const, -1)
const chapter = atom({ plugin: 'stream-radio', key: 'chapter' } as const, '')
const lastUrl = atom({ plugin: 'stream-radio', key: 'lastUrl' } as const, '')
const queue = atom(QUEUE, NO_QUEUE)
const openFolders = atom(OPEN_FOLDERS, [] as string[])
const resumeAt = atom({ plugin: 'stream-radio', key: 'resumeAt' } as const, NO_RESUME)
const volumeLevel = atom({ plugin: 'stream-radio', key: 'volume' } as const, 60)
const repeatMode = atom({ plugin: 'stream-radio', key: 'repeat' } as const, 'all' as Repeat)
// The playing playlist's shuffle, off again when something new starts.
const isShuffled = atom({ plugin: 'stream-radio', key: 'isShuffled' } as const, false)
// What the panel's list is narrowed to, as typed; empty again when something
// new starts.
const listFilter = atom({ plugin: 'stream-radio', key: 'filter' } as const, '')

// The core's store on those atoms. Spelled out key by key: Claude Code's scan
// lists the state a mod reads and writes, so each read names its atom.
function storeOf($: EngineInterface): StateStore {
  const get = async (key: keyof PlayerKeys): Promise<unknown> => {
    switch (key) {
      case 'playing': return read($, playing)
      case 'isPaused': return read($, isPaused)
      case 'elapsed': return read($, elapsed)
      case 'chapter': return read($, chapter)
      case 'lastUrl': return read($, lastUrl)
      case 'queue': return read($, queue)
      case 'openFolders': return read($, openFolders)
      case 'resumeAt': return read($, resumeAt)
      case 'volume': return read($, volumeLevel)
      case 'repeat': return read($, repeatMode)
      case 'isShuffled': return read($, isShuffled)
      case 'filter': return read($, listFilter)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = async (key: keyof PlayerKeys, f: (prev: any) => any): Promise<unknown> => {
    switch (key) {
      case 'playing': return update($, playing, f)
      case 'isPaused': return update($, isPaused, f)
      case 'elapsed': return update($, elapsed, f)
      case 'chapter': return update($, chapter, f)
      case 'lastUrl': return update($, lastUrl, f)
      case 'queue': return update($, queue, f)
      case 'openFolders': return update($, openFolders, f)
      case 'resumeAt': return update($, resumeAt, f)
      case 'volume': return update($, volumeLevel, f)
      case 'repeat': return update($, repeatMode, f)
      case 'isShuffled': return update($, isShuffled, f)
      case 'filter': return update($, listFilter, f)
    }
  }
  return { read: key => get(key) as never, change: (key, fn) => set(key, fn) as never }
}

// How far a title too long for the footer has scrolled, in ticks; 0 at its start.
const scroll = atom({ plugin: 'stream-radio', key: 'scroll' } as const, 0)
// The panel's playlist rows, kept for the versions of the queue and the open
// folders they were built from: a redraw for anything else (pause, a reply,
// the panel's width) reuses them.
let rowsCache: { key: string; rows: TreeRow[] } | undefined
// The reply to the panel's last action; empty for none.
const notice = atom({ plugin: 'stream-radio', key: 'notice' } as const, '')
// The panel; also the footer button's target.
const PANE = 'stream-radio'
const TITLE = 'Radio'
type Options = {
  defaultUrl?: string
  volume?: number
  player?: string
  androidClient?: boolean
  toggleOnly?: boolean
  scrollChars?: number
  scrollMs?: number
}
// scrollChars: characters a long title moves each redraw, 0 for none (cut
// instead); scrollMs: the time between redraws.
type Config = { volume: number; player: string; androidClient: boolean; toggleOnly: boolean; scrollChars: number; scrollMs: number }
// Steps a long title along while something plays; undefined otherwise.
let scroller: Timer | undefined
// The footer label's fixed part and its title: the icon and time stay put,
// only the title scrolls.
async function labelParts($: EngineInterface) {
  const title = await read($, playing)
  const paused = await read($, isPaused)
  const done = await read($, elapsed)
  const part = await read($, chapter)
  // A file in a playlist shows how far along it is; a live stream has no end.
  const progress = done >= 0 ? formatTime(done) : ''
  const icon = paused ? `⏸ ${progress}`.trim() : progress || '♪'
  // A video of several songs names each in a chapter: the footer shows that
  // alone; the panel has the video title under it.
  const name = part || title
  return { prefix: `${icon} `, name, paused }
}

// Runs while a player runs; a tick moves the title only when it overflows and
// is not paused, so a short or paused title costs no redraws. None when
// scrolling is off.
function startScroller($: EngineInterface, config: Config) {
  scroller?.cancel()
  scroller = undefined
  if (config.scrollChars <= 0) return
  scroller = $.clock.every(config.scrollMs, () => {
    void (async () => {
      const { prefix, name, paused } = await labelParts($)
      if (paused || textWidth(name) <= titleColumns(prefix)) return
      await update($, scroll, n => n + 1)
    })().catch(() => undefined)
  })
}

function stopScroller() {
  scroller?.cancel()
  scroller = undefined
}
// Opens the panel, or closes it if it is up; the footer button and /stream panel.
async function togglePane($: EngineInterface): Promise<'opened' | 'closed'> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    return 'closed'
  }
  await $.ui.open({ id: PANE, title: TITLE })
  return 'opened'
}

const cut = fit


// The core's Host on a hook's $: a new title restarts the footer's scroll, and
// following a player runs the scroller.
function hostFor($: EngineInterface, config: Config): Host {
  return hostOf($, storeOf($), {
    titleChanged: () => update($, scroll, () => 0).then(() => undefined),
    watching: isOn => (isOn ? startScroller($, config) : stopScroller()),
  })
}

export const register: Register = (on, options) => {
  const {
    defaultUrl = '',
    volume = 60,
    player = 'mpv',
    androidClient = false,
    toggleOnly = false,
    scrollChars = SCROLL_CHARS,
    scrollMs = SCROLL_MS,
  } = options as Options
  const config: Config = {
    volume,
    player,
    androidClient,
    toggleOnly,
    // Whole characters, and no faster than a redraw every 100ms.
    scrollChars: Math.max(0, Math.min(20, Math.round(scrollChars))),
    scrollMs: Math.max(100, Math.min(10_000, Math.round(scrollMs))),
  }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    // Idle until the shared player (if one plays) says otherwise.
    await update($, playing, () => '')
    await update($, isPaused, () => false)
    await update($, elapsed, () => -1)
    await update($, chapter, () => '')
    await update($, scroll, () => 0)
    await update($, queue, () => NO_QUEUE)
    await update($, notice, () => '')
    // Before state.json, saved state was in the store: brought over once.
    await migrateFromStore(hostFor($, config), { get: key => $.store.get(key) })
    await loadLast(hostFor($, config))
    await loadVolume(hostFor($, config), config.volume)
    await loadRepeat(hostFor($, config))
    await checkDefault(hostFor($, config), defaultUrl)
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | last | pause | next | prev | vol N | shuffle | repeat | panel | stop]',
    })
    // A player another session started (or this one, before a reload) plays on:
    // follow it. In the background: a slow answer must not hold up the session.
    void connect(hostFor($, config), config).catch(() => undefined)

    return next(e)
  })

  // The player is everyone's: it plays on after this session ends.
  on('session.end', async ($, e, next) => {
    detach()
    stopPoller()
    stopScroller()
    await releaseLock(hostFor($, config))

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    // A throwing hook is skipped and /stream then says nothing useful: say why.
    try {
      const parsed = await locate(hostFor($, config), e.args, defaultUrl)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'stop') {
        await stopPlaying(hostFor($, config), config)

        return { text: 'Stopped.' }
      }
      if (parsed.kind === 'panel') return { text: `Radio panel ${await togglePane($)}.` }
      // A player another session started may not be followed yet (this session
      // just started): look before saying nothing plays.
      if (!isFollowing() && parsed.kind !== 'play' && parsed.kind !== 'last') await connect(hostFor($, config), config).catch(() => undefined)
      if (parsed.kind === 'shuffle') {
        if (!isFollowing()) return { text: 'Nothing is playing.' }
        return { text: await toggleShuffle(hostFor($, config)) }
      }
      if (parsed.kind === 'repeat') return { text: await setRepeat(hostFor($, config), parsed.mode ?? nextRepeat(await read($, repeatMode))) }
      if (parsed.kind === 'volume') {
        const now = await read($, volumeLevel)
        if (parsed.to === undefined && parsed.by === undefined) return { text: `Volume ${now}%.` }
        return { text: await setVolume(hostFor($, config), config.volume, parsed.to ?? now + (parsed.by ?? 0)) }
      }
      if (parsed.kind === 'next' || parsed.kind === 'prev') {
        if (!isFollowing()) return { text: 'Nothing is playing.' }
        return { text: (await step(hostFor($, config), parsed.kind === 'next' ? 1 : -1)) || (parsed.kind === 'next' ? 'Next.' : 'Previous.') }
      }
      if (parsed.kind === 'toggle') {
        if (!isFollowing()) return { text: 'Nothing is playing.' }
        if (!(await togglePause(hostFor($, config)))) return { text: 'The player is not ready yet.' }

        return { text: 'Toggled pause.' }
      }

      if (parsed.kind === 'last') {
        // What played last in this session; the default stream before anything has.
        const again = (await read($, lastUrl)) || defaultUrl
        if (!again) return { text: 'Nothing has played yet, and there is no default stream.' }
        const at = await read($, resumeAt)
        resume(hostFor($, config), config, again, at)
        const where = resumable(at, again)

        return { text: where ? `Resuming ${where}.` : `Starting ${again}.` }
      }

      start(hostFor($, config), config, parsed.url)

      return {
        text: `Starting ${parsed.url}. Click the footer title for the panel; /stream pause, next, prev or stop work too.`,
      }
    } catch (error) {
      return { text: `stream-radio failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // The track at the right of the prompt footer after the engine's own labels;
  // pressing it pauses and resumes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const title = await read($, playing)
    // The desktop app's footer is narrow: an icon alone, doing what the
    // terminal's button does (play last when idle; else open the panel, or
    // pause with toggleOnly). ♪ plays, ⏸ is paused.
    if (e.surface === 'desktop') {
      const again = (await read($, lastUrl)) || defaultUrl
      if (!title && !again) return next(e)
      const paused = await read($, isPaused)

      return (
        <Box flexDirection="row" gap={1}>
          {await next(e)}
          <Button
            key="stream-radio"
            label={!title ? '▶' : paused ? '⏸' : '♪'}
            onPress={async () =>
              !title
                ? resume(hostFor($, config), config, again, await read($, resumeAt))
                : config.toggleOnly
                  ? void togglePause(hostFor($, config))
                  : void togglePane($)
            }
          />
        </Box>
      )
    }
    if (!title) {
      // Idle: a button that plays again what played last, else the default
      // stream. It starts it directly: a plugin's own $.command.run never
      // reaches its own command.run hook.
      const again = (await read($, lastUrl)) || defaultUrl
      if (!again) return next(e)

      return (
        <Box flexDirection="row" gap={1}>
          {await next(e)}
          <Button
            key="stream-radio"
            label="▶ Play radio"
            onPress={async () => resume(hostFor($, config), config, again, await read($, resumeAt))}
          />
        </Box>
      )
    }
    // At most LABEL_COLUMNS cells: the icon and time fixed, a long title
    // scrolling through what is left.
    const { prefix, name } = await labelParts($)
    const shown = marquee(name, titleColumns(prefix), await read($, scroll), config.scrollChars, holdTicks(config.scrollMs))

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button
          key="stream-radio"
          label={`${prefix}${shown}`}
          onPress={() => (config.toggleOnly ? void togglePause(hostFor($, config)) : void togglePane($))}
        />
      </Box>
    )
  })

  // The panel: what plays, its controls, the playlist or chapters to pick from,
  // and a URL field. Each action's reply shows in it: a button has no reply line.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    // Every value read here redraws the whole panel when it changes, so it reads
    // none that change by the second: no time (the footer has it), and the
    // resume point, rewritten each second while playing, only while idle.
    const title = await read($, playing)
    const paused = await read($, isPaused)
    const part = await read($, chapter)
    const last = await read($, lastUrl)
    const queueRead = await $.state.get(QUEUE)
    const openRead = await $.state.get(OPEN_FOLDERS)
    const q = queueRead.value ?? NO_QUEUE
    const said = await read($, notice)
    const level = await read($, volumeLevel)
    const repeat = await read($, repeatMode)
    const shuffled = await read($, isShuffled)
    const filter = (await read($, listFilter)).trim()
    const rowsKey = `${queueRead.version}:${openRead.version}:${filter}`
    if (rowsCache?.key !== rowsKey) {
      rowsCache = {
        key: rowsKey,
        rows: filter
          ? filterRows(q.items, q.paths, q.root, filter)
          : playlistRows(q.items, q.paths, q.root, new Set(openRead.value ?? []), q.current),
      }
    }
    const rows = rowsCache.rows
    const act = async (work: () => Promise<string>) => {
      let reply: string
      try {
        reply = await work()
      } catch (error) {
        reply = `stream-radio failed: ${error instanceof Error ? error.message : String(error)}`
      }
      await update($, notice, () => reply)
    }
    const at = title ? NO_RESUME : await read($, resumeAt)
    const resumeLabel = last && !title ? resumable(at, last) : ''
    const play = (url: string) =>
      act(async () => {
        start(hostFor($, config), config, url)
        return ''
      })
    const state = [
      paused ? 'paused' : '',
      q.kind !== 'none' && q.current >= 0 ? `${q.current + 1} of ${q.items.length}` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        {title ? (
          <Box flexDirection="column">
            <Text bold>{cut(part || title, width)}</Text>
            {part ? <Text dimColor>{cut(title, width)}</Text> : null}
            {state.length > 0 ? <Text dimColor>{state.join(' · ')}</Text> : null}
            <Box flexDirection="row" gap={1}>
              {q.kind !== 'none' ? (
                <Button key="prev" label="⏮ Prev" onPress={() => act(() => step(hostFor($, config), -1))} />
              ) : null}
              <Button
                key="pause"
                label={paused ? '▶ Resume' : '⏸ Pause'}
                onPress={() => act(async () => ((await togglePause(hostFor($, config))) ? '' : 'The player is not ready yet.'))}
              />
              {q.kind !== 'none' ? (
                <Button key="next" label="Next ⏭" onPress={() => act(() => step(hostFor($, config), 1))} />
              ) : null}
              <Button key="stop" label="⏹ Stop" onPress={() => act(async () => (await stopPlaying(hostFor($, config), config), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="vol-down" label="🔉 −" onPress={() => act(async () => (await setVolume(hostFor($, config), config.volume, level - VOLUME_STEP), ''))} />
              <Text>{`Volume ${level}%`}</Text>
              <Button key="vol-up" label="🔊 +" onPress={() => act(async () => (await setVolume(hostFor($, config), config.volume, level + VOLUME_STEP), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              {q.kind === 'playlist' ? (
                <Button key="shuffle" label={shuffled ? '🔀 Shuffle: on' : '🔀 Shuffle: off'} onPress={() => act(() => toggleShuffle(hostFor($, config)))} />
              ) : null}
              <Button
                key="repeat"
                label={repeat === 'all' ? '🔁 Repeat: all' : repeat === 'one' ? '🔂 Repeat: one' : '🔁 Repeat: off'}
                onPress={() => act(() => setRepeat(hostFor($, config), nextRepeat(repeat)))}
              />
            </Box>
          </Box>
        ) : (
          <Text dimColor>Nothing playing.</Text>
        )}
        {/* Play last (or Resume) only while idle: playing, it is what plays. */}
        {(last && !title) || (defaultUrl && defaultUrl !== last) ? (
          <Box flexDirection="row" gap={1}>
            {last && !title ? (
              <Button
                key="play-last"
                label={resumeLabel ? cut(`▶ Resume ${resumeLabel}`, width) : 'Play last'}
                onPress={() =>
                  act(async () => {
                    resume(hostFor($, config), config, last, at)
                    return ''
                  })
                }
              />
            ) : null}
            {defaultUrl && defaultUrl !== last ? (
              <Button key="play-default" label="Play default" onPress={() => play(defaultUrl)} />
            ) : null}
          </Box>
        ) : null}
        <Input
          key="url"
          placeholder="URL, or a file or folder path"
          submitLabel="Enter to play"
          onSubmit={(value: string) => {
            return act(async () => {
              const parsed = await locate(hostFor($, config), value.trim(), '')
              if (parsed.kind === 'play') {
                start(hostFor($, config), config, parsed.url)
                return ''
              }
              return parsed.kind === 'error' ? parsed.text : 'Type a URL or a path to a file or folder.'
            })
          }}
        />
        {said !== '' && <Text dimColor>{said}</Text>}
        {q.kind !== 'none' ? (
          <Box flexDirection="column">
            <Text dimColor>
              {filter
                ? `${rows.length} of ${q.items.length} ${q.kind === 'playlist' ? 'songs' : 'chapters'} match`
                : q.kind === 'playlist'
                  ? 'Playlist'
                  : 'Chapters'}
            </Text>
            {q.items.length > 1 ? (
              <Input
                key="filter"
                placeholder={q.kind === 'playlist' ? 'Filter songs' : 'Filter chapters'}
                submitLabel="Enter plays the first"
                onInput={(value: string) => void update($, listFilter, () => value)}
                onSubmit={() => {
                  const first = rows.find(r => r.kind === 'item')
                  return first?.kind === 'item' ? act(() => pick(hostFor($, config), first.index)) : act(async () => 'Nothing matches.')
                }}
              />
            ) : null}
            {rows.map(row => {
              const indent = '  '.repeat(row.depth)
              if (row.kind === 'folder') {
                // Shut with the current song inside: the mark moves to the folder.
                const mark = row.hasCurrent && !row.isOpen ? '▶' : ' '
                return (
                  <Button
                    key={`folder-${row.path}`}
                    plain
                    dimColor={!(row.hasCurrent && !row.isOpen)}
                    label={cut(`${mark} ${indent}${row.isOpen ? '▾' : '▸'} 📁 ${row.name}/ · ${row.count}`, width)}
                    onPress={() =>
                      update($, openFolders, list =>
                        list.includes(row.path) ? list.filter(p => p !== row.path) : [...list, row.path],
                      )
                    }
                  />
                )
              }
              const i = row.index
              return (
                <Button
                  key={`item-${i}`}
                  plain
                  dimColor={i !== q.current}
                  label={cut(`${i === q.current ? '▶' : ' '} ${indent}${row.number}. ${row.name}${row.where ? ` · ${row.where}` : ''}`, width)}
                  onPress={() => act(() => pick(hostFor($, config), i))}
                />
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}

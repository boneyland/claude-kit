import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  fit,
  formatTime,
  holdTicks,
  marquee,
  nextRepeat,
  type Repeat,
  stepVolume,
  filterRows,
  queueRows,
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
  migrateLast,
  loadRepeat,
  loadVolume,
  locate,
  pick,
  playEntries,
  playQueue,
  playSource,
  refreshFromStored,
  releaseLock,
  resumable,
  resumeQueue,
  setRepeat,
  setVolume,
  step,
  stopPlaying,
  stopPoller,
  seek,
  togglePause,
  toggleShuffle,
} from '../core/player'
import { addTo, historyText, planList, playingSong, removeFrom, toggleFavourite } from '../core/library-actions'
import { readHistory } from '../core/libraryFile'
import type { Host, PlayerKeys, StateStore } from '../core/host'
import { migrateFromStore } from '../core/saved'
import { hostOf } from './host-claude'
import { libraryParts, resetLibrary, stopLibraryPoll } from './libraryPanel'

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
// How far the panel's ⏪ and ⏩ jump.
const SEEK_SECONDS = 10
const volumeLevel = atom({ plugin: 'stream-radio', key: 'volume' } as const, 60)
const repeatMode = atom({ plugin: 'stream-radio', key: 'repeat' } as const, 'all' as Repeat)
// The playing queue's shuffle, off again when something new starts.
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
// The panel's queue rows, kept for the versions of the queue and the open
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
  // A file in the queue shows how far along it is; a live stream has no end.
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
  // the list shown starts at the queue each time
  await resetLibrary($)
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

// To `seconds` into the playing file, or that far from where it is; '' when done.
async function seekBy($: EngineInterface, config: Config, seconds: number, isRelative?: boolean): Promise<string> {
  return seek(hostFor($, config), seconds, isRelative)
}

// The footer's ▶: the queue from the start of its place's song (Play after
// Stop starts it from 0:00; `l` resumes), else the default stream. A button has
// no reply line, so what it says is a toast. Not waited on by the press.
async function playButton($: EngineInterface, config: Config, defaultUrl: string) {
  const h = hostFor($, config)
  try {
    const said = await playQueue(h, config, defaultUrl)
    if (said) h.toast(said)
  } catch (error) {
    h.toast(failedText(error))
  }
}

// A start not waited on has no reply line: why it failed is a toast.
function failedText(error: unknown): string {
  return `stream-radio failed: ${error instanceof Error ? error.message : String(error)}`
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
    await update($, notice, () => '')
    // Before state.json, saved state was in the store: brought over once.
    await migrateFromStore(hostFor($, config), { get: key => $.store.get(key) })
    // An earlier version's last URL becomes the queue, shown before anything
    // plays. In the background: it can list a big folder, and a slow hook holds
    // up the session.
    const h = hostFor($, config)
    void migrateLast(h)
      .then(() => refreshFromStored(h))
      .catch(error => h.log(`stream-radio: could not read the queue: ${error instanceof Error ? error.message : String(error)}`, 'debug'))
    await loadVolume(hostFor($, config), config.volume)
    await loadRepeat(hostFor($, config))
    await checkDefault(hostFor($, config), defaultUrl)
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | last | pause | next | prev | vol N | seek m:ss | shuffle | repeat | panel | stop]',
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
    stopLibraryPoll()
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
      if (parsed.kind === 'fav' || parsed.kind === 'listAdd' || parsed.kind === 'listRemove') {
        const h = hostFor($, config)
        const song = await playingSong(h)
        if (!song) return { text: 'Nothing playing.' }
        return { text: parsed.kind === 'fav' ? await toggleFavourite(h, [song]) : parsed.kind === 'listAdd' ? await addTo(h, parsed.list, [song]) : await removeFrom(h, parsed.list, [song]) }
      }
      if (parsed.kind === 'history') {
        const h = hostFor($, config)
        return { text: historyText(await readHistory(h), Math.floor((await h.now()) / 1000)) }
      }
      if (parsed.kind === 'playList') {
        const h = hostFor($, config)
        const plan = await planList(h, parsed.list)
        if (typeof plan === 'string') return { text: plan }
        void playEntries(h, config, plan.entries, plan.source, 0).then(note => note && h.toast(note), error => h.toast(failedText(error)))
        return { text: `Playing ${plan.name}.` }
      }
      // A player another session started may not be followed yet (this session
      // just started): look before saying nothing plays.
      if (!isFollowing() && parsed.kind !== 'play' && parsed.kind !== 'last') await connect(hostFor($, config), config).catch(() => undefined)
      // The queue's own, playing or not.
      if (parsed.kind === 'shuffle') {
        return { text: await toggleShuffle(hostFor($, config)) }
      }
      if (parsed.kind === 'repeat') return { text: await setRepeat(hostFor($, config), parsed.mode ?? nextRepeat(await read($, repeatMode))) }
      if (parsed.kind === 'volume') {
        const now = await read($, volumeLevel)
        if (parsed.to === undefined && parsed.step === undefined) return { text: `Volume ${now}%.` }
        return { text: await setVolume(hostFor($, config), config.volume, parsed.to ?? stepVolume(now, parsed.step ?? 1)) }
      }
      if (parsed.kind === 'seek') {
        if (!isFollowing()) return { text: 'Nothing is playing.' }
        const said = await seekBy($, config, parsed.seconds, parsed.isRelative)

        return { text: said || `At ${formatTime(await read($, elapsed))}.` }
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
        // The queue where it got to; the default stream before anything has
        // played, not waited on (it may be listed by yt-dlp): its note a toast.
        const h = hostFor($, config)
        const said = await resumeQueue(h, config, defaultUrl, work => void work.then(note => note && h.toast(note), error => h.toast(failedText(error))))
        if (said) return { text: said }
        const again = await read($, lastUrl)
        const where = resumable(await read($, resumeAt), again)

        return { text: where ? `Resuming ${where}.` : `Starting ${again}.` }
      }

      // Every other kind is answered above; this narrows the type to a URL or path.
      if (parsed.kind !== 'play') return { text: 'Nothing to play.' }

      // In the background, as a start always was: a hook that takes long is
      // reported as unanswered. What the expansion says shows as a toast.
      const h = hostFor($, config)
      void playSource(h, config, parsed.url).then(note => note && h.toast(note), error => h.toast(failedText(error)))

      return {
        text: `Starting ${parsed.url}. Click the footer title for the panel; /stream pause, next, prev or stop work too.`,
      }
    } catch (error) {
      return { text: `stream-radio failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // The panel closed, by the person or here: its lists are no longer looked at.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    await resetLibrary($).catch(() => undefined)
    return done
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
                ? void playButton($, config, defaultUrl)
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
            onPress={() => void playButton($, config, defaultUrl)}
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

  // The panel: what plays, its controls, the queue or chapters to pick from,
  // and a URL field. Each action's reply shows in it: a button has no reply line.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui
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
          : queueRows(q.items, q.paths, q.root, new Set(openRead.value ?? []), q.current),
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
    // A play not waited on (its expansion may run yt-dlp or curl, and a hook
    // must not wait on that): what it says shows in the panel when it does.
    const later = (work: Promise<string>) =>
      void work
        .then(
          reply => reply && update($, notice, () => reply),
          error => update($, notice, () => `stream-radio failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        .catch(() => undefined)
    const play = (url: string) => act(async () => (later(playSource(hostFor($, config), config, url)), ''))
    const library = await libraryParts($, ui, {
      host: () => hostFor($, config),
      pane: PANE,
      hasQueue: q.kind !== 'none',
      title,
      width,
      act,
      later,
      playEntries: (h, entries, source, start) => playEntries(h, config, entries, source, start),
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
                <Button key="prev" label="⏮ Prev (p)" hotkey="p" onPress={() => act(() => step(hostFor($, config), -1))} />
              ) : null}
              <Button
                key="pause"
                label={paused ? '▶ Resume (k)' : '⏸ Pause (k)'}
                hotkey="k"
                onPress={() => act(async () => ((await togglePause(hostFor($, config))) ? '' : 'The player is not ready yet.'))}
              />
              {q.kind !== 'none' ? (
                <Button key="next" label="(n) Next ⏭" hotkey="n" onPress={() => act(() => step(hostFor($, config), 1))} />
              ) : null}
              <Button key="stop" label="⏹ Stop (x)" hotkey="x" onPress={() => act(async () => (await stopPlaying(hostFor($, config), config), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="seek-back" label="⏪ 10s (b)" hotkey="b" onPress={() => act(() => seekBy($, config, -SEEK_SECONDS, true))} />
              <Button key="seek-ahead" label="(f) 10s ⏩" hotkey="f" onPress={() => act(() => seekBy($, config, SEEK_SECONDS, true))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="vol-down" label="🔉 − (9)" hotkey="9" onPress={() => act(async () => (await setVolume(hostFor($, config), config.volume, stepVolume(level, -1)), ''))} />
              <Text>{`Volume ${level}%`}</Text>
              <Button key="vol-up" label="(0) 🔊 +" hotkey="0" onPress={() => act(async () => (await setVolume(hostFor($, config), config.volume, stepVolume(level, 1)), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              {q.kind === 'playlist' ? (
                <Button key="shuffle" label={shuffled ? '🔀 Shuffle: on (s)' : '🔀 Shuffle: off (s)'} hotkey="s" onPress={() => act(() => toggleShuffle(hostFor($, config)))} />
              ) : null}
              <Button
                key="repeat"
                label={`${repeat === 'all' ? '🔁 Repeat: all' : repeat === 'one' ? '🔂 Repeat: one' : '🔁 Repeat: off'} (r)`}
                hotkey="r"
                onPress={() => act(() => setRepeat(hostFor($, config), nextRepeat(repeat)))}
              />
            </Box>
          </Box>
        ) : (
          <Text dimColor>Nothing playing.</Text>
        )}
        {/* Outside the playing-only block: stopped, they act on the queue's song. */}
        {library.controls}
        {/* Play last (or Resume) only while idle: playing, it is what plays. */}
        {(last && !title) || (defaultUrl && defaultUrl !== last) ? (
          <Box flexDirection="row" gap={1}>
            {last && !title ? (
              <Button
                key="play-last"
                label={resumeLabel ? `${cut(`▶ Resume ${resumeLabel}`, width - 4)} (l)` : 'Play last (l)'}
                hotkey="l"
                onPress={() =>
                  act(() => resumeQueue(hostFor($, config), config, defaultUrl, later))
                }
              />
            ) : null}
            {defaultUrl && defaultUrl !== last ? (
              <Button key="play-default" label="Play default (d)" hotkey="d" onPress={() => play(defaultUrl)} />
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
              if (parsed.kind === 'play') return (later(playSource(hostFor($, config), config, parsed.url)), '')
              return parsed.kind === 'error' ? parsed.text : 'Type a URL or a path to a file or folder.'
            })
          }}
        />
        {said !== '' && <Text dimColor>{said}</Text>}
        {library.picker}
        {library.list ?? null}
        {library.list === undefined && q.kind !== 'none' ? (
          <Box flexDirection="column">
            <Text dimColor>
              {filter
                ? `${rows.length} of ${q.items.length} ${q.kind === 'playlist' ? 'songs' : 'chapters'} match`
                : q.kind === 'playlist'
                  ? 'Queue'
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
                  return first?.kind === 'item' ? act(() => pick(hostFor($, config), config, first.index)) : act(async () => 'Nothing matches.')
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
                  onPress={() => act(() => pick(hostFor($, config), config, i))}
                />
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}

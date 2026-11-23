import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Queue, Resume } from '../types'

import {
  fit,
  formatTime,
  holdTicks,
  marquee,
  baseName,
  clampVolume,
  loopsFor,
  nextRepeat,
  type Repeat,
  VOLUME_STEP,
  filterRows,
  foldersOf,
  playlistRows,
  type TreeRow,
  metaValue,
  parseArgs,
  type PlayerEvent,
  repeatOf,
  SCROLL_CHARS,
  SCROLL_MS,
  splitEvents,
  textWidth,
  titleColumns,
  trackTitle,
  WATCHED,
} from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)
// How far into the current file, in seconds; -1 for a live stream.
const elapsed = atom({ plugin: 'stream-radio', key: 'elapsed' } as const, -1)
// The current chapter's title (often the song in a multi-song video); empty when none.
const chapter = atom({ plugin: 'stream-radio', key: 'chapter' } as const, '')
// The last URL that actually played: what the idle button plays again. Kept in
// $.store too, so it outlives the session (see saveLast).
const lastUrl = atom({ plugin: 'stream-radio', key: 'lastUrl' } as const, '')
// The default stream the last load saw: when it changes, the new default wins
// over the remembered URL.
const knownDefault = atom({ plugin: 'stream-radio', key: 'knownDefault' } as const, '')
// How far a title too long for the footer has scrolled, in ticks; 0 at its start.
const scroll = atom({ plugin: 'stream-radio', key: 'scroll' } as const, 0)

// What the panel lists to pick from.
// (Queue: see the type contract.)
const NO_QUEUE: Queue = { kind: 'none', items: [], current: -1, paths: [], root: '' }
const QUEUE = { plugin: 'stream-radio', key: 'queue' } as const
const queue = atom(QUEUE, NO_QUEUE)
// The folders the panel's playlist shows open; the current song's open by
// themselves when it changes.
const OPEN_FOLDERS = { plugin: 'stream-radio', key: 'openFolders' } as const
const openFolders = atom(OPEN_FOLDERS, [] as string[])

// The panel's playlist rows, kept for the versions of the queue and the open
// folders they were built from: a redraw for anything else (pause, a reply,
// the panel's width) reuses them.
let rowsCache: { key: string; rows: TreeRow[] } | undefined
// The reply to the panel's last action; empty for none.
const notice = atom({ plugin: 'stream-radio', key: 'notice' } as const, '')

// Where the last URL got to: its playlist entry (-1 when it has no playlist) and
// the seconds into it (-1 for a live stream), with the song's title, so playing
// the last URL again after a stop resumes there.
const NO_RESUME: Resume = { url: '', index: -1, seconds: -1, title: '' }
const resumeAt = atom({ plugin: 'stream-radio', key: 'resumeAt' } as const, NO_RESUME)
// The last URL, where it got to and the default it went with, kept in $.store so
// a new session's Play radio resumes there too. The point moves every second;
// the store is written at most every SAVE_MS, and at once when the song
// changes or playback stops.
// The volume as last set, the player's from the start; kept in $.store with the
// Volume setting it began from, so a changed setting wins again.
const volumeLevel = atom({ plugin: 'stream-radio', key: 'volume' } as const, 60)
const VOLUME_KEY = 'volume'
type SavedVolume = { value: number; configured: number }

async function loadVolume($: EngineInterface, configured: number) {
  const saved = (await $.store.get(VOLUME_KEY).catch(() => undefined)) as Partial<SavedVolume> | undefined
  const value = saved && saved.configured === configured && typeof saved.value === 'number' ? saved.value : configured
  await update($, volumeLevel, () => clampVolume(value))
}

// Sets the volume, of the playing player too; resolves to the reply to show.
async function setVolume($: EngineInterface, configured: number, level: number): Promise<string> {
  const to = clampVolume(level)
  await update($, volumeLevel, () => to)
  await $.store.set(VOLUME_KEY, { value: to, configured } satisfies SavedVolume).catch(() => undefined)
  if (control && !(await mpv($, ['set_property', 'volume', to]))) return `Volume ${to}%; the player is not ready yet.`
  return `Volume ${to}%.`
}

// Repeat: kept in $.store as a preference. Shuffle: the playing playlist's,
// off again when something new starts.
const repeatMode = atom({ plugin: 'stream-radio', key: 'repeat' } as const, 'all' as Repeat)
const isShuffled = atom({ plugin: 'stream-radio', key: 'isShuffled' } as const, false)
// What the panel's list is narrowed to, as typed; empty again when something
// new starts.
const listFilter = atom({ plugin: 'stream-radio', key: 'filter' } as const, '')
const REPEAT_KEY = 'repeat'

async function loadRepeat($: EngineInterface) {
  const saved = await $.store.get(REPEAT_KEY).catch(() => undefined)
  if (saved === 'all' || saved === 'one' || saved === 'off') await update($, repeatMode, () => saved)
}

// Sets repeat, of the playing player too; resolves to the reply to show.
async function setRepeat($: EngineInterface, mode: Repeat): Promise<string> {
  await update($, repeatMode, () => mode)
  await $.store.set(REPEAT_KEY, mode).catch(() => undefined)
  const loops = loopsFor(mode)
  if (control) {
    await mpv($, ['set_property', 'loop-file', loops.file])
    await mpv($, ['set_property', 'loop-playlist', loops.playlist])
  }
  return mode === 'all' ? 'Repeat: the whole playlist.' : mode === 'one' ? 'Repeat: this song.' : 'Repeat off: playback ends after the last song.'
}

// Shuffles the playing playlist, or puts it back in order; mpv keeps the song
// playing where it is. The list is read again, as its order changed; the mark
// on the player tells the other sessions to read it again too.
async function toggleShuffle($: EngineInterface): Promise<string> {
  if ((await read($, queue)).kind !== 'playlist') return 'Nothing to shuffle: this is not a playlist.'
  const on = !(await read($, isShuffled))
  if (!(await mpv($, [on ? 'playlist-shuffle' : 'playlist-unshuffle']))) return 'The player is not ready yet.'
  await update($, isShuffled, () => on)
  await mpv($, ['set_property', 'user-data/stream-radio/shuffled', on])
  await refreshQueue($, { isReordered: true })
  return on ? 'Shuffled.' : 'Back in order.'
}

const STORE_KEY = 'last'
const SAVE_MS = 10_000
type Saved = { url: string; resumeAt: Resume; knownDefault: string }
let savedAt = 0

async function saveLast($: EngineInterface, isNow = false) {
  const now = await $.clock.now().catch(() => 0)
  if (!isNow && now - savedAt < SAVE_MS) return
  savedAt = now
  const saved: Saved = { url: await read($, lastUrl), resumeAt: await read($, resumeAt), knownDefault: await read($, knownDefault) }
  await $.store.set(STORE_KEY, saved).catch(() => undefined)
}

// What an earlier session saved, when this one has nothing of its own yet.
async function loadLast($: EngineInterface) {
  if (await read($, lastUrl)) return
  const saved = (await $.store.get(STORE_KEY).catch(() => undefined)) as Partial<Saved> | undefined
  if (!saved || typeof saved.url !== 'string' || !saved.url) return
  const url = saved.url
  await update($, lastUrl, () => url)
  if (typeof saved.knownDefault === 'string') {
    const known = saved.knownDefault
    await update($, knownDefault, () => known)
  }
  const at = saved.resumeAt
  if (at && at.url === url && typeof at.index === 'number' && typeof at.seconds === 'number') {
    await update($, resumeAt, () => ({ url, index: at.index, seconds: at.seconds, title: typeof at.title === 'string' ? at.title : '' }))
  }
}

// Closer to a song's start than this, it resumes at the start.
const RESUME_MIN_SECONDS = 5

// Talks to mpv's IPC socket: one command, or --watch to follow properties.
const IPC = 'hooks/mpv-ipc.py'

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

// ONE player for every session. mpv runs detached from all of them (setsid),
// listening on one socket in the plugin's data folder, and keeps playing until
// someone stops it. Next to it in that folder:
// - player.json, what was last asked of the player (Intent): every session
//   reads it when the player goes away, to tell a stop or a new start from a
//   drop worth reconnecting;
// - reconnect.lock, held by the one session that reconnects after a drop;
// - mpv.log, the player's errors, for saying why something would not play.
type Paths = { sock: string; intent: string; lock: string; log: string }
let dataDir: string | undefined

async function paths($: EngineInterface): Promise<Paths> {
  dataDir ??= (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
  return { sock: `${dataDir}/mpv.sock`, intent: `${dataDir}/player.json`, lock: `${dataDir}/reconnect.lock`, log: `${dataDir}/mpv.log` }
}

// id: one per start; isStopped: someone pressed stop; attempt: reconnect tries
// before this start; playedAt: when it first played (0 until it has).
type Intent = { id: string; url: string; client: string; isStopped: boolean; attempt: number; playedAt: number }

async function readIntent($: EngineInterface): Promise<Intent | undefined> {
  try {
    const value = JSON.parse(await $.fs.read((await paths($)).intent)) as Partial<Intent>
    if (typeof value.id !== 'string') return undefined
    return {
      id: value.id,
      url: typeof value.url === 'string' ? value.url : '',
      client: typeof value.client === 'string' ? value.client : '',
      isStopped: value.isStopped === true,
      attempt: typeof value.attempt === 'number' ? value.attempt : 0,
      playedAt: typeof value.playedAt === 'number' ? value.playedAt : 0,
    }
  } catch {
    return undefined
  }
}

async function writeIntent($: EngineInterface, intent: Intent) {
  await $.fs.write((await paths($)).intent, JSON.stringify(intent)).catch(() => undefined)
}

// Runs one mpv command on `socket`; resolves to its reply's data, or undefined
// when nothing listens or mpv refused.
async function ipc($: EngineInterface, socket: string, command: readonly unknown[]): Promise<{ data: unknown } | undefined> {
  const result = await $.process
    .run(['python3', '-I', `${$.plugin.root}/${IPC}`, socket, JSON.stringify(command)], { timeoutMs: 3000 })
    .catch(() => undefined)
  if (result?.exitCode !== 0) return undefined
  try {
    return { data: JSON.parse(result.stdout || 'null') as unknown }
  } catch {
    return { data: null }
  }
}

// The command on the player this session follows; undefined while it follows none.
async function mpv($: EngineInterface, command: readonly unknown[]) {
  return control ? ipc($, control, command) : undefined
}

// The live player's pid; undefined when none answers on the socket.
async function probe($: EngineInterface): Promise<number | undefined> {
  const reply = await ipc($, (await paths($)).sock, ['get_property', 'pid'])
  return typeof reply?.data === 'number' ? reply.data : undefined
}

// The socket of the player this session follows; undefined while it follows none.
let control: string | undefined
// The running watcher, and its generation: a newer one (or none) makes an older
// one's end mean nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let watcher: { return: (value: any) => Promise<unknown> } | undefined
let watchRun = 0
// This session's starts; a newer one (or a stop) cancels an older one's steps.
let run = 0
let isStarting = false
// What this session started and waits to hear has played: on a player that
// ends before that, this session says why (or retries with the android client).
let launch: Launch | undefined
// Where to jump once what this session started has loaded (its resume point).
let pending: Resume | undefined
// Whether this session holds reconnect.lock.
let holdsLock = false
// Steps a long title along while something plays; undefined otherwise.
let scroller: Timer | undefined
// Looks for a player another session started, while this one follows none.
let poller: Timer | undefined
let isPolling = false
// The socket file's time when no player answered on it: not asked again until
// a new player makes a new one.
let staleMtime = -1

// What the watcher has told of the player this session follows.
type Seen = {
  media: unknown
  meta: unknown
  hasEnd: boolean
  count: number
  pos: number
  chapter: number
  loopFile: unknown
  loopPlaylist: unknown
  isLoaded: boolean
  url: string
  endReason: string
  error: string
}
const fresh = (): Seen => ({
  media: undefined,
  meta: undefined,
  hasEnd: false,
  count: 0,
  pos: -1,
  chapter: -1,
  loopFile: undefined,
  loopPlaylist: undefined,
  isLoaded: false,
  url: '',
  endReason: '',
  error: '',
})
let seen = fresh()

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

// Back to showing nothing playing.
async function goIdle($: EngineInterface) {
  stopScroller()
  await update($, playing, () => '')
  await update($, isPaused, () => false)
  await update($, elapsed, () => -1)
  await update($, chapter, () => '')
  await update($, queue, () => NO_QUEUE)
}

// While this session follows no player, a look every POLL_MS at the socket file
// (no process: a stat) finds one another session started.
const POLL_MS = 3000

function startPoller($: EngineInterface, config: Config) {
  if (poller) return
  poller = $.clock.every(POLL_MS, () => {
    if (control || isStarting || isPolling) return
    isPolling = true
    void (async () => {
      const p = await paths($)
      const stat = await $.fs.stat(p.sock).catch(() => undefined)
      if (!stat || stat.mtimeMs === staleMtime || control || isStarting) return
      if (await probe($)) {
        if (!control && !isStarting) attach($, config, p.sock, (await readIntent($))?.id ?? '')
      } else {
        staleMtime = stat.mtimeMs
      }
    })()
      .catch(() => undefined)
      .finally(() => (isPolling = false))
  })
}

function stopPoller() {
  poller?.cancel()
  poller = undefined
}

// Stops following the player (it plays on).
function detach() {
  watchRun += 1
  const old = watcher
  watcher = undefined
  control = undefined
  void old?.return(undefined).catch(() => undefined)
}

// Follows the live player on the socket: a watcher streams its changes into
// this session's footer and panel until it goes away. `id`: the Intent it was
// started under, to tell later whether it was replaced.
function attach($: EngineInterface, config: Config, sock: string, id: string) {
  detach()
  const mine = watchRun
  control = sock
  stopPoller()
  seen = fresh()
  startScroller($, config)
  void (async () => {
    let rest = ''
    try {
      const stream = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/${IPC}`, sock, '--watch', JSON.stringify(WATCHED)] })
      if (mine !== watchRun) return void stream.return(undefined as never).catch(() => undefined)
      watcher = stream
      for await (const { stream: from, text } of stream) {
        if (mine !== watchRun) return
        if (from === 'stderr') continue
        const split = splitEvents(rest + text)
        rest = split.rest
        for (const event of split.events) {
          if (mine !== watchRun) return
          await onEvent($, event)
        }
      }
    } catch {
      // the watcher could not start or was ended: the player is gone or not ours
    }
    if (mine !== watchRun) return
    watcher = undefined
    control = undefined
    await onGone($, config, id)
  })().catch(error => $.ui.log(`stream-radio: watcher failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
}

// One change of the player, as every session following it sees it.
async function onEvent($: EngineInterface, event: PlayerEvent) {
  if (event.event === 'end-file') {
    seen.endReason = event.reason ?? ''
    if (event.file_error) seen.error = event.file_error
    return
  }
  if (event.event !== 'property-change') {
    if (event.event === 'file-loaded') {
      await markLoaded($)
      await onLoaded($)
    }
    return
  }
  const { name, data } = event
  switch (name) {
    case 'media-title':
    case 'metadata': {
      if (name === 'media-title') seen.media = data
      else seen.meta = data
      const title = trackTitle(seen.media, seen.meta)
      if (title && title !== (await read($, playing))) {
        await update($, scroll, () => 0)
        await update($, playing, () => title)
      }
      return
    }
    case 'pause':
      if (typeof data === 'boolean') await update($, isPaused, () => data)
      return
    case 'duration':
      seen.hasEnd = data === true
      return
    case 'time-pos': {
      if (typeof data !== 'number') return
      // The file loaded before the watcher began (a local file loads at once,
      // and a player another session started plays already): no file-loaded
      // comes for it, so its position is the sign.
      if (!seen.isLoaded) {
        await markLoaded($)
        await onLoaded($)
      }
      const pos = seen.hasEnd ? data : -1
      if (pos !== (await read($, elapsed))) await update($, elapsed, () => pos)
      await recordPosition($, pos)
      return
    }
    case 'chapter-metadata': {
      const part = metaValue(data, 'title')
      if (part !== (await read($, chapter))) {
        await update($, scroll, () => 0)
        await update($, chapter, () => part)
      }
      return
    }
    case 'chapter':
      seen.chapter = typeof data === 'number' ? data : -1
      if ((await read($, queue)).kind === 'chapters') await refreshQueue($)
      return
    case 'playlist-pos':
    case 'playlist-count':
      if (name === 'playlist-pos') seen.pos = typeof data === 'number' ? data : -1
      else seen.count = typeof data === 'number' ? data : 0
      if (seen.isLoaded) await refreshQueue($)
      return
    case 'volume':
      // The player's own volume wins over what this session last knew.
      if (typeof data === 'number') await update($, volumeLevel, () => clampVolume(data))
      return
    case 'loop-file':
    case 'loop-playlist': {
      if (name === 'loop-file') seen.loopFile = data
      else seen.loopPlaylist = data
      if (seen.loopFile !== undefined && seen.loopPlaylist !== undefined) {
        const mode = repeatOf(seen.loopFile, seen.loopPlaylist)
        await update($, repeatMode, () => mode)
      }
      return
    }
    case 'user-data/stream-radio/url':
      seen.url = typeof data === 'string' ? data : ''
      if (seen.isLoaded) await markLoaded($)
      return
    case 'user-data/stream-radio/shuffled': {
      const on = data === true
      if (on !== (await read($, isShuffled))) {
        await update($, isShuffled, () => on)
        if (seen.isLoaded) await refreshQueue($, { isReordered: true })
      }
      return
    }
  }
}

// The player plays: what it plays becomes the URL played last, here too.
async function markLoaded($: EngineInterface) {
  seen.isLoaded = true
  const url = seen.url
  if (url && url !== (await read($, lastUrl))) await update($, lastUrl, () => url)
}

// A file loaded: the list (or the file's chapters) read again; for what this
// session started, the first load means it really plays.
async function onLoaded($: EngineInterface) {
  await refreshQueue($, { isNewFile: true }).catch(() => undefined)
  const intent = await readIntent($)
  if (launch && intent?.id === launch.id && !intent.playedAt) {
    const now = await $.clock.now().catch(() => 0)
    await writeIntent($, { ...intent, playedAt: now || 1 })
    if (launch.client) needsAndroid.add(launch.url)
    await saveLast($, true)
    await releaseLock($)
  }
  if (!pending) return
  const q = await read($, queue)
  if (q.kind === 'playlist' && pending.index >= 0 && pending.index < q.items.length && q.current !== pending.index) {
    // The jump loads another file; its file-loaded comes back through here.
    if (!(await mpv($, ['playlist-play-index', pending.index]))) pending = undefined
  } else {
    if (pending.seconds >= RESUME_MIN_SECONDS) await mpv($, ['seek', pending.seconds, 'absolute'])
    pending = undefined
  }
}

// Where the playing URL got to, for resuming it later; not while a resume
// point is still being reached, or the first song's start would overwrite it.
async function recordPosition($: EngineInterface, pos: number) {
  const url = await read($, lastUrl)
  const title = (await read($, chapter)) || (await read($, playing))
  if (pending || !url || !title || title === 'connecting…') return
  const q = await read($, queue)
  const index = q.kind === 'playlist' ? q.current : -1
  const was = await read($, resumeAt)
  if (was.url === url && was.index === index && was.seconds === pos && was.title === title) return
  await update($, resumeAt, () => ({ url, index, seconds: pos, title }))
  await saveLast($, was.url !== url || was.index !== index || was.title !== title)
}

// The player this session followed went away. Stopped, replaced by a new start
// or ended on purpose: nothing more. Never played, and this session started
// it: say why. Dropped after playing: one session (whichever takes the lock)
// starts it again.
async function onGone($: EngineInterface, config: Config, id: string) {
  const was = seen
  await saveLast($, true)
  await goIdle($)
  startPoller($, config)
  // The watcher ended but the player answers: the watcher was killed (as at
  // this session's exit), not the player. The poller follows it again.
  if (await probe($)) return
  const intent = await readIntent($)
  const mine = launch && launch.id === id ? launch : undefined
  if (!intent || intent.isStopped || intent.id !== id) return
  if (!was.isLoaded) {
    if (mine) await failed($, config, mine, was.error)
    return
  }
  if (was.endReason === 'quit') return
  if (was.endReason === 'eof' && (await read($, repeatMode)) === 'off') return
  await reconnect($, config, intent, was.error)
}

// What this session started never played: once more with the android client
// for a URL, else say why where it stays (a toast alone is easy to miss).
type Launch = { id: string; url: string; client?: string; from?: Resume }
async function failed($: EngineInterface, config: Config, what: Launch, error: string) {
  launch = undefined
  await releaseLock($)
  const log = await $.fs
    .read((await paths($)).log)
    .then(text => text.trim().split('\n').pop() ?? '')
    .catch(() => '')
  const lastError = log || error
  if (!what.client && /^https?:/.test(what.url)) {
    $.ui.log(`stream-radio: ${what.url} would not play; retrying with the android client`)
    start($, config, what.url, what.from, 'android')
    return
  }
  const why = lastError ? lastError.slice(0, 300) : 'the player exited before anything played; is the URL playable?'
  $.ui.log(`stream-radio: could not play ${what.url}: ${why}`)
  $.ui.toast(`stream failed: ${why.slice(0, 120)}`)
}

// After a player that was playing ends by itself (a dropped stream, a crash),
// the waits before each try to start it again; past the last, it gives up.
const RECONNECT_MS = [2000, 5000, 15_000]
// Playing this long since the last try counts as recovered: a later drop starts
// the tries over.
const STEADY_MS = 60_000
// A lock older than this was left by a session that went away mid-reconnect.
const LOCK_STALE_MS = 60_000

// Takes reconnect.lock: created only if absent (O_EXCL, by the shell's
// noclobber), or taken over when stale.
async function takeLock($: EngineInterface): Promise<boolean> {
  const p = await paths($)
  const now = await $.clock.now().catch(() => 0)
  const create = async () =>
    (await $.process.run(['sh', '-c', 'set -C; printf %s "$1" > "$2"', 'sh', String(now), p.lock]).catch(() => undefined))?.exitCode === 0
  if (!(await create())) {
    const stat = await $.fs.stat(p.lock).catch(() => undefined)
    if (!stat || now - stat.mtimeMs < LOCK_STALE_MS) return false
    await $.process.run(['rm', '-f', p.lock]).catch(() => undefined)
    if (!(await create())) return false
  }
  holdsLock = true
  return true
}

async function releaseLock($: EngineInterface) {
  if (!holdsLock) return
  holdsLock = false
  await $.process.run(['rm', '-f', (await paths($)).lock]).catch(() => undefined)
}

async function reconnect($: EngineInterface, config: Config, intent: Intent, error: string) {
  if (!(await takeLock($))) return
  const now = await $.clock.now().catch(() => 0)
  const tries = intent.playedAt && now - intent.playedAt >= STEADY_MS ? 0 : intent.attempt
  const wait = RECONNECT_MS[tries]
  const why = error ? `: ${error.slice(0, 200)}` : ''
  if (wait === undefined) {
    await releaseLock($)
    $.ui.log(`stream-radio: ${intent.url} stopped${why}; gave up after ${RECONNECT_MS.length} tries`)
    $.ui.toast(`stream stopped; gave up after ${RECONNECT_MS.length} tries`)
    return
  }
  $.ui.log(`stream-radio: ${intent.url} stopped${why}; trying again in ${wait / 1000} s`)
  await update($, playing, () => `reconnecting in ${wait / 1000} s…`)
  const token = run
  // A reload or the session's end while it waits aborts the wait.
  if (!(await $.clock.sleep(wait).then(() => true, () => false))) return releaseLock($)
  // Stopped, or something else started (here or elsewhere), while it waited.
  const now2 = await readIntent($)
  if (run !== token || control || !now2 || now2.isStopped || now2.id !== intent.id || (await probe($))) {
    await releaseLock($)
    if (run === token && !control) await update($, playing, () => '')
    return
  }
  const at = await read($, resumeAt)
  start($, config, intent.url, at.url === intent.url ? at : undefined, intent.client || undefined, tries + 1)
}

// Ends the live player, if one answers: asked to quit, killed if it will not.
async function endPlayer($: EngineInterface) {
  const pid = await probe($)
  if (!pid) return
  await ipc($, (await paths($)).sock, ['quit'])
  for (let i = 0; i < 15; i++) {
    if (!(await probe($))) return
    await $.clock.sleep(200).catch(() => undefined)
  }
  await $.process.run(['kill', String(pid)]).catch(() => undefined)
}

// URLs that only played with the android client; they start with it directly.
const needsAndroid = new Set<string>()

// Starts playing `url` on the one shared player, replacing what it played.
// Returns at once: the first start after a reload is slow, and a hook that
// takes too long is reported as unanswered, so the startup runs in the
// background.
// `from`: a place to resume at once it plays, for the URL played last.
// `attempt`: how many reconnect tries came before this start.
function start($: EngineInterface, config: Config, url: string, from?: Resume, retryClient?: string, attempt = 0) {
  const { player, androidClient } = config
  // YouTube refuses the default client's stream URLs for some content (403);
  // the android client gets through, with muxed AAC and no audio-only Opus.
  const client = retryClient ?? (androidClient || needsAndroid.has(url) ? 'android' : undefined)
  detach()
  run += 1
  const mine = run
  isStarting = true
  pending = from?.url === url && (from.index > 0 || from.seconds >= RESUME_MIN_SECONDS) ? from : undefined
  void (async () => {
    try {
      await update($, isPaused, () => false)
      await update($, elapsed, () => -1)
      await update($, chapter, () => '')
      await update($, scroll, () => 0)
      await update($, queue, () => NO_QUEUE)
      await update($, isShuffled, () => false)
      await update($, listFilter, () => '')
      await update($, playing, () => 'connecting…')
      startScroller($, config)

      try {
        await $.process.run([player, '--version'], { timeoutMs: 5000 })
      } catch {
        stopScroller()
        await update($, playing, () => '')
        $.ui.toast(`Can't start "${player}". Install mpv (and yt-dlp for YouTube).`)
        return
      }
      if (mine !== run) return

      const p = await paths($)
      const now = await $.clock.now().catch(() => 0)
      const id = `${now}-${Math.random().toString(36).slice(2, 10)}`
      const what: Launch = { id, url, client, from }
      launch = what
      // Written first: the old player's watchers read it when it goes, and
      // know it was replaced rather than dropped.
      await writeIntent($, { id, url, client: client ?? '', isStopped: false, attempt, playedAt: 0 })
      await endPlayer($)
      if (mine !== run) return
      await $.process.run(['rm', '-f', p.sock]).catch(() => undefined)

      const loops = loopsFor(await read($, repeatMode))
      const argv = [
        player,
        '--no-video',
        '--no-input-terminal',
        '--idle=no',
        // Repeat as set, whatever your mpv.conf loops; a stream plays on.
        `--loop-file=${loops.file}`,
        `--loop-playlist=${loops.playlist}`,
        '--keep-open=no',
        `--input-ipc-server=${p.sock}`,
        '--ytdl-format=bestaudio/best',
        // A local folder plays its sound and video files (sound only), not its
        // cover art or archives, which would each take a turn; its subfolders
        // are read at once, so the panel can show them whole.
        ...(/^https?:/.test(url) ? [] : ['--directory-filter-types=audio,video,playlist', '--directory-mode=recursive']),
        ...(client ? [`--ytdl-raw-options-append=extractor-args=youtube:player_client=${client}`] : []),
        `--volume=${await read($, volumeLevel)}`,
        '--msg-level=all=error',
        '--',
        url,
      ]
      // Detached: in its own session, no terminal, its errors to mpv.log, so it
      // outlives this session and every other.
      await $.process.run(['sh', '-c', 'log=$1; shift; exec setsid -f "$@" </dev/null >/dev/null 2>"$log"', 'sh', p.log, ...argv], {
        timeoutMs: 10_000,
      })
      // mpv makes its socket before it opens anything.
      let pid: number | undefined
      for (let i = 0; i < 25 && !pid; i++) {
        if (mine !== run) return
        pid = await probe($)
        if (!pid) await $.clock.sleep(200).catch(() => undefined)
      }
      if (mine !== run) return
      if (!pid) {
        isStarting = false
        await goIdle($)
        startPoller($, config)
        await failed($, config, what, '')
        return
      }
      // Every session learns what plays from the player itself.
      await ipc($, p.sock, ['set_property', 'user-data/stream-radio/url', url])
      if (mine !== run) return
      attach($, config, p.sock, id)
    } finally {
      if (mine === run) isStarting = false
    }
  })().catch(error => {
    isStarting = false
    $.ui.log(`stream-radio: player task failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  })
}

// Ends the shared player, for every session: marked stopped first, so none of
// them reconnects.
async function stopPlaying($: EngineInterface, config: Config) {
  await saveLast($, true)
  run += 1
  isStarting = false
  launch = undefined
  pending = undefined
  const intent = await readIntent($)
  await writeIntent($, { ...(intent ?? { id: '', url: '', client: '', attempt: 0, playedAt: 0 }), isStopped: true })
  detach()
  await endPlayer($)
  await releaseLock($)
  await goIdle($)
  startPoller($, config)
}

// Follows the player another session started, if one plays; else watches for
// one. One look at a time: a command that needs the player waits for the look
// session.start began.
let connecting: Promise<void> | undefined

function connect($: EngineInterface, config: Config): Promise<void> {
  if (control || isStarting) return Promise.resolve()
  connecting ??= (async () => {
    if (await probe($)) {
      if (!control && !isStarting) attach($, config, (await paths($)).sock, (await readIntent($))?.id ?? '')
    } else {
      startPoller($, config)
    }
  })().finally(() => (connecting = undefined))
  return connecting
}

// Local paths already found to be folders or not; a path's kind does not change
// while it plays, and the list is read again at each song.
const isFolder = new Map<string, boolean>()

// A playlist entry as the panel lists it: its title, else its file name; a
// local folder (one mpv opens only when it gets there, as from a playlist
// file) as `📁 Name/`. Under `root`, the folder played whole, mpv has read every
// subfolder already, so an entry there is a file and needs no look.
async function entryName($: EngineInterface, e: { filename?: string; title?: string }, root: string): Promise<string> {
  if (e.title) return e.title
  if (!e.filename) return '?'
  const name = baseName(e.filename)
  if (!e.filename.startsWith('/') || (root && e.filename.startsWith(`${root}/`))) return name
  let folder = isFolder.get(e.filename)
  if (folder === undefined) {
    folder = await $.fs
      .stat(e.filename)
      .then(st => st.kind === 'dir')
      .catch(() => false)
    isFolder.set(e.filename, folder)
  }
  return folder ? `📁 ${name}/` : name
}

// What the panel lists: the playlist's entries, else the file's chapters (a
// video of several songs), else nothing to pick from.
// isReordered: the entries moved (a shuffle), so the whole list is read;
// isNewFile: a file loaded, so its chapters are read.
type Refresh = { isReordered?: boolean; isNewFile?: boolean }

async function refreshQueue($: EngineInterface, how: Refresh = {}) {
  const before = await read($, queue)
  const next = await readQueue($, before, how)
  await update($, queue, () => next)
  // A new folder starts shut; the current song's folders open when it changes,
  // so it shows, and a folder shut by hand stays shut until then.
  if (next.root !== before.root) await update($, openFolders, () => [])
  if (next.root && (next.current !== before.current || next.root !== before.root)) {
    const path = next.paths[next.current] ?? ''
    await update($, openFolders, open => [...new Set([...open, ...foldersOf(path, next.root)])])
  }
}

// The queue as mpv has it now. The watcher tells the playlist's length and
// position: a playlist of the length last read is the same playlist, and needs
// no asking; only a new one (or a shuffled one) is read whole.
async function readQueue($: EngineInterface, before: Queue, how: Refresh): Promise<Queue> {
  if (seen.count > 1) {
    if (!how.isReordered && before.kind === 'playlist' && before.items.length === seen.count) return { ...before, current: seen.pos }
    const list = (await mpv($, ['get_property', 'playlist']))?.data
    if (!Array.isArray(list) || list.length <= 1) return NO_QUEUE
    const entries = list as { filename?: string; title?: string; current?: boolean }[]
    const paths = entries.map(e => e.filename ?? '')
    // A local folder played whole: its entries are grouped under it.
    const url = await read($, lastUrl)
    const root = url.startsWith('/') && paths.some(p => p.startsWith(`${url.replace(/\/$/, '')}/`)) ? url.replace(/\/$/, '') : ''
    const current = entries.findIndex(e => e.current)
    return {
      kind: 'playlist',
      items: await Promise.all(entries.map(e => entryName($, e, root))),
      current: current >= 0 ? current : seen.pos,
      paths,
      root,
    }
  }
  if (!how.isNewFile && !how.isReordered && before.kind === 'chapters') return { ...before, current: seen.chapter }
  if (!how.isNewFile && before.kind === 'none' && seen.isLoaded && seen.chapter < 0) return NO_QUEUE
  const chapters = (await mpv($, ['get_property', 'chapter-list']))?.data
  if (!Array.isArray(chapters) || chapters.length <= 1) return NO_QUEUE
  const at = (await mpv($, ['get_property', 'chapter']))?.data
  return {
    kind: 'chapters',
    items: (chapters as { title?: string }[]).map((c, i) => c.title || `Chapter ${i + 1}`),
    current: typeof at === 'number' ? at : seen.chapter,
    paths: [],
    root: '',
  }
}

// Plays entry `index` of the queue, unpaused.
async function pick($: EngineInterface, index: number): Promise<string> {
  const q = await read($, queue)
  if (q.kind === 'none') return 'Nothing to pick from.'
  const ok = await mpv($, q.kind === 'playlist' ? ['playlist-play-index', index] : ['set_property', 'chapter', index])
  if (!ok) return 'The player is not ready yet.'
  await mpv($, ['set_property', 'pause', false])
  await update($, queue, x => ({ ...x, current: index }))
  return ''
}

// The next or previous playlist entry, else chapter.
async function step($: EngineInterface, by: 1 | -1): Promise<string> {
  const q = await read($, queue)
  if (q.kind === 'none') return 'Nothing before or after this.'
  const command = q.kind === 'playlist' ? [by > 0 ? 'playlist-next' : 'playlist-prev'] : ['add', 'chapter', by]
  return (await mpv($, command)) ? '' : 'The player is not ready yet.'
}

// Pauses or resumes through mpv; false while it is not listening yet. The new
// state is decided before sending and written as that value, not a flip: the
// watcher reports the change while the send runs, and a late flip would undo it.
async function togglePause($: EngineInterface): Promise<boolean> {
  if (!control) return false
  const target = !(await read($, isPaused))
  if (!(await mpv($, ['set_property', 'pause', target]))) return false
  await update($, isPaused, () => target)

  return true
}

// `/stream`'s argument or the panel's field: a URL, or a local file, folder or
// playlist that exists. Anything else comes back as the reply to show.
async function locate($: EngineInterface, args: string, fallback: string) {
  // Home and the session's folder only for a path that needs them: a URL or a
  // word like `stop` reads neither.
  let parsed = parseArgs(args, fallback)
  if (parsed.kind === 'error' || (parsed.kind === 'play' && parsed.isLocal)) {
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const cwd = await $.session.cwd().catch(() => '')
    parsed = parseArgs(args, fallback, { home, cwd })
  }
  if (parsed.kind === 'play' && parsed.isLocal && !(await $.fs.exists(parsed.url).catch(() => false))) {
    return { kind: 'error' as const, text: `No such file or folder: ${parsed.url}` }
  }
  return parsed
}

// Plays `url` again from where it got to, when that is where it got to.
function resume($: EngineInterface, config: Config, url: string, at: Resume) {
  start($, config, url, at.url === url ? at : undefined)
}

// Where playing `url` again picks up, as `Song name at 1:20`; empty when it
// starts at the beginning.
function resumable(at: Resume, url: string): string {
  if (at.url !== url || (at.index <= 0 && at.seconds < RESUME_MIN_SECONDS)) return ''
  const time = at.seconds >= RESUME_MIN_SECONDS ? ` at ${formatTime(at.seconds)}` : ''
  return `${at.title || 'where it was'}${time}`
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
    await loadLast($)
    await loadVolume($, config.volume)
    await loadRepeat($)
    if ((await read($, knownDefault)) !== defaultUrl) {
      await update($, knownDefault, () => defaultUrl)
      await update($, lastUrl, () => '')
      await update($, resumeAt, () => NO_RESUME)
      await saveLast($, true)
    }
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | last | pause | next | prev | vol N | shuffle | repeat | panel | stop]',
    })
    // A player another session started (or this one, before a reload) plays on:
    // follow it. In the background: a slow answer must not hold up the session.
    void connect($, config).catch(() => undefined)

    return next(e)
  })

  // The player is everyone's: it plays on after this session ends.
  on('session.end', async ($, e, next) => {
    detach()
    stopPoller()
    stopScroller()
    await releaseLock($)

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    // A throwing hook is skipped and /stream then says nothing useful: say why.
    try {
      const parsed = await locate($, e.args, defaultUrl)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'stop') {
        await stopPlaying($, config)

        return { text: 'Stopped.' }
      }
      if (parsed.kind === 'panel') return { text: `Radio panel ${await togglePane($)}.` }
      // A player another session started may not be followed yet (this session
      // just started): look before saying nothing plays.
      if (!control && parsed.kind !== 'play' && parsed.kind !== 'last') await connect($, config).catch(() => undefined)
      if (parsed.kind === 'shuffle') {
        if (!control) return { text: 'Nothing is playing.' }
        return { text: await toggleShuffle($) }
      }
      if (parsed.kind === 'repeat') return { text: await setRepeat($, parsed.mode ?? nextRepeat(await read($, repeatMode))) }
      if (parsed.kind === 'volume') {
        const now = await read($, volumeLevel)
        if (parsed.to === undefined && parsed.by === undefined) return { text: `Volume ${now}%.` }
        return { text: await setVolume($, config.volume, parsed.to ?? now + (parsed.by ?? 0)) }
      }
      if (parsed.kind === 'next' || parsed.kind === 'prev') {
        if (!control) return { text: 'Nothing is playing.' }
        return { text: (await step($, parsed.kind === 'next' ? 1 : -1)) || (parsed.kind === 'next' ? 'Next.' : 'Previous.') }
      }
      if (parsed.kind === 'toggle') {
        if (!control) return { text: 'Nothing is playing.' }
        if (!(await togglePause($))) return { text: 'The player is not ready yet.' }

        return { text: 'Toggled pause.' }
      }

      if (parsed.kind === 'last') {
        // What played last in this session; the default stream before anything has.
        const again = (await read($, lastUrl)) || defaultUrl
        if (!again) return { text: 'Nothing has played yet, and there is no default stream.' }
        const at = await read($, resumeAt)
        resume($, config, again, at)
        const where = resumable(at, again)

        return { text: where ? `Resuming ${where}.` : `Starting ${again}.` }
      }

      start($, config, parsed.url)

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
                ? resume($, config, again, await read($, resumeAt))
                : config.toggleOnly
                  ? void togglePause($)
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
            onPress={async () => resume($, config, again, await read($, resumeAt))}
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
          onPress={() => (config.toggleOnly ? void togglePause($) : void togglePane($))}
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
        start($, config, url)
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
                <Button key="prev" label="⏮ Prev" onPress={() => act(() => step($, -1))} />
              ) : null}
              <Button
                key="pause"
                label={paused ? '▶ Resume' : '⏸ Pause'}
                onPress={() => act(async () => ((await togglePause($)) ? '' : 'The player is not ready yet.'))}
              />
              {q.kind !== 'none' ? (
                <Button key="next" label="Next ⏭" onPress={() => act(() => step($, 1))} />
              ) : null}
              <Button key="stop" label="⏹ Stop" onPress={() => act(async () => (await stopPlaying($, config), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="vol-down" label="🔉 −" onPress={() => act(async () => (await setVolume($, config.volume, level - VOLUME_STEP), ''))} />
              <Text>{`Volume ${level}%`}</Text>
              <Button key="vol-up" label="🔊 +" onPress={() => act(async () => (await setVolume($, config.volume, level + VOLUME_STEP), ''))} />
            </Box>
            <Box flexDirection="row" gap={1}>
              {q.kind === 'playlist' ? (
                <Button key="shuffle" label={shuffled ? '🔀 Shuffle: on' : '🔀 Shuffle: off'} onPress={() => act(() => toggleShuffle($))} />
              ) : null}
              <Button
                key="repeat"
                label={repeat === 'all' ? '🔁 Repeat: all' : repeat === 'one' ? '🔂 Repeat: one' : '🔁 Repeat: off'}
                onPress={() => act(() => setRepeat($, nextRepeat(repeat)))}
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
                    resume($, config, last, at)
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
              const parsed = await locate($, value.trim(), '')
              if (parsed.kind === 'play') {
                start($, config, parsed.url)
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
                  return first?.kind === 'item' ? act(() => pick($, first.index)) : act(async () => 'Nothing matches.')
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
                  onPress={() => act(() => pick($, i))}
                />
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}

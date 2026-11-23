// The player: one mpv shared by every session and the TUI, started detached,
// followed through its IPC socket, reconnected after a drop. Host-neutral:
// everything outside comes through `h: Host` (core/host.ts).
import type { Host, Queue, Resume } from './host'
import {
  formatTime,
  baseName,
  clampVolume,
  loopsFor,
  type Repeat,
  foldersOf,
  metaValue,
  parseArgs,
  type PlayerEvent,
  repeatOf,
  splitEvents,
  trackTitle,
  WATCHED,
} from './nowplaying'

export type PlayerConfig = { volume: number; player: string; androidClient: boolean }

// Nothing to pick from.
export const NO_QUEUE: Queue = { kind: 'none', items: [], current: -1, paths: [], root: '' }

// Where the last URL got to: its playlist entry (-1 when it has no playlist) and
// the seconds into it (-1 for a live stream), with the song's title, so playing
// the last URL again after a stop resumes there.
export const NO_RESUME: Resume = { url: '', index: -1, seconds: -1, title: '' }
// The volume as last set, the player's from the start; kept in saved state with
// the Volume setting it began from, so a changed setting wins again.
export const VOLUME_KEY = 'volume'
export type SavedVolume = { value: number; configured: number }

export async function loadVolume(h: Host, configured: number) {
  const saved = (await h.saved.get(VOLUME_KEY).catch(() => undefined)) as Partial<SavedVolume> | undefined
  const value = saved && saved.configured === configured && typeof saved.value === 'number' ? saved.value : configured
  await h.vars.change('volume', () => clampVolume(value))
}

// Sets the volume, of the playing player too; resolves to the reply to show.
export async function setVolume(h: Host, configured: number, level: number): Promise<string> {
  const to = clampVolume(level)
  await h.vars.change('volume', () => to)
  await h.saved.set(VOLUME_KEY, { value: to, configured } satisfies SavedVolume).catch(() => undefined)
  if (control && !(await mpv(h, ['set_property', 'volume', to]))) return `Volume ${to}%; the player is not ready yet.`
  return `Volume ${to}%.`
}

// Repeat: kept in saved state as a preference. Shuffle: the playing playlist's,
// off again when something new starts.
// What the panel's list is narrowed to, as typed; empty again when something
// new starts.
export const REPEAT_KEY = 'repeat'

export async function loadRepeat(h: Host) {
  const saved = await h.saved.get(REPEAT_KEY).catch(() => undefined)
  if (saved === 'all' || saved === 'one' || saved === 'off') await h.vars.change('repeat', () => saved)
}

// Sets repeat, of the playing player too; resolves to the reply to show.
export async function setRepeat(h: Host, mode: Repeat): Promise<string> {
  await h.vars.change('repeat', () => mode)
  await h.saved.set(REPEAT_KEY, mode).catch(() => undefined)
  const loops = loopsFor(mode)
  if (control) {
    await mpv(h, ['set_property', 'loop-file', loops.file])
    await mpv(h, ['set_property', 'loop-playlist', loops.playlist])
  }
  return mode === 'all' ? 'Repeat: the whole playlist.' : mode === 'one' ? 'Repeat: this song.' : 'Repeat off: playback ends after the last song.'
}

// Shuffles the playing playlist, or puts it back in order; mpv keeps the song
// playing where it is. The list is read again, as its order changed; the mark
// on the player tells the other sessions to read it again too.
export async function toggleShuffle(h: Host): Promise<string> {
  if ((await h.vars.read('queue')).kind !== 'playlist') return 'Nothing to shuffle: this is not a playlist.'
  const on = !(await h.vars.read('isShuffled'))
  if (!(await mpv(h, [on ? 'playlist-shuffle' : 'playlist-unshuffle']))) return 'The player is not ready yet.'
  await h.vars.change('isShuffled', () => on)
  await mpv(h, ['set_property', 'user-data/stream-radio/shuffled', on])
  await refreshQueue(h, { isReordered: true })
  return on ? 'Shuffled.' : 'Back in order.'
}

export const STORE_KEY = 'last'
export const SAVE_MS = 10_000
export type Saved = { url: string; resumeAt: Resume; knownDefault: string }
let savedAt = 0

export async function saveLast(h: Host, isNow = false) {
  const now = await h.now().catch(() => 0)
  if (!isNow && now - savedAt < SAVE_MS) return
  savedAt = now
  const saved: Saved = { url: await h.vars.read('lastUrl'), resumeAt: await h.vars.read('resumeAt'), knownDefault: await h.vars.read('knownDefault') }
  await h.saved.set(STORE_KEY, saved).catch(() => undefined)
}

// What an earlier session saved, when this one has nothing of its own yet.
export async function loadLast(h: Host) {
  if (await h.vars.read('lastUrl')) return
  const saved = (await h.saved.get(STORE_KEY).catch(() => undefined)) as Partial<Saved> | undefined
  if (!saved || typeof saved.url !== 'string' || !saved.url) return
  const url = saved.url
  await h.vars.change('lastUrl', () => url)
  if (typeof saved.knownDefault === 'string') {
    const known = saved.knownDefault
    await h.vars.change('knownDefault', () => known)
  }
  const at = saved.resumeAt
  if (at && at.url === url && typeof at.index === 'number' && typeof at.seconds === 'number') {
    await h.vars.change('resumeAt', () => ({ url, index: at.index, seconds: at.seconds, title: typeof at.title === 'string' ? at.title : '' }))
  }
}

// Closer to a song's start than this, it resumes at the start.
export const RESUME_MIN_SECONDS = 5




// ONE player for every session. mpv runs detached from all of them (setsid),
// listening on one socket in the plugin's data folder, and keeps playing until
// someone stops it. Next to it in that folder:
// - player.json, what was last asked of the player (Intent): every session
//   reads it when the player goes away, to tell a stop or a new start from a
//   drop worth reconnecting;
// - reconnect.lock, held by the one session that reconnects after a drop;
// - mpv.log, the player's errors, for saying why something would not play.
export type Paths = { sock: string; intent: string; lock: string; log: string }
let dataDir: string | undefined

export async function paths(h: Host): Promise<Paths> {
  dataDir ??= await h.dataDir()
  return { sock: `${dataDir}/mpv.sock`, intent: `${dataDir}/player.json`, lock: `${dataDir}/reconnect.lock`, log: `${dataDir}/mpv.log` }
}

// id: one per start; isStopped: someone pressed stop; attempt: reconnect tries
// before this start; playedAt: when it first played (0 until it has).
export type Intent = { id: string; url: string; client: string; isStopped: boolean; attempt: number; playedAt: number }

export async function readIntent(h: Host): Promise<Intent | undefined> {
  try {
    const value = JSON.parse(await h.fs.read((await paths(h)).intent)) as Partial<Intent>
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

export async function writeIntent(h: Host, intent: Intent) {
  await h.fs.write((await paths(h)).intent, JSON.stringify(intent)).catch(() => undefined)
}

// Runs one mpv command on `socket`; resolves to its reply's data, or undefined
// when nothing listens or mpv refused.
export async function ipc(h: Host, socket: string, command: readonly unknown[]): Promise<{ data: unknown } | undefined> {
  return h.ipc(socket, command)
}

// The command on the player this session follows; undefined while it follows none.
export async function mpv(h: Host, command: readonly unknown[]) {
  return control ? ipc(h, control, command) : undefined
}

// The live player's pid; undefined when none answers on the socket.
export async function probe(h: Host): Promise<number | undefined> {
  const reply = await ipc(h, (await paths(h)).sock, ['get_property', 'pid'])
  return typeof reply?.data === 'number' ? reply.data : undefined
}

// The socket of the player this session follows; undefined while it follows none.
let control: string | undefined
// Whether this session follows a player now.
export const isFollowing = (): boolean => control !== undefined
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
// Looks for a player another session started, while this one follows none.
let poller: { cancel(): void } | undefined
let isPolling = false
// The socket file's time when no player answered on it: not asked again until
// a new player makes a new one.
let staleMtime = -1

// What the watcher has told of the player this session follows.
export type Seen = {
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
export const fresh = (): Seen => ({
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


// Back to showing nothing playing.
export async function goIdle(h: Host) {
  h.events.watching(false)
  await h.vars.change('playing', () => '')
  await h.vars.change('isPaused', () => false)
  await h.vars.change('elapsed', () => -1)
  await h.vars.change('chapter', () => '')
  await h.vars.change('queue', () => NO_QUEUE)
}

// While this session follows no player, a look every POLL_MS at the socket file
// (no process: a stat) finds one another session started.
export const POLL_MS = 3000

export function startPoller(h: Host, config: PlayerConfig) {
  if (poller) return
  poller = h.every(POLL_MS, () => {
    if (control || isStarting || isPolling) return
    isPolling = true
    void (async () => {
      const p = await paths(h)
      const stat = await h.fs.stat(p.sock).catch(() => undefined)
      if (!stat || stat.mtimeMs === staleMtime || control || isStarting) return
      if (await probe(h)) {
        if (!control && !isStarting) attach(h, config, p.sock, (await readIntent(h))?.id ?? '')
      } else {
        staleMtime = stat.mtimeMs
      }
    })()
      .catch(() => undefined)
      .finally(() => (isPolling = false))
  })
}

export function stopPoller() {
  poller?.cancel()
  poller = undefined
}

// Stops following the player (it plays on).
export function detach() {
  watchRun += 1
  const old = watcher
  watcher = undefined
  control = undefined
  void old?.return(undefined).catch(() => undefined)
}

// Follows the live player on the socket: a watcher streams its changes into
// this session's footer and panel until it goes away. `id`: the Intent it was
// started under, to tell later whether it was replaced.
export function attach(h: Host, config: PlayerConfig, sock: string, id: string) {
  detach()
  const mine = watchRun
  control = sock
  stopPoller()
  seen = fresh()
  h.events.watching(true)
  void (async () => {
    let rest = ''
    try {
      const stream = h.watch(sock, WATCHED)
      if (mine !== watchRun) return void stream.return(undefined as never).catch(() => undefined)
      watcher = stream
      for await (const text of stream) {
        if (mine !== watchRun) return
        const split = splitEvents(rest + text)
        rest = split.rest
        for (const event of split.events) {
          if (mine !== watchRun) return
          await onEvent(h, event)
        }
      }
    } catch {
      // the watcher could not start or was ended: the player is gone or not ours
    }
    if (mine !== watchRun) return
    watcher = undefined
    control = undefined
    await onGone(h, config, id)
  })().catch(error => h.log(`stream-radio: watcher failed: ${error instanceof Error ? error.message : String(error)}`, 'debug'))
}

// One change of the player, as every session following it sees it.
export async function onEvent(h: Host, event: PlayerEvent) {
  if (event.event === 'end-file') {
    seen.endReason = event.reason ?? ''
    if (event.file_error) seen.error = event.file_error
    return
  }
  if (event.event !== 'property-change') {
    if (event.event === 'file-loaded') {
      await markLoaded(h)
      await onLoaded(h)
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
      if (title && title !== (await h.vars.read('playing'))) {
        await h.events.titleChanged()
        await h.vars.change('playing', () => title)
      }
      return
    }
    case 'pause':
      if (typeof data === 'boolean') await h.vars.change('isPaused', () => data)
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
        await markLoaded(h)
        await onLoaded(h)
      }
      const pos = seen.hasEnd ? data : -1
      if (pos !== (await h.vars.read('elapsed'))) await h.vars.change('elapsed', () => pos)
      await recordPosition(h, pos)
      return
    }
    case 'chapter-metadata': {
      const part = metaValue(data, 'title')
      if (part !== (await h.vars.read('chapter'))) {
        await h.events.titleChanged()
        await h.vars.change('chapter', () => part)
      }
      return
    }
    case 'chapter':
      seen.chapter = typeof data === 'number' ? data : -1
      if ((await h.vars.read('queue')).kind === 'chapters') await refreshQueue(h)
      return
    case 'playlist-pos':
    case 'playlist-count':
      if (name === 'playlist-pos') seen.pos = typeof data === 'number' ? data : -1
      else seen.count = typeof data === 'number' ? data : 0
      if (seen.isLoaded) await refreshQueue(h)
      return
    case 'volume':
      // The player's own volume wins over what this session last knew.
      if (typeof data === 'number') await h.vars.change('volume', () => clampVolume(data))
      return
    case 'loop-file':
    case 'loop-playlist': {
      if (name === 'loop-file') seen.loopFile = data
      else seen.loopPlaylist = data
      if (seen.loopFile !== undefined && seen.loopPlaylist !== undefined) {
        const mode = repeatOf(seen.loopFile, seen.loopPlaylist)
        await h.vars.change('repeat', () => mode)
      }
      return
    }
    case 'user-data/stream-radio/url':
      seen.url = typeof data === 'string' ? data : ''
      if (seen.isLoaded) await markLoaded(h)
      return
    case 'user-data/stream-radio/shuffled': {
      const on = data === true
      if (on !== (await h.vars.read('isShuffled'))) {
        await h.vars.change('isShuffled', () => on)
        if (seen.isLoaded) await refreshQueue(h, { isReordered: true })
      }
      return
    }
  }
}

// The player plays: what it plays becomes the URL played last, here too.
export async function markLoaded(h: Host) {
  seen.isLoaded = true
  const url = seen.url
  if (url && url !== (await h.vars.read('lastUrl'))) await h.vars.change('lastUrl', () => url)
}

// A file loaded: the list (or the file's chapters) read again; for what this
// session started, the first load means it really plays.
export async function onLoaded(h: Host) {
  await refreshQueue(h, { isNewFile: true }).catch(() => undefined)
  const intent = await readIntent(h)
  if (launch && intent?.id === launch.id && !intent.playedAt) {
    const now = await h.now().catch(() => 0)
    await writeIntent(h, { ...intent, playedAt: now || 1 })
    if (launch.client) needsAndroid.add(launch.url)
    else needsAndroid.delete(launch.url)
    await saveLast(h, true)
    await releaseLock(h)
  }
  if (!pending) return
  const q = await h.vars.read('queue')
  if (q.kind === 'playlist' && pending.index >= 0 && pending.index < q.items.length && q.current !== pending.index) {
    // The jump loads another file; its file-loaded comes back through here.
    if (!(await mpv(h, ['playlist-play-index', pending.index]))) pending = undefined
  } else {
    if (pending.seconds >= RESUME_MIN_SECONDS) await mpv(h, ['seek', pending.seconds, 'absolute'])
    pending = undefined
  }
}

// Where the playing URL got to, for resuming it later; not while a resume
// point is still being reached, or the first song's start would overwrite it.
export async function recordPosition(h: Host, pos: number) {
  const url = await h.vars.read('lastUrl')
  const title = (await h.vars.read('chapter')) || (await h.vars.read('playing'))
  if (pending || !url || !title || title === 'connecting…') return
  const q = await h.vars.read('queue')
  const index = q.kind === 'playlist' ? q.current : -1
  const was = await h.vars.read('resumeAt')
  if (was.url === url && was.index === index && was.seconds === pos && was.title === title) return
  await h.vars.change('resumeAt', () => ({ url, index, seconds: pos, title }))
  await saveLast(h, was.url !== url || was.index !== index || was.title !== title)
}

// The player this session followed went away. Stopped, replaced by a new start
// or ended on purpose: nothing more. Never played, and this session started
// it: say why. Dropped after playing: one session (whichever takes the lock)
// starts it again.
export async function onGone(h: Host, config: PlayerConfig, id: string) {
  const was = seen
  await saveLast(h, true)
  await goIdle(h)
  startPoller(h, config)
  // The watcher ended but the player answers: the watcher was killed (as at
  // this session's exit), not the player. The poller follows it again.
  if (await probe(h)) return
  const intent = await readIntent(h)
  const mine = launch && launch.id === id ? launch : undefined
  if (!intent || intent.isStopped || intent.id !== id) return
  if (!was.isLoaded) {
    if (mine) await failed(h, config, mine, was.error)
    return
  }
  if (was.endReason === 'quit') return
  if (was.endReason === 'eof' && (await h.vars.read('repeat')) === 'off') return
  await reconnect(h, config, intent, was.error)
}

// What this session started never played: once more with the other client
// for a URL (android after the default, the default after android), else say
// why where it stays (a toast alone is easy to miss).
// isRetry: this start is already that second try.
export type Launch = { id: string; url: string; client?: string; from?: Resume; isRetry?: boolean }
export async function failed(h: Host, config: PlayerConfig, what: Launch, error: string) {
  launch = undefined
  await releaseLock(h)
  const log = await h.fs
    .read((await paths(h)).log)
    .then(reason)
    .catch(() => '')
  const lastError = log || error
  if (!what.isRetry && /^https?:/.test(what.url)) {
    const other = what.client ? 'default' : 'android'
    h.log(`stream-radio: ${what.url} would not play; retrying with the ${other} client`)
    start(h, config, what.url, what.from, what.client ? '' : 'android', 0, true)
    return
  }
  const why = lastError ? lastError.slice(0, 300) : 'the player exited before anything played; is the URL playable?'
  h.log(`stream-radio: could not play ${what.url}: ${why}`)
  h.toast(`stream failed: ${why.slice(0, 120)}`)
}

// Why mpv would not play, from what it printed: yt-dlp's error when there is
// one (mpv's own last line is then only "Failed to recognize file format."),
// else mpv's last line.
export function reason(log: string): string {
  const lines = log.trim().split('\n').map(line => line.trim()).filter(Boolean)
  const ytdl = lines.findLast(line => /^\[ytdl_hook\] ERROR: /.test(line))
  if (ytdl) return ytdl.replace(/^\[ytdl_hook\] ERROR: /, '').replace(/;\s*please report this issue.*$/, '')
  return lines.at(-1) ?? ''
}

// After a player that was playing ends by itself (a dropped stream, a crash),
// the waits before each try to start it again; past the last, it gives up.
export const RECONNECT_MS = [2000, 5000, 15_000]
// Playing this long since the last try counts as recovered: a later drop starts
// the tries over.
export const STEADY_MS = 60_000
// A lock older than this was left by a session that went away mid-reconnect.
export const LOCK_STALE_MS = 60_000

// Takes reconnect.lock: created only if absent (O_EXCL, by the shell's
// noclobber), or taken over when stale.
export async function takeLock(h: Host): Promise<boolean> {
  const p = await paths(h)
  const now = await h.now().catch(() => 0)
  const create = async () =>
    (await h.run(['sh', '-c', 'set -C; printf %s "$1" > "$2"', 'sh', String(now), p.lock]).catch(() => undefined))?.exitCode === 0
  if (!(await create())) {
    const stat = await h.fs.stat(p.lock).catch(() => undefined)
    if (!stat || now - stat.mtimeMs < LOCK_STALE_MS) return false
    await h.run(['rm', '-f', p.lock]).catch(() => undefined)
    if (!(await create())) return false
  }
  holdsLock = true
  return true
}

export async function releaseLock(h: Host) {
  if (!holdsLock) return
  holdsLock = false
  await h.run(['rm', '-f', (await paths(h)).lock]).catch(() => undefined)
}

export async function reconnect(h: Host, config: PlayerConfig, intent: Intent, error: string) {
  if (!(await takeLock(h))) return
  const now = await h.now().catch(() => 0)
  const tries = intent.playedAt && now - intent.playedAt >= STEADY_MS ? 0 : intent.attempt
  const wait = RECONNECT_MS[tries]
  const why = error ? `: ${error.slice(0, 200)}` : ''
  if (wait === undefined) {
    await releaseLock(h)
    h.log(`stream-radio: ${intent.url} stopped${why}; gave up after ${RECONNECT_MS.length} tries`)
    h.toast(`stream stopped; gave up after ${RECONNECT_MS.length} tries`)
    return
  }
  h.log(`stream-radio: ${intent.url} stopped${why}; trying again in ${wait / 1000} s`)
  await h.vars.change('playing', () => `reconnecting in ${wait / 1000} s…`)
  const token = run
  // A reload or the session's end while it waits aborts the wait.
  if (!(await h.sleep(wait).then(() => true, () => false))) return releaseLock(h)
  // Stopped, or something else started (here or elsewhere), while it waited.
  const now2 = await readIntent(h)
  if (run !== token || control || !now2 || now2.isStopped || now2.id !== intent.id || (await probe(h))) {
    await releaseLock(h)
    if (run === token && !control) await h.vars.change('playing', () => '')
    return
  }
  const at = await h.vars.read('resumeAt')
  start(h, config, intent.url, at.url === intent.url ? at : undefined, intent.client, tries + 1)
}

// Ends the live player, if one answers: asked to quit, killed if it will not.
export async function endPlayer(h: Host) {
  const pid = await probe(h)
  if (!pid) return
  await ipc(h, (await paths(h)).sock, ['quit'])
  for (let i = 0; i < 15; i++) {
    if (!(await probe(h))) return
    await h.sleep(200).catch(() => undefined)
  }
  await h.run(['kill', String(pid)]).catch(() => undefined)
}

// URLs that only played with the android client; they start with it directly.
export const needsAndroid = new Set<string>()

// Starts playing `url` on the one shared player, replacing what it played.
// Returns at once: the first start after a reload is slow, and a hook that
// takes too long is reported as unanswered, so the startup runs in the
// background.
// `from`: a place to resume at once it plays, for the URL played last.
// `attempt`: how many reconnect tries came before this start.
// `retryClient`: the client to use whatever the settings say ('' the default).
// `isRetry`: the second try after a start that never played.
export function start(h: Host, config: PlayerConfig, url: string, from?: Resume, retryClient?: string, attempt = 0, isRetry = false) {
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
      await h.vars.change('isPaused', () => false)
      await h.vars.change('elapsed', () => -1)
      await h.vars.change('chapter', () => '')
      await h.events.titleChanged()
      await h.vars.change('queue', () => NO_QUEUE)
      await h.vars.change('isShuffled', () => false)
      await h.vars.change('filter', () => '')
      await h.vars.change('playing', () => 'connecting…')
      h.events.watching(true)

      try {
        await h.run([player, '--version'], { timeoutMs: 5000 })
      } catch {
        h.events.watching(false)
        await h.vars.change('playing', () => '')
        h.toast(`Can't start "${player}". Install mpv (and yt-dlp for YouTube).`)
        return
      }
      if (mine !== run) return

      const p = await paths(h)
      const now = await h.now().catch(() => 0)
      const id = `${now}-${Math.random().toString(36).slice(2, 10)}`
      const what: Launch = { id, url, client, from, isRetry }
      launch = what
      // Written first: the old player's watchers read it when it goes, and
      // know it was replaced rather than dropped.
      await writeIntent(h, { id, url, client: client ?? '', isStopped: false, attempt, playedAt: 0 })
      await endPlayer(h)
      if (mine !== run) return
      await h.run(['rm', '-f', p.sock]).catch(() => undefined)

      const loops = loopsFor(await h.vars.read('repeat'))
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
        `--volume=${await h.vars.read('volume')}`,
        '--msg-level=all=error',
        '--',
        url,
      ]
      // Detached: in its own session, no terminal, its errors to mpv.log, so it
      // outlives this session and every other. mpv prints its messages to
      // stdout, so both go there; --msg-level keeps it to errors.
      await h.run(['sh', '-c', 'log=$1; shift; exec setsid -f "$@" </dev/null >"$log" 2>&1', 'sh', p.log, ...argv], {
        timeoutMs: 10_000,
      })
      // mpv makes its socket before it opens anything.
      let pid: number | undefined
      for (let i = 0; i < 25 && !pid; i++) {
        if (mine !== run) return
        pid = await probe(h)
        if (!pid) await h.sleep(200).catch(() => undefined)
      }
      if (mine !== run) return
      if (!pid) {
        isStarting = false
        await goIdle(h)
        startPoller(h, config)
        await failed(h, config, what, '')
        return
      }
      // Every session learns what plays from the player itself.
      await ipc(h, p.sock, ['set_property', 'user-data/stream-radio/url', url])
      if (mine !== run) return
      attach(h, config, p.sock, id)
    } finally {
      if (mine === run) isStarting = false
    }
  })().catch(error => {
    isStarting = false
    h.log(`stream-radio: player task failed: ${error instanceof Error ? error.message : String(error)}`, 'debug')
  })
}

// Ends the shared player, for every session: marked stopped first, so none of
// them reconnects.
export async function stopPlaying(h: Host, config: PlayerConfig) {
  await saveLast(h, true)
  run += 1
  isStarting = false
  launch = undefined
  pending = undefined
  const intent = await readIntent(h)
  await writeIntent(h, { ...(intent ?? { id: '', url: '', client: '', attempt: 0, playedAt: 0 }), isStopped: true })
  detach()
  await endPlayer(h)
  await releaseLock(h)
  await goIdle(h)
  startPoller(h, config)
}

// Follows the player another session started, if one plays; else watches for
// one. One look at a time: a command that needs the player waits for the look
// session.start began.
let connecting: Promise<void> | undefined

export function connect(h: Host, config: PlayerConfig): Promise<void> {
  if (control || isStarting) return Promise.resolve()
  connecting ??= (async () => {
    if (await probe(h)) {
      if (!control && !isStarting) attach(h, config, (await paths(h)).sock, (await readIntent(h))?.id ?? '')
    } else {
      startPoller(h, config)
    }
  })().finally(() => (connecting = undefined))
  return connecting
}

// Local paths already found to be folders or not; a path's kind does not change
// while it plays, and the list is read again at each song.
export const isFolder = new Map<string, boolean>()

// A playlist entry as the panel lists it: its title, else its file name; a
// local folder (one mpv opens only when it gets there, as from a playlist
// file) as `📁 Name/`. Under `root`, the folder played whole, mpv has read every
// subfolder already, so an entry there is a file and needs no look.
export async function entryName(h: Host, e: { filename?: string; title?: string }, root: string): Promise<string> {
  if (e.title) return e.title
  if (!e.filename) return '?'
  const name = baseName(e.filename)
  if (!e.filename.startsWith('/') || (root && e.filename.startsWith(`${root}/`))) return name
  let folder = isFolder.get(e.filename)
  if (folder === undefined) {
    folder = await h.fs
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
export type Refresh = { isReordered?: boolean; isNewFile?: boolean }

export async function refreshQueue(h: Host, how: Refresh = {}) {
  const before = await h.vars.read('queue')
  const next = await readQueue(h, before, how)
  await h.vars.change('queue', () => next)
  // A new folder starts shut; the current song's folders open when it changes,
  // so it shows, and a folder shut by hand stays shut until then.
  if (next.root !== before.root) await h.vars.change('openFolders', () => [])
  if (next.root && (next.current !== before.current || next.root !== before.root)) {
    const path = next.paths[next.current] ?? ''
    await h.vars.change('openFolders', open => [...new Set([...open, ...foldersOf(path, next.root)])])
  }
}

// The queue as mpv has it now. The watcher tells the playlist's length and
// position: a playlist of the length last read is the same playlist, and needs
// no asking; only a new one (or a shuffled one) is read whole.
export async function readQueue(h: Host, before: Queue, how: Refresh): Promise<Queue> {
  if (seen.count > 1) {
    if (!how.isReordered && before.kind === 'playlist' && before.items.length === seen.count) return { ...before, current: seen.pos }
    const list = (await mpv(h, ['get_property', 'playlist']))?.data
    if (!Array.isArray(list) || list.length <= 1) return NO_QUEUE
    const entries = list as { filename?: string; title?: string; current?: boolean }[]
    const paths = entries.map(e => e.filename ?? '')
    // A local folder played whole: its entries are grouped under it.
    const url = await h.vars.read('lastUrl')
    const root = url.startsWith('/') && paths.some(p => p.startsWith(`${url.replace(/\/$/, '')}/`)) ? url.replace(/\/$/, '') : ''
    const current = entries.findIndex(e => e.current)
    return {
      kind: 'playlist',
      items: await Promise.all(entries.map(e => entryName(h, e, root))),
      current: current >= 0 ? current : seen.pos,
      paths,
      root,
    }
  }
  if (!how.isNewFile && !how.isReordered && before.kind === 'chapters') return { ...before, current: seen.chapter }
  if (!how.isNewFile && before.kind === 'none' && seen.isLoaded && seen.chapter < 0) return NO_QUEUE
  const chapters = (await mpv(h, ['get_property', 'chapter-list']))?.data
  if (!Array.isArray(chapters) || chapters.length <= 1) return NO_QUEUE
  const at = (await mpv(h, ['get_property', 'chapter']))?.data
  return {
    kind: 'chapters',
    items: (chapters as { title?: string }[]).map((c, i) => c.title || `Chapter ${i + 1}`),
    current: typeof at === 'number' ? at : seen.chapter,
    paths: [],
    root: '',
  }
}

// Plays entry `index` of the queue, unpaused.
export async function pick(h: Host, index: number): Promise<string> {
  const q = await h.vars.read('queue')
  if (q.kind === 'none') return 'Nothing to pick from.'
  const ok = await mpv(h, q.kind === 'playlist' ? ['playlist-play-index', index] : ['set_property', 'chapter', index])
  if (!ok) return 'The player is not ready yet.'
  await mpv(h, ['set_property', 'pause', false])
  await h.vars.change('queue', x => ({ ...x, current: index }))
  return ''
}

// The next or previous playlist entry, else chapter.
export async function step(h: Host, by: 1 | -1): Promise<string> {
  const q = await h.vars.read('queue')
  if (q.kind === 'none') return 'Nothing before or after this.'
  const command = q.kind === 'playlist' ? [by > 0 ? 'playlist-next' : 'playlist-prev'] : ['add', 'chapter', by]
  return (await mpv(h, command)) ? '' : 'The player is not ready yet.'
}

// Pauses or resumes through mpv; false while it is not listening yet. The new
// state is decided before sending and written as that value, not a flip: the
// watcher reports the change while the send runs, and a late flip would undo it.
export async function togglePause(h: Host): Promise<boolean> {
  if (!control) return false
  const target = !(await h.vars.read('isPaused'))
  if (!(await mpv(h, ['set_property', 'pause', target]))) return false
  await h.vars.change('isPaused', () => target)

  return true
}

// `/stream`'s argument or the panel's field: a URL, or a local file, folder or
// playlist that exists. Anything else comes back as the reply to show.
export async function locate(h: Host, args: string, fallback: string) {
  // Home and the session's folder only for a path that needs them: a URL or a
  // word like `stop` reads neither.
  let parsed = parseArgs(args, fallback)
  if (parsed.kind === 'error' || (parsed.kind === 'play' && parsed.isLocal)) {
    const home = await h.home().catch(() => '')
    const cwd = await h.cwd().catch(() => '')
    parsed = parseArgs(args, fallback, { home, cwd })
  }
  if (parsed.kind === 'play' && parsed.isLocal && !(await h.fs.exists(parsed.url).catch(() => false))) {
    return { kind: 'error' as const, text: `No such file or folder: ${parsed.url}` }
  }
  return parsed
}

// Plays `url` again from where it got to, when that is where it got to.
export function resume(h: Host, config: PlayerConfig, url: string, at: Resume) {
  start(h, config, url, at.url === url ? at : undefined)
}

// Where playing `url` again picks up, as `Song name at 1:20`; empty when it
// starts at the beginning.
export function resumable(at: Resume, url: string): string {
  if (at.url !== url || (at.index <= 0 && at.seconds < RESUME_MIN_SECONDS)) return ''
  const time = at.seconds >= RESUME_MIN_SECONDS ? ` at ${formatTime(at.seconds)}` : ''
  return `${at.title || 'where it was'}${time}`
}


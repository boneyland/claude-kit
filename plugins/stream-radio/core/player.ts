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
  plain,
  type PlayerEvent,
  repeatOf,
  splitEvents,
  trackTitle,
  WATCHED,
} from './nowplaying'
import { expandSource } from './expand'
import { isPlayable, listSongs, paths, type Paths } from './paths'
import { moveSteps } from './queue'
import { readSaved, updateSaved } from './saved'
import {
  addEntries,
  arrangementOff,
  EMPTY_QUEUE,
  moveShown,
  nameOf,
  NO_PLACE,
  played,
  removeIds,
  replaceWith,
  shuffleOn,
  sortShown,
  type Place,
  type QueueEntry,
  type StoredEntry,
  type StoredQueue,
} from './stored'
import {
  backUpAndEmpty,
  readPlace,
  readStored,
  releaseFileLock,
  restorePrev,
  takeFileLock,
  updateStored,
  writePlace,
  writeWhole,
} from './storedFile'

export type PlayerConfig = { volume: number; player: string; androidClient: boolean }

// Nothing to pick from.
export const NO_QUEUE: Queue = { kind: 'none', items: [], current: -1, paths: [], root: '' }

// Where the last URL got to: its playlist entry (-1 when it has no playlist) and
// the seconds into it (-1 for a live stream), with the song's title, so playing
// the last URL again after a stop resumes there.
export const NO_RESUME: Resume = { url: '', index: -1, seconds: -1, title: '' }
// The volume as last set, the player's from the start; kept in saved state with
// the Volume setting each program set it under, so a changed setting wins again
// for the program it changed in.
export async function loadVolume(h: Host, configured: number) {
  const saved = (await readSaved(h)).volume
  const value = saved && saved.configured[h.program] === configured ? saved.value : configured
  await h.vars.change('volume', () => clampVolume(value))
}

// Sets the volume, of the playing player too; resolves to the reply to show.
export async function setVolume(h: Host, configured: number, level: number): Promise<string> {
  const to = clampVolume(level)
  await h.vars.change('volume', () => to)
  await updateSaved(h, s => ({ ...s, volume: { value: to, configured: { ...s.volume?.configured, [h.program]: configured } } }))
  if (control && !(await mpv(h, ['set_property', 'volume', to]))) return `Volume ${to}%; the player is not ready yet.`
  return `Volume ${to}%.`
}

// Repeat: kept in saved state as a preference.
export async function loadRepeat(h: Host) {
  const saved = (await readSaved(h)).repeat
  if (saved) await h.vars.change('repeat', () => saved)
}

// Sets repeat, of the playing player too; resolves to the reply to show.
export async function setRepeat(h: Host, mode: Repeat): Promise<string> {
  await h.vars.change('repeat', () => mode)
  await updateSaved(h, s => ({ ...s, repeat: mode }))
  const loops = loopsFor(mode)
  if (control) {
    // In an order where what mpv tells between the two is the old mode or the
    // new one: loop-file off first left one → off showing all for a moment.
    const file = ['set_property', 'loop-file', loops.file]
    const playlist = ['set_property', 'loop-playlist', loops.playlist]
    settingRepeat = { mode, until: (await h.now().catch(() => 0)) + SETTING_REPEAT_MS }
    for (const command of mode === 'one' ? [file, playlist] : [playlist, file]) {
      if (!(await mpv(h, command))) settingRepeat = undefined
    }
  }
  return mode === 'all' ? 'Repeat: the whole playlist.' : mode === 'one' ? 'Repeat: this song.' : 'Repeat off: playback ends after the last song.'
}

export const SAVE_MS = 10_000
let savedAt = 0

// Where the queue got to, as this session last saw it: the entry playing and
// the seconds into it. Written to queue-place.json at song changes, at stop and
// every SAVE_MS while playing; nothing until this session knows the entry.
let place: Place = NO_PLACE
// mpv's position and path the place was last matched to, so a position that
// did not move is not looked up again.
let placedAt: { pos: number; path: string } | undefined

export async function savePlace(h: Host, isNow = false) {
  const now = await h.now().catch(() => 0)
  if (!isNow && now - savedAt < SAVE_MS) return
  savedAt = now
  if (place.current === null) return
  await writePlace(h, place).catch(() => undefined)
}

// What an earlier version saved: no queue.json yet, but state.json has the last
// URL played. A local one (a folder, a playlist file, an edited queue.m3u) is
// expanded; a URL stays one entry, as mpv expands it while it plays. The place
// is its song by path, else by index, at the seconds it got to. Done once:
// nothing coming of it still writes the (empty) queue.
export function migrateLast(h: Host): Promise<void> {
  migrating = migrate(h)
  return migrating
}

// A resume waits for a migration still running (programs run it in the
// background), so it plays the queue made from what was saved.
let migrating: Promise<void> | undefined

async function migrate(h: Host) {
  if (await h.fs.exists((await paths(h)).queueJson).catch(() => true)) return
  const last = (await readSaved(h)).last
  if (!last) return
  const { url, resumeAt: at } = last
  // A URL without a playlist (index -1) was resumed as itself: its title names it.
  const one = at.url === url && at.index < 0 && at.title ? { path: url, title: at.title } : { path: url }
  const { entries, root } = /^https?:/.test(url)
    ? { entries: [one], root: '' }
    : await expandSource(h, url).catch(() => ({ entries: [] as QueueEntry[], root: '' }))
  // Nothing came of it (a folder gone, say): the empty queue is written, so a
  // later start does not try again.
  const q = await updateStored(h, q =>
    q.entries.length || q.rev > 0 ? q : entries.length ? replaceWith(q, entries, url, root) : { ...q, rev: q.rev + 1 },
  )
  if (q === 'busy' || !entries.length || q.source !== url || at.url !== url) return
  const shown = played(q)
  const byPath = at.path ? shown.find(e => e.path === at.path) : undefined
  const e = byPath ?? shown[Math.max(0, at.index)]
  if (e) await writePlace(h, { rev: q.rev, current: e.id, seconds: at.seconds }).catch(() => undefined)
}

// The queue as its files have it, into what is drawn: the list (while no
// player is followed: a followed one tells its own, with a video's chapters),
// the source as the last URL, the place as where it resumes, and the shuffle.
export async function refreshFromStored(h: Host) {
  const q = await readStored(h)
  const at = await readPlace(h)
  const shown = played(q)
  const index = at.current === null ? -1 : shown.findIndex(e => e.id === at.current)
  const e = shown[index]
  await h.vars.change('lastUrl', () => q.source)
  await h.vars.change('resumeAt', was => {
    if (!e) return q.source ? { ...NO_RESUME, url: q.source } : NO_RESUME
    // the title mpv told for the same song beats its file name
    const title = (was.url === q.source && was.path === e.path && was.title) || plain(nameOf(e))
    return { url: q.source, index, seconds: at.seconds, title, path: e.path }
  })
  await h.vars.change('isShuffled', () => q.arrangement.kind === 'shuffle')
  if (control) return
  const before = await h.vars.read('queue')
  const next: Queue = shown.length
    ? {
        kind: 'playlist',
        items: await namesOf(h, shown, q.root),
        current: index,
        paths: shown.map(x => x.path),
        root: q.root,
      }
    : NO_QUEUE
  await showQueue(h, before, next)
}

// Folder looks (a stat each) one refresh makes at most, a few at a time: past
// that, an entry shows its file name.
const FOLDER_LOOKS = 200
const LOOKS_AT_ONCE = 8

// What the stored entries are listed as (entryName), with the folder looks bounded.
async function namesOf(h: Host, shown: readonly { path: string; title?: string }[], root: string): Promise<string[]> {
  const names: string[] = []
  let looks = 0
  for (let i = 0; i < shown.length; i += LOOKS_AT_ONCE) {
    const part = shown.slice(i, i + LOOKS_AT_ONCE).map(x => {
      const e = { filename: x.path, title: x.title }
      if (looks >= FOLDER_LOOKS || !needsLook(e, root)) return Promise.resolve(entryName(h, e, root, false))
      looks += 1
      return entryName(h, e, root)
    })
    names.push(...(await Promise.all(part)))
  }
  return names
}

// A default stream changed since this program last started is only recorded:
// it never touches the queue.
export async function checkDefault(h: Host, defaultUrl: string) {
  const known = (await readSaved(h)).knownDefault[h.program]
  if (known === defaultUrl) return
  await updateSaved(h, s => ({ ...s, knownDefault: { ...s.knownDefault, [h.program]: defaultUrl } }))
}

// Closer to a song's start than this, it resumes at the start.
export const RESUME_MIN_SECONDS = 5




// The player's files: core/paths.ts.
export { paths, type Paths }

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
// What was last asked of this session (a play, a start or a stop): a play
// still expanding what it plays is dropped once something newer was asked.
let asked = 0
let isStarting = false
// What this session started and waits to hear has played: on a player that
// ends before that, this session says why (or retries with the android client).
let started: Launch | undefined
// Where to be once what this session started has loaded: the entry (by its
// path at that index of the played order) and the seconds to seek to.
type Pending = { index: number; path: string; seconds: number }
let pending: Pending | undefined
// The repeat mode this session is setting, shown at once: what mpv tells
// between its two loop properties is not shown over it, until mpv tells this
// mode or SETTING_REPEAT_MS pass.
let settingRepeat: { mode: Repeat; until: number } | undefined
const SETTING_REPEAT_MS = 2000
// Whether this session is reordering the playlist: its moves are not read one by one.
let isReordering = false
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


// Back to showing nothing playing; the queue stays.
export async function goIdle(h: Host) {
  h.events.watching(false)
  await h.vars.change('playing', () => '')
  await h.vars.change('isPaused', () => false)
  await h.vars.change('elapsed', () => -1)
  await h.vars.change('chapter', () => '')
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
        if (!control && !isStarting) follow(h, config, p.sock, (await readIntent(h))?.id ?? '')
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

// Follows a player another session started: where it is in the queue is
// learned from it, not kept from this session's own last start.
function follow(h: Host, config: PlayerConfig, sock: string, id: string) {
  place = NO_PLACE
  placedAt = undefined
  attach(h, config, sock, id)
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
      // this session's reorder reads the list once it is done
      if (seen.isLoaded && !isReordering) {
        await refreshQueue(h)
        await notePlace(h)
      }
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
        // this session's own change half made: the mode it shows already stays
        if (settingRepeat && mode !== settingRepeat.mode && (await h.now().catch(() => 0)) < settingRepeat.until) return
        settingRepeat = undefined
        await h.vars.change('repeat', () => mode)
      }
      return
    }
    case 'user-data/stream-radio/url':
      seen.url = typeof data === 'string' ? data : ''
      if (seen.isLoaded) await markLoaded(h)
      return
    case 'user-data/stream-radio/edited':
      // the queue's file changed (a shuffle, say): what it says is read again too
      if (seen.isLoaded) await refreshQueue(h, { isReordered: true })
      await refreshFromStored(h)
      return
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
  if (started && intent?.id === started.id && !intent.playedAt) {
    const now = await h.now().catch(() => 0)
    await writeIntent(h, { ...intent, playedAt: now || 1 })
    if (started.client) needsAndroid.add(started.url)
    else needsAndroid.delete(started.url)
    await savePlace(h, true)
    await releaseLock(h)
  }
  if (pending) {
    const q = await h.vars.read('queue')
    // The entry by its path at that index, else wherever mpv has that path: mpv
    // may have started elsewhere or expanded an entry before it.
    const { index, path } = pending
    const target = q.paths[index] === path ? index : q.paths.indexOf(path)
    if (q.kind === 'playlist' && target >= 0 && q.current !== target) {
      // The jump loads another file; its file-loaded comes back through here.
      if (!(await mpv(h, ['playlist-play-index', target]))) pending = undefined
      return
    }
    if (pending.seconds >= RESUME_MIN_SECONDS) await mpv(h, ['seek', pending.seconds, 'absolute'])
    pending = undefined
  }
  await notePlace(h)
}

// The stored entry mpv plays now becomes the place's current one, written at
// once: the one at mpv's position in the played order when its path is the
// same, else the first with that path. Not while a resume point is still being
// reached, and not for a song the queue does not have.
async function notePlace(h: Host) {
  const q = await h.vars.read('queue')
  if (pending || q.kind !== 'playlist') return
  const path = q.paths[q.current]
  if (!path || (placedAt?.pos === q.current && placedAt.path === path)) return
  placedAt = { pos: q.current, path }
  const stored = await readStored(h)
  const shown = played(stored)
  const e = shown[q.current]?.path === path ? shown[q.current] : shown.find(x => x.path === path)
  if (!e || (e.id === place.current && stored.rev === place.rev)) return
  place = { rev: stored.rev, current: e.id, seconds: e.id === place.current ? place.seconds : 0 }
  await savePlace(h, true)
}

// Where the playing entry got to, for resuming it later; not while a resume
// point is still being reached, or the first song's start would overwrite it.
export async function recordPosition(h: Host, pos: number) {
  const url = await h.vars.read('lastUrl')
  const title = (await h.vars.read('chapter')) || (await h.vars.read('playing'))
  if (pending || !url || !title || title === 'connecting…') return
  const q = await h.vars.read('queue')
  const index = q.kind === 'playlist' ? q.current : -1
  const path = q.kind === 'playlist' ? q.paths[index] : undefined
  const was = await h.vars.read('resumeAt')
  if (was.url === url && was.index === index && was.seconds === pos && was.title === title && was.path === path) return
  await h.vars.change('resumeAt', () => ({ url, index, seconds: pos, title, ...(path ? { path } : {}) }))
  place = { ...place, seconds: pos }
  await savePlace(h, was.url !== url || was.index !== index || was.title !== title)
}

// The player this session followed went away. Stopped, replaced by a new start
// or ended on purpose: nothing more. Never played, and this session started
// it: say why. Dropped after playing: one session (whichever takes the lock)
// starts it again.
export async function onGone(h: Host, config: PlayerConfig, id: string) {
  const was = seen
  await savePlace(h, true)
  await goIdle(h)
  await refreshFromStored(h)
  startPoller(h, config)
  // The watcher ended but the player answers: the watcher was killed (as at
  // this session's exit), not the player. The poller follows it again.
  if (await probe(h)) return
  const intent = await readIntent(h)
  const mine = started && started.id === id ? started : undefined
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
// url: the queue's source; q and at: the queue started and where in it.
// isRetry: this start is already that second try.
export type At = { index: number; seconds: number }
export type Launch = { id: string; url: string; client?: string; q: StoredQueue; at: At; isRetry?: boolean }
export async function failed(h: Host, config: PlayerConfig, what: Launch, error: string) {
  started = undefined
  await releaseLock(h)
  const log = await h.fs
    .read((await paths(h)).log)
    .then(reason)
    .catch(() => '')
  const lastError = log || error
  if (!what.isRetry && /^https?:/.test(what.url)) {
    const other = what.client ? 'default' : 'android'
    h.log(`stream-radio: ${what.url} would not play; retrying with the ${other} client`)
    launch(h, config, what.q, what.at, what.client ? '' : 'android', 0, true)
    return
  }
  const why = lastError ? lastError.slice(0, 300) : 'the player exited before anything played; is the URL playable?'
  h.log(`stream-radio: could not play ${what.url}: ${why}`)
  h.toast(`stream failed: ${plain(why).slice(0, 120)}`)
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
  if (!(await takeFileLock(h, (await paths(h)).lock, LOCK_STALE_MS))) return false
  holdsLock = true
  return true
}

export async function releaseLock(h: Host) {
  if (!holdsLock) return
  holdsLock = false
  await releaseFileLock(h, (await paths(h)).lock)
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
  // from the queue at its place, as it is now
  const q = await readStored(h)
  if (!q.entries.length) return releaseLock(h)
  launch(h, config, q, placeIn(q, await readPlace(h)), intent.client, tries + 1)
}

// Where in `q` its place is: the shown index of its current entry and the
// seconds into it; the start when the entry is gone.
function placeIn(q: StoredQueue, at: Place): At {
  const index = at.current === null ? -1 : played(q).findIndex(e => e.id === at.current)
  return index < 0 ? { index: 0, seconds: 0 } : { index, seconds: at.seconds }
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

// Starts the one shared player on `q` at `at` (its index in the played order,
// and the seconds to seek to once loaded), replacing what it played: the played
// order is written to queue.m3u, the only thing mpv is handed. Returns at once:
// the first start after a reload is slow, and a hook that takes too long is
// reported as unanswered, so the startup runs in the background.
// `attempt`: how many reconnect tries came before this start.
// `retryClient`: the client to use whatever the settings say ('' the default).
// `isRetry`: the second try after a start that never played.
function launch(h: Host, config: PlayerConfig, q: StoredQueue, at: At, retryClient?: string, attempt = 0, isRetry = false) {
  const { player, androidClient } = config
  const shown = played(q)
  const entry = shown[at.index] ?? shown[0]
  if (!entry) return
  const index = shown.indexOf(entry)
  const url = q.source || entry.path
  // YouTube refuses the default client's stream URLs for some content (403);
  // the android client gets through, with muxed AAC and no audio-only Opus.
  const client = retryClient ?? (androidClient || needsAndroid.has(url) ? 'android' : undefined)
  detach()
  run += 1
  asked += 1
  const mine = run
  isStarting = true
  const seconds = index === at.index ? at.seconds : 0
  pending = index > 0 || seconds >= RESUME_MIN_SECONDS ? { index, path: entry.path, seconds } : undefined
  place = { rev: q.rev, current: entry.id, seconds }
  placedAt = undefined
  void (async () => {
    try {
      await h.vars.change('isPaused', () => false)
      await h.vars.change('elapsed', () => -1)
      await h.vars.change('chapter', () => '')
      await h.events.titleChanged()
      await h.vars.change('filter', () => '')
      await h.vars.change('playing', () => 'connecting…')
      h.events.watching(true)
      await savePlace(h, true)

      try {
        await h.run([player, '--version'], { timeoutMs: 5000 })
      } catch {
        h.events.watching(false)
        await h.vars.change('playing', () => '')
        h.toast(`Can't start "${player}". Install mpv (and yt-dlp for YouTube).`)
        await refreshFromStored(h)
        // detach() above let go of any player still playing; find it again.
        startPoller(h, config)
        return
      }
      if (mine !== run) return

      const p = await paths(h)
      const now = await h.now().catch(() => 0)
      const id = `${now}-${Math.random().toString(36).slice(2, 10)}`
      const what: Launch = { id, url, client, q, at: { index, seconds }, isRetry }
      started = what
      // Written first: the old player's watchers read it when it goes, and
      // know it was replaced rather than dropped.
      await writeIntent(h, { id, url, client: client ?? '', isStopped: false, attempt, playedAt: 0 })
      await endPlayer(h)
      if (mine !== run) return
      await h.run(['rm', '-f', p.sock]).catch(() => undefined)
      await writeWhole(h, p.queue, m3u(shown))

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
        // A local folder in the queue plays its sound and video files (sound
        // only), not its cover art or archives, which would each take a turn;
        // its subfolders are read at once, so the panel can show them whole.
        ...(/^https?:/.test(url) ? [] : ['--directory-filter-types=audio,video,playlist', '--directory-mode=recursive']),
        ...(client ? [`--ytdl-raw-options-append=extractor-args=youtube:player_client=${client}`] : []),
        `--volume=${await h.vars.read('volume')}`,
        '--msg-level=all=error',
        // the songs of the playlist file are the playlist; it starts at this one
        `--playlist-start=${index}`,
        `--playlist=${p.queue}`,
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
        await refreshFromStored(h)
        startPoller(h, config)
        await failed(h, config, what, '')
        return
      }
      // Every session learns from the player itself what plays and which
      // version of the queue it was handed.
      await ipc(h, p.sock, ['set_property', 'user-data/stream-radio/url', url])
      await ipc(h, p.sock, ['set_property', 'user-data/stream-radio/rev', q.rev])
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

// Plays `source` (a URL, a file, a folder, a playlist file or a YouTube
// playlist): expanded to its songs, they replace the queue, and the first plays.
// Resolves once the queue is written, to what to show about the expansion
// (a cap it hit) or ''; the player starts in the background.
export async function playSource(h: Host, config: PlayerConfig, source: string): Promise<string> {
  // a newer play or a stop while it expands wins
  const mine = ++asked
  const { entries, root, note } = await expandSource(h, source)
  if (mine !== asked) return note
  if (!entries.length) return note || `Nothing to play in ${source}.`
  return (await playNew(h, config, entries, source, root, mine)) || note
}

// `entries` replace the queue and the first plays; '' when started, else what
// to show. `mine`: what was asked that it answers; dropped once something
// newer was asked.
async function playNew(h: Host, config: PlayerConfig, entries: QueueEntry[], source: string, root: string, mine = asked): Promise<string> {
  const q = await updateStored(h, q => replaceWith(q, entries, source, root))
  if (q === 'busy') return 'The queue is busy; try again.'
  if (mine !== asked) return ''
  await writePlace(h, { rev: q.rev, current: played(q)[0]!.id, seconds: 0 }).catch(() => undefined)
  // launched first: it lets go of the player followed, whose list then gives
  // way to the new one
  launch(h, config, q, { index: 0, seconds: 0 })
  await refreshFromStored(h)
  return ''
}

// Plays entry `shownIndex` of the queue: playing, mpv jumps there (or to that
// chapter); stopped, the player starts on the queue at that entry, from 0:00.
export async function playAt(h: Host, config: PlayerConfig, shownIndex: number): Promise<string> {
  if (control) {
    const q = await h.vars.read('queue')
    if (q.kind === 'none') return 'Nothing to pick from.'
    const ok = await mpv(h, q.kind === 'playlist' ? ['playlist-play-index', shownIndex] : ['set_property', 'chapter', shownIndex])
    if (!ok) return 'The player is not ready yet.'
    await mpv(h, ['set_property', 'pause', false])
    await h.vars.change('queue', x => ({ ...x, current: shownIndex }))
    return ''
  }
  const q = await readStored(h)
  const e = played(q)[shownIndex]
  if (!e) return 'Nothing to pick from.'
  await writePlace(h, { rev: q.rev, current: e.id, seconds: 0 }).catch(() => undefined)
  launch(h, config, q, { index: shownIndex, seconds: 0 })
  await refreshFromStored(h)
  return ''
}

// Plays entry `index` of the queue, unpaused.
export const pick = playAt

// Starts the queue where it got to: its place's entry, sought to its seconds.
// An empty queue brings back the one last cleared, else plays `fallback` (the
// default stream). '' when started, else what to show.
export async function resumeQueue(h: Host, config: PlayerConfig, fallback: string): Promise<string> {
  await migrating?.catch(() => undefined)
  let q = await readStored(h)
  if (!q.entries.length) {
    if (!(await restorePrev(h))) return fallback ? playSource(h, config, fallback) : 'Nothing has played yet, and there is no default stream.'
    q = await readStored(h)
  }
  launch(h, config, q, placeIn(q, await readPlace(h)))
  await refreshFromStored(h)
  return ''
}

// Ends the shared player, for every session: marked stopped first, so none of
// them reconnects. The queue and its place stay, to play again.
export async function stopPlaying(h: Host, config: PlayerConfig) {
  // only what this session follows: its place from an earlier play is stale
  if (control) await savePlace(h, true)
  run += 1
  asked += 1
  isStarting = false
  started = undefined
  pending = undefined
  const intent = await readIntent(h)
  await writeIntent(h, { ...(intent ?? { id: '', url: '', client: '', attempt: 0, playedAt: 0 }), isStopped: true })
  detach()
  await endPlayer(h)
  await releaseLock(h)
  await goIdle(h)
  await refreshFromStored(h)
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
      if (!control && !isStarting) follow(h, config, (await paths(h)).sock, (await readIntent(h))?.id ?? '')
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
// subfolder already, so an entry there is a file and needs no look; nor does a
// name with a playable file's extension. mayLook false: a path not looked at
// yet shows its name.
// Whether an entry's path might be a folder, to be looked at: a local path
// outside `root` whose name is not a playable file's.
const needsLook = (e: { filename?: string }, root: string): boolean =>
  !!e.filename && e.filename.startsWith('/') && !(root && e.filename.startsWith(`${root}/`)) && !isPlayable(baseName(e.filename))

export async function entryName(h: Host, e: { filename?: string; title?: string }, root: string, mayLook = true): Promise<string> {
  if (e.title) return plain(e.title)
  if (!e.filename) return '?'
  const name = plain(baseName(e.filename))
  if (!needsLook(e, root)) return name
  let folder = isFolder.get(e.filename)
  if (folder === undefined && !mayLook) return name
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
  await showQueue(h, before, await readQueue(h, before, how))
}

// The list to draw, after `before`.
async function showQueue(h: Host, before: Queue, next: Queue) {
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
  // One file with chapters lists them; one without is a playlist of one.
  const chapterList = seen.count === 1 ? (await mpv(h, ['get_property', 'chapter-list']))?.data : undefined
  const hasChapters = Array.isArray(chapterList) && chapterList.length > 1
  if (seen.count > 1 || (seen.count === 1 && !hasChapters)) {
    if (!how.isReordered && before.kind === 'playlist' && before.items.length === seen.count && (await isSameAt(h, before, seen.pos))) {
      return { ...before, current: seen.pos }
    }
    const entries = await playlistOf(h)
    // mpv slow to answer (it was busy) is not an empty playlist: keep the last one read
    if (!entries) return before.kind === 'playlist' ? { ...before, current: seen.pos } : NO_QUEUE
    if (entries.length < 1) return NO_QUEUE
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
    items: (chapters as { title?: unknown }[]).map((c, i) => (typeof c.title === 'string' && plain(c.title)) || `Chapter ${i + 1}`),
    current: typeof at === 'number' ? at : seen.chapter,
    paths: [],
    root: '',
  }
}

// Whether the list last read still has, at `pos`, the song mpv has there. A
// sort keeps the length, and a position that comes after it (late, or with the
// counts between missed) taken against the old list showed another song, and
// its art and waveform, until the list was read again. Unanswered: trusted.
async function isSameAt(h: Host, before: Queue, pos: number): Promise<boolean> {
  if (pos < 0 || pos >= before.paths.length) return true
  const file = (await mpv(h, ['get_property', `playlist/${pos}/filename`]))?.data
  return typeof file !== 'string' || file === before.paths[pos]
}

// The next or previous playlist entry, else chapter.
export async function step(h: Host, by: 1 | -1): Promise<string> {
  const q = await h.vars.read('queue')
  if (q.kind === 'none') return 'Nothing before or after this.'
  const command = q.kind === 'playlist' ? [by > 0 ? 'playlist-next' : 'playlist-prev'] : ['add', 'chapter', by]
  return (await mpv(h, command)) ? '' : 'The player is not ready yet.'
}

// Jumps the playing file to `seconds`, or with isRelative that far from where
// it is (back when negative), kept within it: a second short of the end, since
// a seek to the very end would skip to the next song. A relative jump counts
// from mpv's own position, not `elapsed`, which is cut to whole seconds and
// would make a 10-second jump anything from 9 to 11. The time and the resume
// point follow at once, so a quit just after resumes from there. '' when done,
// else what to show.
export async function seek(h: Host, seconds: number, isRelative = false): Promise<string> {
  const elapsed = await h.vars.read('elapsed')
  if (elapsed < 0) return 'Nothing to seek in.'
  const at = isRelative ? (await mpv(h, ['get_property', 'time-pos']))?.data : undefined
  const target = isRelative ? (typeof at === 'number' ? at : elapsed) + seconds : seconds
  const length = (await mpv(h, ['get_property', 'duration']))?.data
  const to = Math.max(0, typeof length === 'number' ? Math.min(target, length - 1) : target)
  if (!(await mpv(h, ['seek', to, 'absolute']))) return 'The player is not ready yet.'
  await h.vars.change('elapsed', () => Math.trunc(to))
  await recordPosition(h, Math.trunc(to))
  return ''
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

// Where playing `url` again picks up, as `Song name at 1:20`; empty when it
// starts at the beginning.
export function resumable(at: Resume, url: string): string {
  if (at.url !== url || (at.index <= 0 && at.seconds < RESUME_MIN_SECONDS)) return ''
  const time = at.seconds >= RESUME_MIN_SECONDS ? ` at ${formatTime(at.seconds)}` : ''
  return `${at.title || 'where it was'}${time}`
}


// Tells every session following the player that its queue was edited.
export async function markEdited(h: Host) {
  const was = (await mpv(h, ['get_property', 'user-data/stream-radio/edited']))?.data
  await mpv(h, ['set_property', 'user-data/stream-radio/edited', (typeof was === 'number' ? was : 0) + 1])
}

// One thing to add to the queue: a file, a folder (its songs are added), or an
// http(s) URL; title names a URL's entry. Defined with the stored queue.
export type { QueueEntry }

// A folder becomes its songs; a file or URL stays as it is.
async function expand(h: Host, entries: readonly QueueEntry[]): Promise<QueueEntry[]> {
  const out: QueueEntry[] = []
  for (const e of entries) {
    const isDir = !/^https?:/.test(e.path) && (await h.fs.stat(e.path).catch(() => undefined))?.kind === 'dir'
    if (isDir) out.push(...(await listSongs(h, e.path)).map(path => ({ path })))
    else out.push(e)
  }
  return out
}

const m3u = (entries: readonly QueueEntry[]) =>
  `#EXTM3U\n${entries.map(e => `${e.title ? `#EXTINF:-1,${e.title.replace(/\n/g, ' ')}\n` : ''}${e.path}\n`).join('')}`

type Entry = { filename?: string; title?: string; current?: boolean }
// The player's playlist; undefined when mpv did not answer.
async function playlistOf(h: Host): Promise<Entry[] | undefined> {
  const list = (await mpv(h, ['get_property', 'playlist']))?.data
  return Array.isArray(list) ? (list as Entry[]) : undefined
}
const entriesOf = (list: readonly Entry[]): QueueEntry[] => list.filter(e => e.filename).map(e => ({ path: e.filename!, title: e.title }))

// --- Edits: every one goes to the queue's file first, playing or stopped; a
// player followed is then brought to the new played order, the song playing
// playing on. Indexes come in the shown order, as the `queue` var lists them,
// and are taken to entries in the queue as read under the lock.

const BUSY = 'The queue is busy; try again.'
const STALE = 'The queue changed meanwhile; try again.'

// The entry the queue is at: this session's place while it follows a player
// and knows it, else the one saved.
async function currentId(h: Host): Promise<string | null> {
  return control && place.current !== null ? place.current : (await readPlace(h)).current
}

// `fn` over the stored queue under the lock, then the place, mpv and every
// session follow. '' when done, `unchanged` when `fn` changed nothing, else
// what to show.
async function edit(h: Host, fn: (q: StoredQueue) => StoredQueue, unchanged = ''): Promise<string> {
  let was: StoredQueue = EMPTY_QUEUE
  const q = await updateStored(h, x => ((was = x), fn(x))).catch(() => undefined)
  if (q === 'busy') return BUSY
  if (!q) return 'Could not save the queue.'
  if (q.rev === was.rev) return unchanged
  await movePlace(h, was, q)
  if (control) {
    // mpv's list not brought along (it was not the stored one) keeps its old
    // rev, to be rebuilt from the file
    if (await syncPlayer(h, played(was), played(q))) await mpv(h, ['set_property', 'user-data/stream-radio/rev', q.rev])
    await markEdited(h)
    await refreshQueue(h, { isReordered: true })
  }
  await refreshFromStored(h)
  return ''
}

// The place after an edit: on the same entry, else (it went) on the next one
// still there, from its start; mpv plays that one next too.
async function movePlace(h: Host, was: StoredQueue, q: StoredQueue) {
  const at = control && place.current !== null ? place : await readPlace(h)
  if (at.current === null) return
  const kept = new Set(q.entries.map(e => e.id))
  let next: Place = { ...at, rev: q.rev }
  if (!kept.has(at.current)) {
    const before = played(was)
    const from = before.findIndex(e => e.id === at.current)
    const e = before.slice(from + 1).find(x => kept.has(x.id)) ?? played(q)[0]
    if (!e) return
    next = { rev: q.rev, current: e.id, seconds: 0 }
  }
  if (control) {
    place = next
    placedAt = undefined
  }
  await writePlace(h, next).catch(() => undefined)
}

// Brings mpv's list from the played order `from` to `to`: the entries gone
// removed (the song playing among them: mpv plays the next), the new ones
// loaded in one list where they go, then the moves, a few one by one, else a
// rebuild around the song playing. Never a jump: the song playing plays on.
// false, and mpv left as it is, when its list is not `from` (it expanded an
// entry, or the edit came between) or it stopped answering.
async function syncPlayer(h: Host, from: readonly StoredEntry[], to: readonly StoredEntry[]): Promise<boolean> {
  if (seen.count !== from.length) return false
  isReordering = true
  try {
    const keep = new Set(to.map(e => e.id))
    const list = from.map(e => e.id)
    // the highest first, so the indexes below stay put
    for (let i = list.length - 1; i >= 0; i--) {
      if (keep.has(list[i]!)) continue
      if (!(await mpv(h, ['playlist-remove', i]))) return false
      list.splice(i, 1)
    }
    const had = new Set(list)
    const added = to.filter(e => !had.has(e.id))
    if (added.length) {
      const first = to.indexOf(added[0]!)
      const at = first > 0 ? list.indexOf(to[first - 1]!.id) + 1 : 0
      if (!(await loadAt(h, added, at, list.length))) return false
      list.splice(at, 0, ...added.map(e => e.id))
    }
    const order = to.map(e => list.indexOf(e.id))
    const steps = moveSteps(order)
    if (steps.length && (steps.length <= FEW_MOVES ? await moveEach(h, steps) : await rebuild(h, order))) return false
    seen.count = to.length
    return true
  } finally {
    isReordering = false
  }
}

// `songs` into mpv's list of `count` at `at`, in one list: a loadfile per song
// made a folder trickle in, every session reading the queue again after each.
async function loadAt(h: Host, songs: readonly QueueEntry[], at: number, count: number): Promise<boolean> {
  const file = `${(await paths(h)).queue}.add`
  await h.fs.write(file, m3u(songs))
  if (at >= count) return !!(await mpv(h, ['loadlist', file, 'append']))
  if (await mpv(h, ['loadlist', file, 'insert-at', at])) return true
  // insert-at needs mpv 0.38; an older one appends, and the songs move up one by one
  if (!(await mpv(h, ['loadlist', file, 'append']))) return false
  for (let i = 0; i < songs.length; i++) if (!(await mpv(h, ['playlist-move', count + i, at + i]))) return false
  return true
}

// Adds to the end of the queue, or to play next (after the current song, in
// the order given). Nothing queued and nothing playing: what is added becomes
// the queue, and it plays. '' when done, else what to show.
export async function addToQueue(h: Host, config: PlayerConfig, entries: readonly QueueEntry[], where: 'end' | 'next'): Promise<string> {
  const songs = await expand(h, entries)
  if (!songs.length) return 'Nothing to add.'
  const current = await currentId(h)
  const was = { isEmpty: false }
  const reply = await edit(h, q => {
    was.isEmpty = !q.entries.length && !control
    return was.isEmpty ? q : addEntries(q, songs, where, current)
  })
  if (reply || !was.isEmpty) return reply
  return playNew(h, config, songs, (await paths(h)).queue, '')
}

// Up to this many moves go one by one; more (a sort) rebuild the list.
const FEW_MOVES = 8

async function moveEach(h: Host, steps: readonly [number, number][]): Promise<string> {
  for (const [j, i] of steps) if (!(await mpv(h, ['playlist-move', j, i]))) return 'The player is not ready yet.'
  return ''
}

// The playlist rebuilt in `order` in a few commands, not a move per entry: a
// sort of hundreds of songs moved the playing one at each step, and every
// session following the player showed (and fetched art and a waveform for) a
// different song each time. Everything but the playing song is cleared, the
// songs before it loaded and it moved after them, then the songs after it.
async function rebuild(h: Host, order: readonly number[]): Promise<string> {
  const list = await playlistOf(h)
  if (!list) return 'The player is not ready yet.'
  if (list.length !== order.length) return STALE
  const playing = list.findIndex(e => e.current)
  // nothing playing: playlist-clear would empty it, so move one by one
  if (playing < 0) return moveEach(h, moveSteps(order))
  const at = order.indexOf(playing)
  const before = entriesOf(order.slice(0, at).map(i => list[i]!))
  const after = entriesOf(order.slice(at + 1).map(i => list[i]!))
  const file = `${(await paths(h)).queue}.part`
  const load = async (entries: readonly QueueEntry[]) => {
    await h.fs.write(file, m3u(entries))
    return mpv(h, ['loadlist', file, 'append'])
  }
  if (!(await mpv(h, ['playlist-clear']))) return 'The player is not ready yet.'
  if (before.length && (!(await load(before)) || !(await mpv(h, ['playlist-move', 0, before.length + 1])))) return 'The player stopped answering mid-sort.'
  if (after.length && !(await load(after))) return 'The player stopped answering mid-sort.'
  return ''
}

// A hand move: the shown list put in `order` (order[i]: the row now at i)
// becomes the queued order, and a shuffle or sort goes off.
export async function reorderQueue(h: Host, order: readonly number[]): Promise<string> {
  if (!moveSteps(order).length) return ''
  return edit(h, q => moveShown(q, order), STALE)
}

// Sorted by `field`: `order` over the shown list (the caller reads the tags).
export async function sortQueue(h: Host, field: string, isReversed: boolean, order: readonly number[]): Promise<string> {
  return edit(h, q => sortShown(q, field, isReversed, order), STALE)
}

// Back to the queued order, from a sort or a shuffle.
export async function unsortQueue(h: Host): Promise<string> {
  return edit(h, q => (q.arrangement.kind === 'none' ? q : arrangementOff(q)))
}

// Shuffles the queue (the current song first), or puts it back in the queued
// order; playing or stopped.
export async function toggleShuffle(h: Host): Promise<string> {
  const current = await currentId(h)
  const was = { isOn: false }
  const reply = await edit(
    h,
    q => {
      was.isOn = q.arrangement.kind === 'shuffle'
      if (!was.isOn && q.entries.length < 2) return q
      return was.isOn ? arrangementOff(q) : shuffleOn(q, current, Math.random)
    },
    'Nothing to shuffle.',
  )
  return reply || (was.isOn ? 'Back in order.' : 'Shuffled.')
}

// Takes entries out of the queue; the current one going, the next is current
// (playing: mpv plays it). Every one going clears the queue.
export async function removeFromQueue(h: Host, config: PlayerConfig, shownIndexes: readonly number[]): Promise<string> {
  const going = [...new Set(shownIndexes)].filter(i => Number.isInteger(i) && i >= 0)
  if (!going.length) return 'Nothing to remove.'
  const all = { isAll: false }
  const reply = await edit(h, q => {
    const shown = played(q)
    const ids = going.flatMap(i => (shown[i] ? [shown[i].id] : []))
    all.isAll = ids.length > 0 && ids.length === shown.length
    return all.isAll ? q : removeIds(q, ids)
  }, 'Nothing to remove.')
  return all.isAll ? clearQueue(h, config) : reply
}

// Stops the player and empties the queue; the queue cleared is kept, for `l`
// to bring back.
export async function clearQueue(h: Host, config: PlayerConfig): Promise<string> {
  const done = await backUpAndEmpty(h).catch(() => 'failed' as const)
  if (done === 'busy') return BUSY
  if (done === 'failed') return 'Could not save the queue.'
  await stopPlaying(h, config)
  return 'Cleared the playlist. l brings it back.'
}

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
import { expandSource, isListedUrl, isNetwork, MAX_SONGS, videoOf } from './expand'
import { installHistoryScript } from './history'
import { isPlayable, paths, type Paths } from './paths'
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
  replaceEntry,
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
  updateStoredWith,
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
  return mode === 'all' ? 'Repeat: the whole queue.' : mode === 'one' ? 'Repeat: this song.' : 'Repeat off: playback ends after the last song.'
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
  // A playlist URL is listed (as a play lists it), so the saved song in it is
  // found again; any other URL is the one entry.
  const { entries, root } = /^https?:/.test(url) && !isListedUrl(url)
    ? { entries: [one], root: '' }
    : await expandSource(h, url).catch(() => ({ entries: [] as QueueEntry[], root: '' }))
  // Nothing came of it (a folder gone, say): the empty queue is written, so a
  // later start does not try again.
  const q = await updateStored(h, q =>
    q.entries.length || q.rev > 0 ? q : entries.length ? replaceWith(q, entries, url, root) : { ...q, rev: q.rev + 1 },
  )
  if (q === 'busy' || !entries.length || q.source !== url || at.url !== url) return
  const shown = played(q)
  // mpv may name a YouTube video otherwise than the listing does: by its id
  const video = at.path ? videoOf(at.path) : ''
  const byPath = at.path ? (shown.find(e => e.path === at.path) ?? (video ? shown.find(e => videoOf(e.path) === video) : undefined)) : undefined
  const e = byPath ?? shown[Math.max(0, at.index)]
  if (e) await writePlace(h, { rev: q.rev, current: e.id, seconds: at.seconds }).catch(() => undefined)
}

// The queue's list as last read from its file, named for drawing: what the
// `queue` var lists, stopped or playing (mpv only tells where it is, and a
// video's chapters).
type Listed = { rev: number; ids: string[]; paths: string[]; items: string[]; root: string }
let listed: Listed = { rev: -1, ids: [], paths: [], items: [], root: '' }

// The queue as its files have it, into what is drawn: the list, the source as
// the last URL, the place as where it resumes, and the shuffle. Following a
// player, mpv's position marks the current entry and mpv is checked against
// the file. A refresh overtaken by a newer one (it lists slowly: folder looks)
// shows nothing and waits for that one, so an older read never lands last.
export function refreshFromStored(h: Host): Promise<void> {
  const mine = ++refreshes
  const done = (async (): Promise<void> => {
    const q = await readStored(h)
    const at = await readPlace(h)
    const shown = played(q)
    const items = await namesOf(h, shown, q.root)
    if (mine !== refreshes) return lastRefresh
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
    if (mine !== refreshes) return lastRefresh
    listed = { rev: q.rev, ids: shown.map(x => x.id), paths: shown.map(x => x.path), items, root: q.root }
    if (control) {
      await refreshQueue(h, { isNewFile: true })
      checkSoon(h)
      return
    }
    const before = await h.vars.read('queue')
    if (mine !== refreshes) return lastRefresh
    await showQueue(h, before, shown.length ? { kind: 'playlist', items, current: index, paths: listed.paths, root: q.root } : NO_QUEUE)
  })()
  lastRefresh = done
  return done
}
let refreshes = 0
let lastRefresh: Promise<void> = Promise.resolve()

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
// jumped: mpv was already sent there once; landing elsewhere again means that
// entry would not load (mpv went on past it), and the jump is given up.
type Pending = { index: number; path: string; seconds: number; jumped?: boolean }
let pending: Pending | undefined
// The repeat mode this session is setting, shown at once: what mpv tells
// between its two loop properties is not shown over it, until mpv tells this
// mode or SETTING_REPEAT_MS pass.
let settingRepeat: { mode: Repeat; until: number } | undefined
const SETTING_REPEAT_MS = 2000
// Whether this session is reordering the queue: its moves are not read one
// by one. Edits run one at a time (edit), so one flag is enough.
let isReordering = false
// The Intent id of the player followed: another means a new start is under
// way, and mpv is not checked against the file meanwhile.
let followedId = ''
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
  // the queue's rev mpv's list was last brought to (user-data/stream-radio/rev)
  rev: unknown
  // the file mpv has at `pos`, as last asked; undefined when it did not say
  posPath: unknown
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
  rev: undefined,
  posPath: undefined,
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
// (no process: a stat) finds one another session started, and at the queue's
// files (a stat each) finds another program's edit, read only then.
export const POLL_MS = 3000
// The queue's files' times at the last look; a change is read.
let storedTimes = ''

export function startPoller(h: Host, config: PlayerConfig) {
  if (poller) return
  poller = h.every(POLL_MS, () => {
    if (control || isStarting || isPolling) return
    isPolling = true
    void (async () => {
      const p = await paths(h)
      const times = await Promise.all([p.queueJson, p.place].map(f => h.fs.stat(f).then(st => st.mtimeMs, () => -1)))
      if (times.join() !== storedTimes) {
        storedTimes = times.join()
        await refreshFromStored(h)
      }
      if (control || isStarting) return
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
  followedId = id
  triedOn = ''
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
        await notePosPath(h)
        await refreshQueue(h)
        await notePlace(h)
        // a count the file does not have (mpv expanded an entry, or is
        // behind), or a song left first by a mend that has now played
        checkSoon(h)
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
    case 'user-data/stream-radio/rev':
    case 'user-data/stream-radio/edited':
      // the queue's file changed (a shuffle, say), or mpv was brought to it:
      // the file is read again, and mpv checked against it
      if (name === 'user-data/stream-radio/rev') {
        const isKnown = data === seen.rev && data === listed.rev
        seen.rev = data
        if (seen.isLoaded) await notePosPath(h)
        // this session's own edit, whose queue it has read already: only
        // where mpv is in it is drawn again
        if (isKnown) {
          await refreshQueue(h)
          return
        }
      }
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
  // a player that told no rev yet (its watcher's first values) is asked
  if (seen.rev === undefined) seen.rev = await mpvRev(h)
  await notePosPath(h)
  await refreshFromStored(h).catch(() => undefined)
  const intent = await readIntent(h)
  if (started && intent?.id === started.id && !intent.playedAt) {
    const now = await h.now().catch(() => 0)
    await writeIntent(h, { ...intent, playedAt: now || 1 })
    if (started.client) needsAndroid.add(started.url)
    else needsAndroid.delete(started.url)
    await savePlace(h, true)
    await releaseLock(h)
  }
  const wait = pending
  if (wait) {
    const q = await h.vars.read('queue')
    // The entry by its path at that index, else wherever mpv has that path: mpv
    // may have started elsewhere or expanded an entry before it.
    const target = q.paths[wait.index] === wait.path ? wait.index : q.paths.indexOf(wait.path)
    // mpv's own position, asked (its change may come after this event): the
    // list shown may not be in step with it yet
    const told = (await mpv(h, ['get_property', 'playlist-pos']))?.data
    const pos = typeof told === 'number' ? told : seen.pos
    // a new start or a stop meanwhile has its own (or none)
    if (pending !== wait) return
    if (q.kind === 'playlist' && target >= 0 && pos !== target && !wait.jumped) {
      // The jump loads another file; its file-loaded comes back through here.
      // Once only: landing elsewhere again means that entry would not load.
      wait.jumped = true
      if (!(await mpv(h, ['playlist-play-index', target])) && pending === wait) pending = undefined
      return
    }
    // jumped there and mpv went on past it: where mpv plays now stands, from its start
    const isLost = wait.jumped && pos !== target
    if (!isLost && wait.seconds >= RESUME_MIN_SECONDS) await mpv(h, ['seek', wait.seconds, 'absolute'])
    if (pending === wait) pending = undefined
  }
  await notePlace(h)
}

// The stored entry mpv plays now becomes the place's current one, written at
// once: the one at mpv's position in the played order when its path is the
// same, else the first with that path. Not while a resume point is still being
// reached, and not for a song the queue does not have.
async function notePlace(h: Host) {
  const q = await h.vars.read('queue')
  // out of step, mpv's position may be of another list (another session's
  // sort, its moves seen before its rev): nothing is taken from it
  if (pending || q.kind !== 'playlist' || !inStep()) return
  const path = q.paths[q.current]
  if (!path || (placedAt?.pos === q.current && placedAt.path === path)) return
  const stored = await readStored(h)
  if (stored.rev !== listed.rev) return
  placedAt = { pos: q.current, path }
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
  if (pending || !url || !title || title === CONNECTING || title === LOADING) return
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
  // Replaced by another start (another session's): the place is that start's
  // queue's now, and this session's is of the player that went.
  const before = await readIntent(h)
  if (!before || before.id === id) await savePlace(h, true)
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
  if (!q.entries.length) {
    // emptied while it waited: nothing to start, and nothing to wait for
    await h.vars.change('playing', () => '')
    return releaseLock(h)
  }
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
      await h.vars.change('playing', () => CONNECTING)
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
      try {
        await writeWhole(h, p.queue, m3u(shown))
      } catch (error) {
        // nothing plays now (the old player is gone): say why, as for a player
        // that would not start, and find any player again
        if (mine !== run) return
        isStarting = false
        started = undefined
        // stopped, so no session reconnects to a player that never was
        await writeIntent(h, { id, url, client: client ?? '', isStopped: true, attempt, playedAt: 0 }).catch(() => undefined)
        await releaseLock(h)
        await goIdle(h)
        await refreshFromStored(h)
        startPoller(h, config)
        const why = error instanceof Error ? error.message : String(error)
        h.log(`stream-radio: could not write the queue file: ${why}`)
        h.toast(`stream failed: could not write the queue file${why ? ` (${plain(why).slice(0, 80)})` : ''}.`)
        return
      }

      const loops = loopsFor(await h.vars.read('repeat'))
      // the play history's recorder; without it (not written) mpv plays on
      const script = await installHistoryScript(h)
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
        // -append: --script-opts would drop any script-opts in your mpv.conf
        // (ytdl_hook's among them), and it takes the path whole, commas and all
        ...(script ? [`--script=${script}`, `--script-opts-append=stream_radio_history-file=${p.history}`] : []),
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

// What the footer shows while what was asked is expanded (yt-dlp, curl), as
// `connecting…` while mpv starts.
export const LOADING = 'loading…'
// What the footer shows while mpv starts.
export const CONNECTING = 'connecting…'
// What it showed before, to show again when the expansion comes to nothing.
let beforeLoading = ''

// Plays `source` (a URL, a file, a folder, a playlist file or a YouTube
// playlist): expanded to its songs, they replace the queue, and the first plays
// (a video link's own video, in its playlist). Resolves once the queue is
// written, to what to show about the expansion (a cap it hit) or ''; the player
// starts in the background. A hook does not wait on it: the expansion may run
// yt-dlp or curl.
export async function playSource(h: Host, config: PlayerConfig, source: string): Promise<string> {
  // a newer play or a stop while it expands wins, and shows its own state
  const mine = ++asked
  const now = await h.vars.read('playing')
  if (now !== LOADING) beforeLoading = now
  await h.vars.change('playing', () => LOADING)
  // nothing started: what showed before shows again
  const unload = async () => {
    if (mine === asked) await h.vars.change('playing', p => (p === LOADING ? beforeLoading : p))
  }
  try {
    const { entries, root, note, start } = await expandSource(h, source)
    if (mine !== asked) return note
    if (!entries.length) {
      await unload()
      return note || `Nothing to play in ${source}.`
    }
    const said = await playNew(h, config, entries, source, root, mine, start)
    if (said) await unload()
    return said || note
  } catch (error) {
    await unload()
    throw error
  }
}

// Plays `entries` (a saved playlist, say) as the queue, starting at entry
// `start`; `source` is what the queue is called. Like playSource after it has
// expanded: a newer play or a stop wins. Resolves to what to show, or ''.
export async function playEntries(h: Host, config: PlayerConfig, entries: QueueEntry[], source: string, start: number): Promise<string> {
  const mine = ++asked
  return playNew(h, config, entries, source, '', mine, start)
}

// `entries` replace the queue and entry `start` plays; '' when started (or
// overtaken), else what to show. `mine`: what was asked that it answers;
// dropped once something newer was asked.
async function playNew(h: Host, config: PlayerConfig, entries: QueueEntry[], source: string, root: string, mine = asked, start = 0): Promise<string> {
  const q = await updateStored(h, q => replaceWith(q, entries, source, root))
  if (q === 'busy') return BUSY
  if (mine !== asked) return ''
  const shown = played(q)
  const index = shown[start] ? start : 0
  await writePlace(h, { rev: q.rev, current: shown[index]!.id, seconds: 0 }).catch(() => undefined)
  // launched first: it lets go of the player followed, whose list then gives
  // way to the new one
  launch(h, config, q, { index, seconds: 0 })
  await refreshFromStored(h)
  return ''
}

// Plays entry `shownIndex` of the queue: playing, mpv jumps there (or to that
// chapter); stopped, the player starts on the queue at that entry, from 0:00.
export async function playAt(h: Host, config: PlayerConfig, shownIndex: number): Promise<string> {
  if (control) {
    const q = await h.vars.read('queue')
    if (q.kind === 'none') return 'Nothing to pick from.'
    const index = q.kind === 'playlist' ? await mpvIndexOf(h, shownIndex) : shownIndex
    if (index < 0) return STALE
    const ok = await mpv(h, q.kind === 'playlist' ? ['playlist-play-index', index] : ['set_property', 'chapter', index])
    if (!ok) return 'The player is not ready yet.'
    await mpv(h, ['set_property', 'pause', false])
    await h.vars.change('queue', x => ({ ...x, current: shownIndex }))
    return ''
  }
  const q = await readStored(h)
  const e = played(q)[shownIndex]
  if (!e) return 'Nothing to pick from.'
  await writePlace(h, { rev: q.rev, current: e.id, seconds: 0 }).catch(() => undefined)
  // asked for: a play still expanding gives way (a reconnect's launch does not)
  asked += 1
  launch(h, config, q, { index: shownIndex, seconds: 0 })
  await refreshFromStored(h)
  return ''
}

// Plays entry `index` of the queue, unpaused.
export const pick = playAt

// Where row `shownIndex` (of the list as listed) is in mpv's list: the same
// index while the two are in step, else the entry with its file nearest it
// (a song a mend left first shifts the rest by one); -1 when mpv lacks it.
async function mpvIndexOf(h: Host, shownIndex: number): Promise<number> {
  if (inStep()) return shownIndex
  const path = listed.paths[shownIndex]
  const list = await playlistOf(h)
  if (path === undefined || !list) return -1
  let best = -1
  list.forEach((e, i) => {
    if (e.filename === path && (best < 0 || Math.abs(i - shownIndex) < Math.abs(best - shownIndex))) best = i
  })
  return best
}

// Starts the queue where it got to: its place's entry, sought to its seconds
// (`l`, `/stream last`, the panel's Resume). An empty queue brings back the one
// last cleared, else plays `fallback` (the default stream). '' when started,
// else what to show. `later`: given, a fallback that has to be expanded is not
// waited on (a hook must not wait on yt-dlp or curl): it is handed what the
// play resolves to, and this says `Starting <fallback>.`.
export function resumeQueue(h: Host, config: PlayerConfig, fallback: string, later?: Later): Promise<string> {
  return startQueue(h, config, fallback, true, later)
}

// Plays the queue from the start of its place's entry: Play after Stop (the
// footer's ▶, the app's play button and space) starts the song from 0:00,
// while `l` resumes it. Empty, as resumeQueue.
export function playQueue(h: Host, config: PlayerConfig, fallback: string, later?: Later): Promise<string> {
  return startQueue(h, config, fallback, false, later)
}

// What a play not waited on resolves to, for the caller to show.
export type Later = (work: Promise<string>) => void

async function startQueue(h: Host, config: PlayerConfig, fallback: string, isResume: boolean, later?: Later): Promise<string> {
  await migrating?.catch(() => undefined)
  let q = await readStored(h)
  if (!q.entries.length) {
    const back = await restorePrev(h)
    if (back === 'busy') return BUSY
    if (!back) {
      if (!fallback) return 'Nothing has played yet, and there is no default stream.'
      if (!later) return playSource(h, config, fallback)
      later(playSource(h, config, fallback))
      return `Starting ${fallback}.`
    }
    // the backup, or the songs another program added meanwhile
    q = back
  }
  const at = placeIn(q, await readPlace(h))
  asked += 1
  launch(h, config, q, isResume ? at : { index: at.index, seconds: 0 })
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

// A queue entry as the panel lists it: its title, else its file name; a
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

// What the panel lists: the queue's entries, else the playing file's chapters
// (a video of several songs, the queue's one entry), else nothing to pick from.
// isNewFile: a file loaded (or the list was read again), so its chapters are read.
export type Refresh = { isNewFile?: boolean }

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

// The queue to draw while following a player: the file's list (as last read)
// at mpv's position; a lone file's chapters from mpv.
export async function readQueue(h: Host, before: Queue, how: Refresh): Promise<Queue> {
  if (seen.count === 1 && listed.paths.length <= 1) {
    if (!how.isNewFile && before.kind === 'chapters') return { ...before, current: seen.chapter }
    const chapters = (await mpv(h, ['get_property', 'chapter-list']))?.data
    if (Array.isArray(chapters) && chapters.length > 1) {
      const at = (await mpv(h, ['get_property', 'chapter']))?.data
      return {
        kind: 'chapters',
        items: (chapters as { title?: unknown }[]).map((c, i) => (typeof c.title === 'string' && plain(c.title)) || `Chapter ${i + 1}`),
        current: typeof at === 'number' ? at : seen.chapter,
        paths: [],
        root: '',
      }
    }
  }
  if (!listed.paths.length) return NO_QUEUE
  return { kind: 'playlist', items: listed.items, current: shownCurrent(), paths: listed.paths, root: listed.root }
}

// The shown index playing: mpv's position while its list is the one listed,
// else where the place is.
function shownCurrent(): number {
  if (inStep()) return seen.pos
  return place.current === null ? -1 : listed.ids.indexOf(place.current)
}

// Whether mpv's list is the one listed: brought to the rev it was read at, as
// long, and (when mpv said) with the same file at its position. Another
// session's sort shows in mpv's positions before its rev comes.
function inStep(): boolean {
  if (seen.rev !== listed.rev || seen.count !== listed.paths.length) return false
  return typeof seen.posPath !== 'string' || seen.posPath === listed.paths[seen.pos]
}

// Asks mpv which file it has at its position.
async function notePosPath(h: Host) {
  seen.posPath = seen.pos >= 0 ? (await mpv(h, ['get_property', `playlist/${seen.pos}/filename`]))?.data : undefined
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

// Each entry as playing it expands it (expandSource: a folder's songs, a
// playlist file's lines, a YouTube playlist's videos), MAX_SONGS in all; one
// that stays itself keeps its title. note: what to say (a cap it hit).
async function expand(h: Host, entries: readonly QueueEntry[]): Promise<{ songs: QueueEntry[]; note: string }> {
  const songs: QueueEntry[] = []
  const notes: string[] = []
  for (const e of entries) {
    const room = MAX_SONGS - songs.length
    if (room <= 0) {
      notes.push(`Added the first ${MAX_SONGS} songs.`)
      break
    }
    const x = await expandSource(h, e.path, room)
    if (x.entries.length === 1 && x.entries[0]!.path === e.path) songs.push(e)
    else songs.push(...x.entries)
    if (x.note) notes.push(x.note)
  }
  return { songs, note: notes.join(' ') }
}

const m3u = (entries: readonly QueueEntry[]) =>
  `#EXTM3U\n${entries.map(e => `${e.title ? `#EXTINF:-1,${e.title.replace(/\n/g, ' ')}\n` : ''}${e.path}\n`).join('')}`

type Entry = { filename?: string; title?: string; current?: boolean; 'playlist-path'?: string }
// The player's playlist; undefined when mpv did not answer.
async function playlistOf(h: Host): Promise<Entry[] | undefined> {
  const list = (await mpv(h, ['get_property', 'playlist']))?.data
  return Array.isArray(list) ? (list as Entry[]) : undefined
}
// mpv's entries as the queue's. Ones mpv expanded from something on the network
// (a stream's playlist, `origin` or the entry's own playlist-path) keep only
// network URLs: mpv refuses a local file such a list names, but keeps it in its
// list, and from the queue's local file it would no longer be refused.
const isRemote = (s: string | undefined) => !!s && /^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:\/\//i.test(s)
const entriesOf = (list: readonly Entry[], origin?: string): QueueEntry[] =>
  list
    .filter(e => e.filename && (isNetwork(e.filename) || !(isRemote(origin) || isRemote(e['playlist-path']))))
    .map(e => ({ path: e.filename!, title: e.title }))

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

// `fn` over the stored queue (and the entry it is at, read in turn) under the
// lock, then the place, mpv and every session follow. '' when done,
// `unchanged` when `fn` changed nothing, else what to show.
function edit(h: Host, fn: (q: StoredQueue, current: string | null) => StoredQueue, unchanged = ''): Promise<string> {
  return inTurn(() => editNow(h, fn, unchanged))
}

// One change of the queue or of mpv's list at a time in this program (an
// edit, or mending mpv): the next one's write and mpv's moves wait for this
// one's, so mpv is never moved against a list it has not reached yet.
function inTurn<T>(step: () => Promise<T>): Promise<T> {
  const next = editing.then(step)
  editing = next.catch(() => undefined)
  return next
}
let editing: Promise<unknown> = Promise.resolve()

async function editNow(h: Host, fn: (q: StoredQueue, current: string | null) => StoredQueue, unchanged: string): Promise<string> {
  const current = await currentId(h)
  let was: StoredQueue = EMPTY_QUEUE
  let synced = false
  const q = await updateStoredWith(
    h,
    async x => ((was = x), fn(x, current)),
    // Still holding the lock: no other program's edit or mend moves mpv while
    // it is brought along, and none reads the file ahead of mpv meanwhile.
    // Brought along only from the list of the queue as it was (mpv's rev says
    // which); else mpv keeps a rev that is not the file's, and is mended from
    // the file (checkSoon).
    async (next, from) => {
      if (control && (await syncPlayer(h, from.rev, played(from), played(next)))) synced = await setMpvRev(h, next.rev)
    },
  ).catch(() => undefined)
  if (q === 'busy') return BUSY
  if (!q) return 'Could not save the queue.'
  if (q.rev === was.rev) return unchanged
  await movePlace(h, was, q)
  // mpv's rev changed: that tells every other session following it to read
  // the queue again; else `edited` tells them. This one reads it now.
  if (control && !synced) await markEdited(h)
  await refreshFromStored(h)
  return ''
}

// The queue's rev mpv's list was last brought to.
const mpvRev = async (h: Host): Promise<unknown> => (await mpv(h, ['get_property', 'user-data/stream-radio/rev']))?.data
const setMpvRev = async (h: Host, rev: number): Promise<boolean> => {
  if (!(await mpv(h, ['set_property', 'user-data/stream-radio/rev', rev]))) return false
  seen.rev = rev
  return true
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
// loaded in one list where they go, then the moves. More than FEW_MOVES
// commands in all (removes and moves) rebuild the list around the song
// playing instead, so an edit holds the queue lock for a few commands at most.
// Never a jump: the song playing plays on. false, and mpv left as it is, when
// its list is not `from` (its rev is not `fromRev`: another program's edit
// came between; or it expanded an entry) or it stopped answering.
async function syncPlayer(h: Host, fromRev: number, from: readonly StoredEntry[], to: readonly StoredEntry[]): Promise<boolean> {
  if (seen.count !== from.length || (await mpvRev(h)) !== fromRev) return false
  isReordering = true
  try {
    const keep = new Set(to.map(e => e.id))
    const gone = from.flatMap((e, i) => (keep.has(e.id) ? [] : [i]))
    // mpv's list once the gone are out and the new are in
    const list = from.map(e => e.id).filter(id => keep.has(id))
    const had = new Set(list)
    const added = to.filter(e => !had.has(e.id))
    const first = added.length ? to.indexOf(added[0]!) : -1
    const at = first > 0 ? list.indexOf(to[first - 1]!.id) + 1 : 0
    const count = list.length
    if (added.length) list.splice(at, 0, ...added.map(e => e.id))
    const steps = moveSteps(to.map(e => list.indexOf(e.id)))
    if (gone.length + steps.length > FEW_MOVES) {
      if (!(await rebuildTo(h, from, to))) return false
    } else {
      // the highest first, so the indexes below stay put
      for (const i of gone.reverse()) if (!(await mpv(h, ['playlist-remove', i]))) return false
      if (added.length) {
        const loaded = await loadAt(h, added, at, count, FEW_MOVES - gone.length - steps.length)
        if (!loaded) return false
        // an older mpv put them at the end, too many to move one by one: the
        // list is rebuilt from there instead
        if (loaded === 'appended') {
          const kept = from.filter(e => keep.has(e.id))
          if (!(await rebuildTo(h, [...kept, ...added], to))) return false
          seen.count = to.length
          seen.posPath = undefined
          return true
        }
      }
      if (await moveEach(h, steps)) return false
    }
    seen.count = to.length
    // where mpv is now comes in its next position
    seen.posPath = undefined
    return true
  } finally {
    isReordering = false
  }
}

// mpv's list (now `from`) rebuilt as `to` around the song playing. A song
// playing that `to` lacks goes where the next one kept is, and is removed
// there: mpv plays that one, as it would after a remove.
async function rebuildTo(h: Host, from: readonly StoredEntry[], to: readonly StoredEntry[]): Promise<boolean> {
  const list = await playlistOf(h)
  if (!list || list.length !== from.length) return false
  const playing = list.findIndex(e => e.current)
  if (playing < 0) return false
  const id = from[playing]!.id
  let at = to.findIndex(e => e.id === id)
  const stays = at >= 0
  if (!stays) {
    const kept = new Set(to.map(e => e.id))
    const next = from.slice(playing + 1).find(e => kept.has(e.id))
    at = next ? to.findIndex(e => e.id === next.id) : to.length
  }
  if (await rebuildAround(h, to.slice(0, at), to.slice(stays ? at + 1 : at))) return false
  return stays || !!(await mpv(h, ['playlist-remove', at]))
}

// `songs` into mpv's list of `count` at `at`, in one list: a loadfile per song
// made a folder trickle in, every session reading the queue again after each.
// insert-at needs mpv 0.38; an older one appends, and the songs move up one by
// one, `moves` of them at most: more, and they are left at the end
// ('appended'), for the caller to rebuild around, so the lock is not held for
// a move per song. false when mpv refused.
async function loadAt(h: Host, songs: readonly QueueEntry[], at: number, count: number, moves: number): Promise<boolean | 'appended'> {
  const file = `${(await paths(h)).queue}.add`
  await h.fs.write(file, m3u(songs))
  if (at >= count) return !!(await mpv(h, ['loadlist', file, 'append']))
  if (await mpv(h, ['loadlist', file, 'insert-at', at])) return true
  if (!(await mpv(h, ['loadlist', file, 'append']))) return false
  if (songs.length > moves) return 'appended'
  for (let i = 0; i < songs.length; i++) if (!(await mpv(h, ['playlist-move', count + i, at + i]))) return false
  return true
}

// Adds to the end of the queue, or to play next (after the current song, in
// the order given). Nothing queued and nothing playing: what is added becomes
// the queue, and it plays. '' when done, else what to show.
export async function addToQueue(h: Host, config: PlayerConfig, entries: readonly QueueEntry[], where: 'end' | 'next'): Promise<string> {
  const { songs, note } = await expand(h, entries)
  if (!songs.length) return note || 'Nothing to add.'
  const was = { isEmpty: false }
  const reply = await edit(h, (q, current) => {
    was.isEmpty = !q.entries.length && !control
    return was.isEmpty ? q : addEntries(q, songs, where, current)
  })
  if (reply || !was.isEmpty) return reply || note
  return (await playNew(h, config, songs, (await paths(h)).queue, '')) || note
}

// Up to this many removes and moves go one by one; more (a sort) rebuild the list.
const FEW_MOVES = 8

async function moveEach(h: Host, steps: readonly [number, number][]): Promise<string> {
  for (const [j, i] of steps) if (!(await mpv(h, ['playlist-move', j, i]))) return 'The player is not ready yet.'
  return ''
}

// mpv's list made `before`, the song playing, `after`, in a few commands, not
// a move per entry: a sort of hundreds of songs moved the playing one at each
// step, and every session following the player showed (and fetched art and a
// waveform for) a different song each time. Everything but the playing song
// is cleared, the songs before it loaded and it moved after them, then the
// songs after it. The song plays on throughout.
async function rebuildAround(h: Host, before: readonly QueueEntry[], after: readonly QueueEntry[]): Promise<string> {
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
  const was = { isOn: false }
  const reply = await edit(
    h,
    (q, current) => {
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
  // Stopped first: a mend due while mpv still plays would find the file
  // empty and write mpv's list back into it.
  await stopPlaying(h, config)
  const done = await backUpAndEmpty(h).catch(() => 'failed' as const)
  if (done === 'busy') return BUSY
  if (done === 'failed') return 'Could not save the queue.'
  await refreshFromStored(h)
  return 'Cleared the queue. l brings it back.'
}

// --- Mending mpv: while a player is followed, its list is checked against the
// file (a few calls, when the list was read again or mpv's position or length
// changed). The file is the truth; mpv carries the file's rev its list was
// brought to.
// - mpv's rev the file's but its list not: mpv expanded an entry (a .cue, a
//   URL's playlist), and that one entry is replaced in the file by mpv's songs.
//   The one place mpv writes back.
// - The file empty (a player older than the file): mpv's list becomes the queue.
// - Else (a rev behind, or none: a crash mid-edit, an older player) mpv is
//   rebuilt from the file around the song playing. A song playing that the
//   file lacks plays on first, and goes once it has played; the file is not
//   changed for it.
// All of it holds the queue lock, rev set included, as an edit holds it while
// it brings mpv along: a mend never runs between an edit's write and its
// moves, and two sessions never mend at once. Each mend ends with mpv at the
// file's rev, which settles every other session's check: no ping-pong.

// How long a list that is not the file's is left before it is mended: an
// edit's own moves (here or in another program) land well within it.
const SETTLE_MS = 1000
// The follow (watchRun) a check is due for: one at a time for each.
let checkDue = -1
// What the last mend was tried on (the file's rev, mpv's rev and length): a
// mend that came to nothing is not tried again on the same.
let triedOn = ''

function checkSoon(h: Host) {
  if (!control || checkDue === watchRun) return
  const mine = (checkDue = watchRun)
  const done = () => {
    if (checkDue === mine) checkDue = -1
  }
  void h
    .sleep(SETTLE_MS)
    .then(
      () => {
        done()
        if (mine === watchRun && control) return inTurn(() => mendPlayer(h, mine))
      },
      done,
    )
    .catch(error => h.log(`stream-radio: could not mend the player's list: ${error instanceof Error ? error.message : String(error)}`, 'debug'))
}

// `mine`: the follow (watchRun) it was due for; a newer one (or none) ends it.
async function mendPlayer(h: Host, mine: number) {
  const isMine = () => mine === watchRun && !!control
  if (!isMine() || !seen.isLoaded || isReordering || pending) return
  // a new start is under way: its own list comes
  if (((await readIntent(h))?.id ?? '') !== followedId) return
  const file = await readStored(h)
  if (seen.rev === file.rev && seen.count === played(file).length) return
  const key = `${file.rev}/${String(seen.rev)}/${seen.count}/${seen.pos}`
  if (key === triedOn) return
  triedOn = key
  const was = control && place.current !== null ? place : await readPlace(h)
  // what mpv was brought to: the file's rev, and where the song playing is
  let done = undefined as { rev: number; at: number } | undefined
  isReordering = true
  const q = await updateStoredWith(
    h,
    async q => {
      if (!isMine()) return q
      const list = await playlistOf(h)
      if (!list) return q
      const rev = await mpvRev(h)
      const shown = played(q)
      const listPaths = list.map(e => e.filename ?? '')
      const filePaths = shown.map(e => e.path)
      const same = (a: readonly string[]) => a.join('\n') === filePaths.join('\n')
      const playing = list.findIndex(e => e.current)
      // the same songs: only the rev was missing
      if (same(listPaths)) {
        if (rev !== q.rev) await setMpvRev(h, q.rev)
        done = { rev: q.rev, at: playing }
        return q
      }
      if (rev === q.rev) {
        const one = expandedEntry(shown, listPaths)
        if (one) {
          const next = replaceEntry(q, one.id, entriesOf(list.slice(one.from, one.to), shown.find(e => e.id === one.id)?.path))
          done = { rev: next.rev, at: playing }
          return next
        }
      }
      if (!shown.length) {
        const next = replaceWith(q, entriesOf(list), q.source || seen.url, q.root)
        done = { rev: next.rev, at: playing }
        return next
      }
      if (playing < 0) return q
      // a song left playing first by an earlier mend: once it has played, it
      // goes; until then there is nothing to do
      if (same(listPaths.slice(1))) {
        if (playing === 0 || !(await mpv(h, ['playlist-remove', 0]))) return q
        await setMpvRev(h, q.rev)
        done = { rev: q.rev, at: playing - 1 }
        return q
      }
      const byPlace = shown.findIndex(e => e.id === was.current)
      const at = shown[byPlace]?.path === listPaths[playing] ? byPlace : filePaths.indexOf(listPaths[playing]!)
      if (await rebuildAround(h, shown.slice(0, Math.max(0, at)), shown.slice(at + 1))) return q
      // the song playing is not the file's: mpv's rev waits until it is gone
      if (at < 0) return q
      await setMpvRev(h, q.rev)
      done = { rev: q.rev, at }
      return q
    },
    // the file took mpv's list (or its expansion): mpv is at its rev
    async next => {
      if (isMine()) await setMpvRev(h, next.rev)
    },
  )
    .catch(() => undefined)
    .finally(() => (isReordering = false))
  if (!done || !q || q === 'busy' || q.rev !== done.rev || !isMine()) return
  triedOn = ''
  const shown = played(q)
  seen.count = shown.length
  if (done.at >= 0) seen.pos = done.at
  seen.posPath = shown[seen.pos]?.path
  const e = shown[done.at]
  if (e) {
    place = { rev: q.rev, current: e.id, seconds: e.id === was.current ? was.seconds : 0 }
    placedAt = undefined
    await savePlace(h, true)
  }
  await refreshFromStored(h)
}

// The one stored entry mpv's list has something else in place of (its songs,
// from `from` to `to` in mpv's list), the rest matching by path from the
// front and the back; undefined when it is not one.
function expandedEntry(shown: readonly StoredEntry[], list: readonly string[]): { id: string; from: number; to: number } | undefined {
  let i = 0
  while (i < shown.length && i < list.length && shown[i]!.path === list[i]) i++
  let j = 0
  while (j < shown.length - i && j < list.length - i && shown[shown.length - 1 - j]!.path === list[list.length - 1 - j]) j++
  if (shown.length - i - j !== 1) return undefined
  return { id: shown[i]!.id, from: i, to: list.length - j }
}

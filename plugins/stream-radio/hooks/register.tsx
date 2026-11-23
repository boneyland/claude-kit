import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Queue, Resume } from '../types'

import {
  completeLines,
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
  parseArgs,
  parseNowPlaying,
  SCROLL_CHARS,
  SCROLL_MS,
  STATUS_FORMAT,
  textWidth,
  titleColumns,
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
// the seconds into it (-1 for a live stream), with the song's title. Outlives a
// reload, which kills the player, so playing the last URL again resumes there.
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
// playing where it is. The list is read again, as its order changed.
async function toggleShuffle($: EngineInterface): Promise<string> {
  if ((await read($, queue)).kind !== 'playlist') return 'Nothing to shuffle: this is not a playlist.'
  const on = !(await read($, isShuffled))
  if (!(await mpv($, [on ? 'playlist-shuffle' : 'playlist-unshuffle']))) return 'The player is not ready yet.'
  await update($, isShuffled, () => on)
  await refreshQueue($, true)
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


// Sends one command to mpv's IPC socket and prints its reply's data as JSON;
// exits 1 when mpv answers with an error.
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

// URLs that only played with the android client; they start with it directly.
const needsAndroid = new Set<string>()

// The running player's stream: ending its loop kills the child.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let current: { return: (value: any) => Promise<unknown> } | undefined
// The socket path mpv listens on; undefined when nothing plays.
let control: string | undefined
let run = 0
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

// Ends the running player (if any); the caller clears the footer.
async function stop() {
  run += 1
  const old = current
  current = undefined
  control = undefined
  stopScroller()
  await old?.return(undefined)
}

// Runs one mpv command; resolves to its reply's data, or undefined when nothing
// plays, mpv is not listening yet or it refused.
async function mpv($: EngineInterface, command: readonly unknown[]): Promise<{ data: unknown } | undefined> {
  if (!control) return undefined
  const result = await $.process
    .run(['python3', '-I', `${$.plugin.root}/${IPC}`, control, JSON.stringify(command)], { timeoutMs: 3000 })
    .catch(() => undefined)
  if (result?.exitCode !== 0) return undefined
  try {
    return { data: JSON.parse(result.stdout || 'null') as unknown }
  } catch {
    return { data: null }
  }
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
// `isOrderChanged`: the entries moved (a shuffle), so the whole list is read.
async function refreshQueue($: EngineInterface, isOrderChanged = false) {
  const before = await read($, queue)
  const next = await readQueue($, isOrderChanged ? NO_QUEUE : before)
  await update($, queue, () => next)
  // A new folder starts shut; the current song's folders open when it changes,
  // so it shows, and a folder shut by hand stays shut until then.
  if (next.root !== before.root) await update($, openFolders, () => [])
  if (next.root && (next.current !== before.current || next.root !== before.root)) {
    const path = next.paths[next.current] ?? ''
    await update($, openFolders, open => [...new Set([...open, ...foldersOf(path, next.root)])])
  }
}

// The queue as mpv has it now. A playlist of the same length as last read is
// the same playlist (a new URL starts from no queue): only the position is
// asked for, a small reply, instead of every entry again.
async function readQueue($: EngineInterface, before: Queue): Promise<Queue> {
  if (before.kind === 'playlist') {
    const count = (await mpv($, ['get_property', 'playlist-count']))?.data
    if (count === before.items.length) {
      const pos = (await mpv($, ['get_property', 'playlist-pos']))?.data
      return { ...before, current: typeof pos === 'number' ? pos : -1 }
    }
  }
  const list = (await mpv($, ['get_property', 'playlist']))?.data
  let next: Queue = NO_QUEUE
  if (Array.isArray(list) && list.length > 1) {
    const entries = list as { filename?: string; title?: string; current?: boolean }[]
    const paths = entries.map(e => e.filename ?? '')
    // A local folder played whole: its entries are grouped under it.
    const url = await read($, lastUrl)
    const root = url.startsWith('/') && paths.some(p => p.startsWith(`${url.replace(/\/$/, '')}/`)) ? url.replace(/\/$/, '') : ''
    next = {
      kind: 'playlist',
      items: await Promise.all(entries.map(e => entryName($, e, root))),
      current: entries.findIndex(e => e.current),
      paths,
      root,
    }
  } else {
    const chapters = (await mpv($, ['get_property', 'chapter-list']))?.data
    if (Array.isArray(chapters) && chapters.length > 1) {
      const at = (await mpv($, ['get_property', 'chapter']))?.data
      next = {
        kind: 'chapters',
        items: (chapters as { title?: string }[]).map((c, i) => c.title || `Chapter ${i + 1}`),
        current: typeof at === 'number' ? at : -1,
        paths: [],
        root: '',
      }
    }
  }
  return next
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
  const command =
    q.kind === 'playlist' ? [by > 0 ? 'playlist-next' : 'playlist-prev'] : ['add', 'chapter', by]
  return (await mpv($, command)) ? '' : 'The player is not ready yet.'
}

// Starts playing `url`. Returns at once: the first start after a reload is slow,
// and a hook that takes too long is reported as unanswered, so the startup runs
// in the background.
// After a player that was playing ends by itself (a dropped stream, a crash),
// the waits before each try to start it again; past the last, it gives up.
const RECONNECT_MS = [2000, 5000, 15_000]
// Playing this long since the last try counts as recovered: a later drop starts
// the tries over.
const STEADY_MS = 60_000
// Signals that mean someone ended the player on purpose: no reconnecting.
const DELIBERATE = new Set(['SIGTERM', 'SIGINT', 'SIGKILL'])

// `from`: a place to resume at once it plays, for the URL played last.
// `attempt`: how many reconnect tries came before this start.
function start($: EngineInterface, config: Config, url: string, from?: Resume, retryClient?: string, attempt = 0) {
  const { player, androidClient } = config
  // YouTube refuses the default client's stream URLs for some content (403);
  // the android client gets through, with muxed AAC and no audio-only Opus.
  const client = retryClient ?? (androidClient || needsAndroid.has(url) ? 'android' : undefined)
  const old = current
  current = undefined
  control = undefined
  run += 1
  const mine = run
  void (async () => {
    let lastError = ''
    let lastTitle = ''
    let lastPaused = false
    let lastSeconds = -1
    let lastChapter = ''
    let unread = ''
    let pipe = ''
    // When the first title came, and how the player ended.
    let playedAt = 0
    let exit: { code: number | null; signal: string | null } | undefined
    // Cleared once reached; until then the position is not recorded, or the first
    // song's start would overwrite where to go.
    let pending = from?.url === url && (from.index > 0 || from.seconds >= RESUME_MIN_SECONDS) ? from : undefined
    try {
      await old?.return(undefined)
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
        await update($, playing, () => '')
        $.ui.toast(`Can't start "${player}". Install mpv (and yt-dlp for YouTube).`)
        return
      }

      // mpv's IPC socket, in the plugin's data folder; pause and resume go through it.
      const dir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
      pipe = `${dir}/mpv-${mine}.sock`
      await $.process.run(['rm', '-f', pipe])
      if (mine !== run) return
      control = pipe

      const loops = loopsFor(await read($, repeatMode))
      const argv = [
        player,
        '--no-video',
        '--no-input-terminal',
        // Repeat as set, whatever your mpv.conf loops; a stream plays on.
        `--loop-file=${loops.file}`,
        `--loop-playlist=${loops.playlist}`,
        '--keep-open=no',
        `--input-ipc-server=${pipe}`,
        '--ytdl-format=bestaudio/best',
        // A local folder plays its sound and video files (sound only), not its
        // cover art or archives, which would each take a turn; its subfolders
        // are read at once, so the panel can show them whole.
        ...(/^https?:/.test(url) ? [] : ['--directory-filter-types=audio,video,playlist', '--directory-mode=recursive']),
        ...(client
          ? [`--ytdl-raw-options-append=extractor-args=youtube:player_client=${client}`]
          : []),
        `--volume=${await read($, volumeLevel)}`,
        '--msg-level=all=error,statusline=status',
        `--term-status-msg=${STATUS_FORMAT}`,
        '--',
        url,
      ]
      const stream = $.process.spawn({ argv })
      current = stream
      for await (const { stream: from, text } of stream) {
        if (mine !== run) return
        if (from === 'stderr') {
          lastError = text.trim().split('\n').pop() ?? lastError
          continue
        }
        // Output comes in pieces: read complete lines only, or a half-printed
        // line can claim the stream is not paused.
        const { complete, rest } = completeLines(unread + text)
        unread = rest
        const track = parseNowPlaying(complete)
        if (track && track.title !== lastTitle) {
          // The first title means it really plays: remember it for the button.
          if (!lastTitle) {
            playedAt = await $.clock.now().catch(() => 0)
            await update($, lastUrl, () => url)
            await saveLast($, true)
            if (client) needsAndroid.add(url)
          }
          lastTitle = track.title
          await update($, scroll, () => 0)
          await update($, playing, () => track.title)
          // Waited for: the position recorded below needs this song's place in it.
          await refreshQueue($).catch(() => undefined)
          if (pending) {
            const q = await read($, queue)
            if (q.kind === 'playlist' && pending.index >= 0 && pending.index < q.items.length && q.current !== pending.index) {
              // The jump starts another song; its title comes back through here.
              if (!(await mpv($, ['playlist-play-index', pending.index]))) pending = undefined
            } else {
              if (pending.seconds >= RESUME_MIN_SECONDS) await mpv($, ['seek', pending.seconds, 'absolute'])
              pending = undefined
            }
          }
        }
        const pos = track?.seconds ?? -1
        if (track && pos !== lastSeconds) {
          lastSeconds = pos
          await update($, elapsed, () => pos)
          if (!pending && lastTitle) {
            const q = await read($, queue)
            const index = q.kind === 'playlist' ? q.current : -1
            const title = (await read($, chapter)) || lastTitle
            const was = await read($, resumeAt)
            await update($, resumeAt, () => ({ url, index, seconds: pos, title }))
            await saveLast($, was.url !== url || was.index !== index || was.title !== title)
          }
        }
        if (track && track.chapter !== null && track.chapter !== lastChapter) {
          const next = track.chapter
          lastChapter = next
          await update($, scroll, () => 0)
          await update($, chapter, () => next)
          void refreshQueue($).catch(() => undefined)
        }
        if (track && track.isPaused !== null && track.isPaused !== lastPaused) {
          lastPaused = track.isPaused
          await update($, isPaused, () => track.isPaused)
        }
      }
      exit = await stream.result.catch(() => undefined)
    } catch (error) {
      // a child that cannot start or was killed ends the loop; reported below
      lastError ||= error instanceof Error ? error.message : String(error)
    } finally {
      if (pipe) await $.process.run(['rm', '-f', pipe]).catch(() => undefined)
    }
    if (mine !== run) return
    current = undefined
    control = undefined
    stopScroller()
    await update($, playing, () => '')
    await update($, chapter, () => '')
    await update($, queue, () => NO_QUEUE)
    if (!lastTitle && !client && /^https?:/.test(url)) {
      // Nothing played with the default client: try once with android.
      $.ui.log(`stream-radio: ${url} would not play; retrying with the android client`)
      start($, config, url, from, 'android')

      return
    }
    if (!lastTitle) {
      // Nothing ever played: say so where it stays (a toast alone is easy to miss).
      const why = lastError
        ? lastError.slice(0, 300)
        : 'the player exited before anything played; is the URL playable?'
      $.ui.log(`stream-radio: could not play ${url}: ${why}`)
      $.ui.toast(`stream failed: ${why.slice(0, 120)}`)
      return
    }
    // It played, then ended by itself: start it again where it got to, unless a
    // playlist with repeat off simply finished or someone ended the player.
    if (exit?.signal && DELIBERATE.has(exit.signal)) return
    if (exit?.code === 0 && (await read($, repeatMode)) === 'off') return
    const now = await $.clock.now().catch(() => 0)
    const tries = now - playedAt >= STEADY_MS ? 0 : attempt
    const wait = RECONNECT_MS[tries]
    const why = lastError ? `: ${lastError.slice(0, 200)}` : ''
    if (wait === undefined) {
      $.ui.log(`stream-radio: ${url} stopped${why}; gave up after ${RECONNECT_MS.length} tries`)
      $.ui.toast(`stream stopped; gave up after ${RECONNECT_MS.length} tries`)
      return
    }
    $.ui.log(`stream-radio: ${url} stopped${why}; trying again in ${wait / 1000} s`)
    await update($, playing, () => `reconnecting in ${wait / 1000} s…`)
    const token = run
    // A reload or the session's end while it waits aborts the wait.
    if (!(await $.clock.sleep(wait).then(() => true, () => false))) return
    // Stopped, or something else started, while it waited.
    if (run !== token) return
    start($, config, url, await read($, resumeAt), client, tries + 1)
  })().catch(error => $.ui.log(`stream-radio: player task failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
}

// Pauses or resumes through mpv; false while it is not listening yet. The new
// state is decided before sending and written as that value, not a flip: mpv's
// own status line reports the change while the send runs, and a late flip would
// undo it.
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

async function stopPlaying($: EngineInterface) {
  await saveLast($, true)
  await stop()
  await update($, playing, () => '')
  await update($, queue, () => NO_QUEUE)
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
    // State outlives a reload but the player does not: start from idle.
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

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopPlaying($)

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    // A throwing hook is skipped and /stream then says nothing useful: say why.
    try {
      const parsed = await locate($, e.args, defaultUrl)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'stop') {
        await stopPlaying($)

        return { text: 'Stopped.' }
      }
      if (parsed.kind === 'panel') return { text: `Radio panel ${await togglePane($)}.` }
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
              <Button key="stop" label="⏹ Stop" onPress={() => act(async () => (await stopPlaying($), ''))} />
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

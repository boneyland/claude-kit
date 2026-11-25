// The world beneath the plugin in tests: ONE mpv shared by every session, as
// the plugin sees it. A start runs `sh -c '… setsid -f mpv …'`; commands go
// through mpv-ipc.py; a session follows the player with `mpv-ipc.py --watch`,
// a stream of JSON lines; the data folder holds the socket, player.json,
// reconnect.lock, state.json and the queue's files. A start hands mpv
// --playlist=queue.m3u, whose songs it plays from --playlist-start.
import type { On } from 'claude-code'

export const DATA = '/tmp/stream-radio-test/stream-radio'
export const SOCK = `${DATA}/mpv.sock`
export const INTENT = `${DATA}/player.json`
export const LOCK = `${DATA}/reconnect.lock`
export const LOG = `${DATA}/mpv.log`
export const STATE = `${DATA}/state.json`
export const QUEUE_JSON = `${DATA}/queue.json`
export const PLACE = `${DATA}/queue-place.json`
export const QUEUE_M3U = `${DATA}/queue.m3u`

export type Entry = { filename?: string; title?: string; current?: boolean }
type Event = Record<string, unknown>
type Watcher = { events: Event[]; wake: () => void; isClosed: boolean }

export type FakeOptions = {
  // HOME (default /home/me)
  home?: string
  // media-title of a player started (default: its URL)
  title?: string
  // more properties a started player has (time-pos, duration, metadata, chapter-metadata…)
  props?: Record<string, unknown>
  // the playlist mpv answers; its length is playlist-count. Without it, what
  // queue.m3u lists when it lists more than one.
  playlist?: Entry[] | (() => Entry[])
  chapters?: { title?: string }[]
  // answers a command first; undefined leaves it to the fake
  onCommand?: (command: unknown[]) => { data: unknown } | undefined
  // what `$.fs.exists` / `$.fs.stat` answer outside the data folder
  exists?: (path: string) => boolean
  stat?: (path: string) => { kind: 'file' | 'dir' | 'other' }
  // what `$.fs.list` answers for a folder
  list?: (path: string) => { name: string; kind: 'file' | 'dir' | 'other' }[]
  // the time a lock file is stamped with
  now?: () => number
  // `mpv --version` fails: no player installed
  noPlayer?: boolean
  // A started player has loaded its file before any watcher connects, as a
  // local file does: the watcher sees a position, and no file-loaded.
  loadsBeforeWatch?: boolean
  // A start this returns text for never plays: mpv prints the text (its
  // output, stdout and stderr, goes to the log) and exits before its socket.
  refuses?: (argv: string[]) => string | undefined
  // what state.json holds at the start, as an earlier session saved it
  saved?: Record<string, unknown>
  // answers a program run first (yt-dlp, curl), when it returns something:
  // a promise the test settles, for a listing that takes long
  run?: (argv: string[]) => Promise<{ exitCode: number; stdout: string }> | undefined
}

export function fakeMpv(on: On, options: FakeOptions = {}) {
  const watchers = new Set<Watcher>()
  let sockMtime: number | undefined
  let mtimes = 0
  let isLoaded = false
  const lockTimes: Record<string, number> = {}
  // what the playlist file a start was handed lists
  let listed: Entry[] | undefined
  const playlist = () => (typeof options.playlist === 'function' ? options.playlist() : options.playlist) ?? listed

  const world = {
    // the player argv of each start, the plugin's or another session's
    launches: [] as string[][],
    // what each start played first: the entry of its playlist file it starts at
    urls: [] as string[],
    // commands sent over IPC, pid probes left out
    sent: [] as unknown[][],
    // files in the data folder (the socket aside)
    files: (options.saved ? { [STATE]: JSON.stringify({ version: 1, ...options.saved }) } : {}) as Record<string, string>,
    // what state.json holds now; undefined while there is none
    saved: () => (STATE in world.files ? (JSON.parse(world.files[STATE]!) as Record<string, unknown>) : undefined),
    isRunning: false,
    props: {} as Record<string, unknown>,
    toasts: [] as string[],
    logs: [] as string[],
    // watchers following the player now
    watching: () => watchers.size,
    emit(event: Event) {
      for (const w of watchers) {
        w.events.push(event)
        w.wake()
      }
    },
    set(name: string, data: unknown) {
      world.props[name] = data
      world.emit({ event: 'property-change', name, data })
    },
    load() {
      isLoaded = true
      world.emit({ event: 'file-loaded' })
    },
    // The player goes away: with an end-file of `reason` (eof, quit, error…),
    // or none, as a crash or a kill -9 leaves it. The socket file stays.
    end(reason?: string) {
      if (!world.isRunning) return
      if (reason) world.emit({ event: 'end-file', reason })
      world.isRunning = false
      for (const w of watchers) {
        w.isClosed = true
        w.wake()
      }
    },
    // A player another session started and that already plays.
    play(url: string, extra: { title?: string; props?: Record<string, unknown> } = {}) {
      launch(['mpv', '--volume=60', '--loop-file=no', '--loop-playlist=inf', '--', url], { ...extra, props: { 'time-pos': 90, ...extra.props } })
      isLoaded = true
      world.props['user-data/stream-radio/url'] = url
      world.files[INTENT] = JSON.stringify({ id: 'other', url, client: '', isStopped: false, attempt: 0, playedAt: 1 })
      // the queue the other session played it from
      world.files[QUEUE_JSON] = JSON.stringify({ version: 1, rev: 1, entries: [{ id: '1.0', path: url }], arrangement: { kind: 'none' }, root: '', source: url })
    },
  }

  function launch(argv: string[], extra: { title?: string; props?: Record<string, unknown> } = {}) {
    world.launches.push(argv)
    const flag = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
    const file = flag('playlist') ?? argv.at(-1) ?? ''
    const lines = file.endsWith('.m3u') && file in world.files ? m3uEntries(world.files[file]!) : undefined
    listed = lines && lines.length > 1 ? lines : undefined
    const start = Number(flag('playlist-start') ?? 0)
    const url = lines?.[start]?.filename ?? lines?.[0]?.filename ?? file
    world.urls.push(url)
    const list = playlist()
    world.isRunning = true
    isLoaded = options.loadsBeforeWatch === true
    sockMtime = ++mtimes
    world.props = {
      'media-title': extra.title ?? options.title ?? url,
      pause: false,
      duration: false,
      volume: Number(flag('volume') ?? 100),
      'loop-file': flag('loop-file') ?? 'no',
      'loop-playlist': flag('loop-playlist') ?? 'no',
      'playlist-count': list?.length ?? 1,
      'playlist-pos': start > 0 && start < (list?.length ?? 1) ? start : Math.max(0, list?.findIndex(e => e.current) ?? 0),
      ...(options.loadsBeforeWatch ? { 'time-pos': 0 } : {}),
      ...options.props,
      ...extra.props,
    }
  }

  function command(c: unknown[]): { data: unknown } | undefined {
    const own = options.onCommand?.(c)
    if (own) return own
    const [verb, a, b] = c
    if (verb === 'get_property') {
      if (a === 'pid') return { data: 4242 }
      if (a === 'playlist') {
        const pos = world.props['playlist-pos']
        return { data: (playlist() ?? []).map((e, i) => ({ ...e, current: i === pos ? true : undefined })) }
      }
      if (a === 'chapter-list') return { data: options.chapters ?? [] }
      return { data: world.props[a as string] ?? null }
    }
    if (verb === 'set_property') world.set(a as string, b)
    else if (verb === 'playlist-play-index') {
      world.set('playlist-pos', a)
      world.load()
    } else if (verb === 'playlist-next' || verb === 'playlist-prev') {
      world.set('playlist-pos', Number(world.props['playlist-pos'] ?? 0) + (verb === 'playlist-next' ? 1 : -1))
      world.load()
    } else if (verb === 'seek') world.set('time-pos', a)
    else if (verb === 'quit') void Promise.resolve().then(() => world.end('quit'))
    return { data: null }
  }

  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
  const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never

  on('env.get', (_$, e) => {
    const name = (e as { name: string }).name
    return { value: name === 'XDG_STATE_HOME' ? '/tmp/stream-radio-test' : name === 'HOME' ? (options.home ?? '/home/me') : undefined } as never
  })
  on('ui.toast', (_$, e) => (world.toasts.push(e.text), { value: undefined }) as never)
  on('ui.log', (_$, e) => (world.logs.push(e.text), { value: undefined }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const own = options.run?.(argv)
    if (own) return own.then(r => ({ value: { ...r, stderr: '' } })) as never
    if (argv[0] === 'python3') {
      if (!world.isRunning || argv[3] !== SOCK) return fail()
      const c = JSON.parse(argv[4]!) as unknown[]
      if (!(c[0] === 'get_property' && c[1] === 'pid')) world.sent.push(c)
      const reply = command(c)
      return reply ? ok(JSON.stringify(reply.data)) : fail()
    }
    if (argv[0] === 'sh' && argv[2]?.includes('setsid')) {
      if (!argv[2].includes('>"$log" 2>&1')) throw new Error('mpv prints its errors to stdout: send both to the log')
      const refusal = options.refuses?.(argv.slice(5))
      if (refusal !== undefined) {
        world.launches.push(argv.slice(5))
        world.files[argv[4]!] = refusal
        return ok()
      }
      launch(argv.slice(5))
      return ok()
    }
    if (argv[0] === 'sh' && argv[2]?.includes('set -C')) {
      const path = argv[5]!
      if (path in world.files) return fail()
      world.files[path] = argv[4]!
      lockTimes[path] = options.now?.() ?? 0
      return ok()
    }
    if (argv[0] === 'rm') {
      const path = argv.at(-1)!
      if (path === SOCK) sockMtime = undefined
      delete world.files[path]
      return ok()
    }
    if (argv[0] === 'mv' && argv[1] === '-f') {
      const [from, to] = [argv[2]!, argv[3]!]
      if (!(from in world.files)) return fail()
      world.files[to] = world.files[from]!
      delete world.files[from]
      return ok()
    }
    if (argv[0] === 'kill') {
      world.end()
      return ok()
    }
    if (argv[1] === '--version') {
      if (options.noPlayer) throw new Error('ENOENT')
      return ok('mpv v0.41.0')
    }
    return ok()
  })
  on('process.spawn', async function* (_$, e, next) {
    const argv = [...e.argv]
    if (argv[4] !== '--watch' || !world.isRunning) return { value: { code: 1, signal: null } } as never
    const names = JSON.parse(argv[5]!) as string[]
    const w: Watcher = { events: [], wake: () => undefined, isClosed: false }
    const initial = (name: string) => ({ event: 'property-change', name, ...(name in world.props ? { data: world.props[name] } : {}) })
    // A player not yet loaded has no position; its load comes after.
    for (const name of names) if (isLoaded || name !== 'time-pos') w.events.push(initial(name))
    if (!isLoaded) {
      isLoaded = true
      w.events.push({ event: 'file-loaded' })
      if ('time-pos' in world.props) w.events.push(initial('time-pos'))
    }
    watchers.add(w)
    // The engine aborts this when the stream is returned, as it kills a real
    // child: the watcher ends even while it waits on a quiet player.
    next.signal.addEventListener('abort', () => {
      w.isClosed = true
      w.wake()
    })
    try {
      for (;;) {
        if (w.events.length > 0) {
          // in one piece, as a pipe may hand them over
          const text = w.events.map(ev => `${JSON.stringify(ev)}\n`).join('')
          w.events = []
          yield { stream: 'stdout', text } as never
          continue
        }
        if (w.isClosed) break
        await new Promise<void>(resolve => (w.wake = resolve))
      }
    } finally {
      watchers.delete(w)
    }
    return { value: { code: 0, signal: null } } as never
  })
  on('fs.read', (_$, e) => {
    if (!(e.path in world.files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: world.files[e.path] } as never
  })
  on('fs.list', (_$, e) => {
    const entries = options.list?.(e.path)
    if (!entries) throw new Error(`ENOENT: ${e.path}`)
    return { value: entries.map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.write', (_$, e) => ((world.files[e.path] = e.text), { value: undefined }) as never)
  on('fs.exists', (_$, e) => {
    if (e.path === SOCK) return { value: sockMtime !== undefined } as never
    // the data folder holds what is in it; `exists` answers for the rest
    return { value: e.path in world.files || (!e.path.startsWith(`${DATA}/`) && (options.exists?.(e.path) ?? false)) } as never
  })
  on('fs.stat', (_$, e) => {
    if (e.path === SOCK) {
      if (sockMtime === undefined) throw new Error('ENOENT')
      return { value: { kind: 'other', size: 0, mtimeMs: sockMtime, isLink: false } } as never
    }
    if (e.path in world.files) return { value: { kind: 'file', size: 0, mtimeMs: lockTimes[e.path] ?? 0, isLink: false } } as never
    const kind = options.stat?.(e.path)
    if (!kind) throw new Error(`ENOENT: ${e.path}`)
    return { value: { size: 0, mtimeMs: 0, isLink: false, ...kind } } as never
  })
  return world
}

// The entries of an .m3u as mpv reads them: each line a file, titled by the
// #EXTINF before it.
function m3uEntries(text: string): Entry[] {
  const out: Entry[] = []
  let title: string | undefined
  for (const line of text.split('\n').map(l => l.trim())) {
    if (!line) continue
    if (line.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/.exec(line)
      if (m) title = m[1]
      continue
    }
    out.push(title ? { filename: line, title } : { filename: line })
    title = undefined
  }
  return out
}

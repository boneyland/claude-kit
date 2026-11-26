import net from 'node:net'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import type { Host, PlayerKeys, StateStore, WatchStream } from '@core/host'
import { NO_QUEUE, NO_RESUME } from '@core/player'
import { libraryDir, stateDir } from '@core/paths'

const CONNECT_MS = 2000
const OVERALL_MS = 3000
const WATCHED = new Set(['property-change', 'start-file', 'file-loaded', 'end-file'])

// The mod's atom defaults. A function: each store gets its own arrays.
const defaults = (): PlayerKeys => ({
  playing: '',
  isPaused: false,
  elapsed: -1,
  chapter: '',
  lastUrl: '',
  queue: NO_QUEUE,
  openFolders: [],
  filter: '',
  resumeAt: NO_RESUME,
  volume: 60,
  repeat: 'all',
  isShuffled: false,
})

// The player's state in memory; onChange tells the drawing side to redraw.
export function memoryStore(onChange: () => void): StateStore {
  const values = defaults()
  return {
    read: async key => values[key],
    change: async (key, fn) => {
      values[key] = fn(values[key])
      onChange()
      return values[key]
    },
  }
}

// A connection to mpv's socket, or undefined when nothing listens (within 2 s).
function connect(path: string): Promise<net.Socket | undefined> {
  return new Promise(resolve => {
    const s = net.connect(path)
    const done = (v: net.Socket | undefined) => {
      clearTimeout(timer)
      s.removeAllListeners('error')
      s.on('error', () => undefined)
      if (!v) s.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(undefined), CONNECT_MS)
    s.once('connect', () => done(s))
    s.once('error', () => done(undefined))
  })
}

function ipc(path: string, command: readonly unknown[]): Promise<{ data: unknown } | undefined> {
  return new Promise(resolve => {
    let sock: net.Socket | undefined
    const finish = (v: { data: unknown } | undefined) => {
      clearTimeout(timer)
      sock?.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish(undefined), OVERALL_MS)
    void connect(path).then(s => {
      if (!s) return finish(undefined)
      sock = s
      let buf = ''
      s.on('data', d => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          let msg: { request_id?: unknown; error?: unknown; data?: unknown }
          try {
            msg = JSON.parse(l)
          } catch {
            continue
          }
          if (msg && msg.request_id === 7) return finish(msg.error === 'success' ? { data: msg.data } : undefined)
        }
      })
      s.on('close', () => finish(undefined))
      s.on('error', () => finish(undefined))
      s.write(JSON.stringify({ command, request_id: 7 }) + '\n')
    })
  })
}

// Lines in `mpv-ipc.py --watch`'s format. Not an async generator: its return()
// would wait for the next yield; this one ends the watch at once.
function watch(path: string, props: readonly string[]): WatchStream {
  const queue: string[] = []
  let waiting: ((r: IteratorResult<string, undefined>) => void) | undefined
  let isDone = false
  let sock: net.Socket | undefined
  const last = new Map<string, unknown>()

  const end = () => {
    isDone = true
    sock?.destroy()
    waiting?.({ done: true, value: undefined })
    waiting = undefined
  }
  const emit = (line: string) => {
    if (waiting) {
      waiting({ done: false, value: line })
      waiting = undefined
    } else queue.push(line)
  }
  const onLine = (l: string) => {
    let d: Record<string, unknown>
    try {
      d = JSON.parse(l)
    } catch {
      return
    }
    if (!d || typeof d !== 'object' || typeof d.event !== 'string' || !WATCHED.has(d.event)) return
    const name = d.name
    if (d.event === 'property-change' && (name === 'time-pos' || name === 'duration')) {
      const t = name === 'duration' ? typeof d.data === 'number' : typeof d.data === 'number' ? Math.trunc(d.data) : null
      if (last.has(name) && last.get(name) === t) return
      last.set(name, t)
      d.data = t
    }
    delete d.id
    emit(JSON.stringify(d) + '\n')
  }

  void connect(path).then(s => {
    if (!s) return end()
    if (isDone) return s.destroy()
    sock = s
    let buf = ''
    s.on('data', c => {
      buf += c.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) if (l) onLine(l)
    })
    s.on('close', end)
    s.on('error', end)
    props.forEach((p, i) => s.write(JSON.stringify({ command: ['observe_property', i + 1, p] }) + '\n'))
  })

  const it: WatchStream = {
    next() {
      const line = queue.shift()
      if (line !== undefined) return Promise.resolve({ done: false, value: line })
      if (isDone) return Promise.resolve({ done: true, value: undefined })
      return new Promise(res => (waiting = res))
    },
    async return() {
      queue.length = 0
      end()
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return it
    },
  }
  return it
}

function run(argv: readonly string[], opts?: { timeoutMs?: number }) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const [cmd, ...args] = argv
    execFile(cmd, args, { timeout: opts?.timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ exitCode: 0, stdout, stderr })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      // the process ran and failed (or was killed): a result; it never started: a throw
      if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr })
      if (e.killed) return resolve({ exitCode: 124, stdout, stderr })
      reject(err)
    })
  })
}

export type HostOptions = {
  // read for the home and data folders; default process.env
  env?: Record<string, string | undefined>
  // replaces running real processes (tests)
  run?: Host['run']
  // where the player's messages go: the screen belongs to the UI, so by default nowhere
  onToast?(text: string): void
  onLog?(text: string, to?: 'debug'): void
}

export function nodeHost(events: Host['events'], state: StateStore, opts: HostOptions = {}): Host {
  const env = opts.env ?? process.env
  return {
    program: 'tui',
    run: opts.run ?? run,
    ipc,
    watch,
    now: async () => Date.now(),
    sleep: ms => new Promise(res => setTimeout(res, ms)),
    every: (ms, fn) => {
      const t = setInterval(fn, ms)
      return { cancel: () => clearInterval(t) }
    },
    fs: {
      read: path => fs.readFile(path, 'utf8'),
      write: async (path, text) => {
        await fs.writeFile(path, text)
      },
      exists: path => fs.access(path).then(() => true, () => false),
      stat: async path => {
        const s = await fs.stat(path)
        return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', mtimeMs: s.mtimeMs }
      },
      list: async path =>
        (await fs.readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : 'other' }) as const),
    },
    home: async () => env.HOME ?? '',
    cwd: async () => process.cwd(),
    dataDir: () => stateDir(name => Promise.resolve(env[name])),
    libraryDir: () => libraryDir(name => Promise.resolve(env[name])),
    vars: state,
    log: (text, to) => opts.onLog?.(text, to),
    toast: text => opts.onToast?.(text),
    events,
  }
}

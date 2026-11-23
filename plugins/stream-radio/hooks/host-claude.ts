// The player core's Host on Claude Code's `$`: each method is the `$` call the
// mod made before the core existed, so the player behaves as it always has.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Host, Queue, Resume, StateStore } from '../core/host'
import type { Repeat } from '../core/nowplaying'
import type { Queue as ContractQueue, Resume as ContractResume } from '../types'

// The state contract must be self-contained, so it spells Queue and Resume out
// itself; these fail to compile the moment the two copies drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const QUEUE_MATCHES: Same<Queue, ContractQueue> = true
const RESUME_MATCHES: Same<Resume, ContractResume> = true
void QUEUE_MATCHES
void RESUME_MATCHES

// Talks to mpv's IPC socket: one command, or --watch to follow properties.
const IPC = 'hooks/mpv-ipc.py'

const NO_QUEUE: Queue = { kind: 'none', items: [], current: -1, paths: [], root: '' }
const NO_RESUME: Resume = { url: '', index: -1, seconds: -1, title: '' }

// One atom per player key, with the defaults the mod has always had.
const atoms = {
  playing: atom({ plugin: 'stream-radio', key: 'playing' } as const, ''),
  isPaused: atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false),
  elapsed: atom({ plugin: 'stream-radio', key: 'elapsed' } as const, -1),
  chapter: atom({ plugin: 'stream-radio', key: 'chapter' } as const, ''),
  lastUrl: atom({ plugin: 'stream-radio', key: 'lastUrl' } as const, ''),
  knownDefault: atom({ plugin: 'stream-radio', key: 'knownDefault' } as const, ''),
  queue: atom({ plugin: 'stream-radio', key: 'queue' } as const, NO_QUEUE),
  openFolders: atom({ plugin: 'stream-radio', key: 'openFolders' } as const, [] as string[]),
  filter: atom({ plugin: 'stream-radio', key: 'filter' } as const, ''),
  resumeAt: atom({ plugin: 'stream-radio', key: 'resumeAt' } as const, NO_RESUME),
  volume: atom({ plugin: 'stream-radio', key: 'volume' } as const, 60),
  repeat: atom({ plugin: 'stream-radio', key: 'repeat' } as const, 'all' as Repeat),
  isShuffled: atom({ plugin: 'stream-radio', key: 'isShuffled' } as const, false),
}

// The drawing reads these atoms directly; the core reaches them through the store.
export { atoms }

function storeOf($: EngineInterface): StateStore {
  return {
    get: key => read($, atoms[key] as never) as never,
    update: (key, fn) => update($, atoms[key] as never, fn as never) as never,
  }
}

export function hostOf($: EngineInterface, events: Host['events']): Host {
  const ipcArgv = (socket: string, ...rest: string[]) => ['python3', '-I', `${$.plugin.root}/${IPC}`, socket, ...rest]
  return {
    program: 'mod',
    run: (argv, opts) => $.process.run(argv, opts),
    async ipc(socket, command) {
      const result = await $.process.run(ipcArgv(socket, JSON.stringify(command)), { timeoutMs: 3000 }).catch(() => undefined)
      if (result?.exitCode !== 0) return undefined
      try {
        return { data: JSON.parse(result.stdout || 'null') as unknown }
      } catch {
        return { data: null }
      }
    },
    async *watch(socket, props) {
      const stream = $.process.spawn({ argv: ipcArgv(socket, '--watch', JSON.stringify(props)) })
      try {
        for await (const { stream: from, text } of stream) {
          if (from !== 'stderr') yield text
        }
      } finally {
        await stream.return(undefined as never).catch(() => undefined)
      }
    },
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    every: (ms, fn) => $.clock.every(ms, fn),
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path),
    },
    env: name => $.env.get(name),
    cwd: () => $.session.cwd(),
    dataDir: async () => (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA ?? '',
    saved: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value as never) },
    state: storeOf($),
    log: text => void $.ui.log(text, { to: 'debug' }),
    toast: text => void $.ui.toast(text),
    events,
  }
}


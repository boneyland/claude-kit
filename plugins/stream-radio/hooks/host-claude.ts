// The player core's Host on Claude Code's `$`: each method is the `$` call the
// mod made before the core existed, so the player behaves as it always has.
import type { EngineInterface } from 'claude-code'

import { stateDir } from '../core/paths'
import type { Host, Queue, Resume, StateStore, WatchStream } from '../core/host'
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

export function hostOf($: EngineInterface, vars: StateStore, events: Host['events']): Host {
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
    // Not an async generator: a generator's return() waits until its body
    // next yields, which leaves the watcher running on a quiet player. This
    // hands return() straight to the process stream, which kills it at once.
    watch(socket, props) {
      const stream = $.process.spawn({ argv: ipcArgv(socket, '--watch', JSON.stringify(props)) })
      const it: WatchStream = {
        async next() {
          for (;;) {
            const step = await stream.next()
            if (step.done) return { done: true, value: undefined }
            if (step.value.stream !== 'stderr') return { done: false, value: step.value.text }
          }
        },
        async return() {
          await stream.return(undefined as never).catch(() => undefined)
          return { done: true, value: undefined }
        },
        [Symbol.asyncIterator]() {
          return it
        },
      }
      return it
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
    home: async () => (await $.env.get('HOME')) ?? '',
    cwd: () => $.session.cwd(),
    dataDir: () => stateDir(name => (name === 'XDG_STATE_HOME' ? $.env.get('XDG_STATE_HOME') : $.env.get('HOME'))),
    vars,
    log: (text, to) => void (to ? $.ui.log(text, { to }) : $.ui.log(text)),
    toast: text => void $.ui.toast(text),
    events,
  }
}


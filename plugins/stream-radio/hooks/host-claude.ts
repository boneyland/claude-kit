// The player core's Host on Claude Code's `$`: each method is the `$` call the
// mod made before the core existed, so the player behaves as it always has.
import type { EngineInterface } from 'claude-code'

import type { Host, Queue, Resume, StateStore } from '../core/host'
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
    home: async () => (await $.env.get('HOME')) ?? '',
    cwd: () => $.session.cwd(),
    dataDir: async () => (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA ?? '',
    saved: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value as never) },
    vars,
    log: (text, to) => void (to ? $.ui.log(text, { to }) : $.ui.log(text)),
    toast: text => void $.ui.toast(text),
    events,
  }
}


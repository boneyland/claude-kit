import type { Host } from '@core/host'
import { checkDefault, connect, detach, loadLast, loadRepeat, loadVolume, locate, start, stopPoller } from '@core/player'
import { DEFAULT_CONFIG, loadConfig, type TuiConfig } from './config'
import { memoryStore, nodeHost } from './host-node'

export type SessionOptions = {
  env?: Record<string, string | undefined>
  run?: Host['run']
  // called whenever the player's state or the status text changes
  onChange?: () => void
}

export type Session = {
  host: Host
  config: TuiConfig
  // Lets go of the player (it plays on): nothing is sent to mpv.
  close(): void
  // The last message the player gave (a failed start, a missing file); '' for none.
  status(): string
  // Counts what the player has said: the same text said again is new news.
  statusSeq(): number
}

// Opens the terminal player's session: loads config and saved state, follows
// the live shared player if there is one (or watches for one), and plays
// argv[0] when given. A failed start shows in status(), it is never thrown.
export async function openSession(argv: string[], opts: SessionOptions = {}): Promise<Session> {
  const env = opts.env ?? process.env
  const onChange = opts.onChange ?? (() => undefined)
  let status = ''
  let statusSeq = 0
  let isClosed = false
  const say = (text: string) => {
    if (isClosed) return
    status = text
    statusSeq += 1
    onChange()
  }
  const base = nodeHost({ titleChanged: onChange, watching: onChange }, memoryStore(onChange), {
    env,
    run: opts.run,
    onToast: say,
  })
  // After close() the host refuses new work: a start still in flight must not
  // arm a timer or open a watcher that keeps Node alive.
  const host: Host = {
    ...base,
    every: (ms, fn) => (isClosed ? { cancel: () => undefined } : base.every(ms, fn)),
    watch: (sock, props) => {
      if (!isClosed) return base.watch(sock, props)
      const done = { done: true as const, value: undefined }
      const it: ReturnType<Host['watch']> = {
        next: async () => done,
        return: async () => done,
        [Symbol.asyncIterator]: () => it,
      }
      return it
    },
  }
  let config: TuiConfig = { ...DEFAULT_CONFIG }
  try {
    config = await loadConfig(env)
    await checkDefault(host, config.defaultUrl)
    await loadLast(host)
    await loadVolume(host, config.volume)
    await loadRepeat(host)
    await connect(host, config)

    if (argv[0]) {
      const target = await locate(host, argv[0], config.defaultUrl)
      if (target.kind === 'play') start(host, config, target.url)
      else if (target.kind === 'error') say(target.text)
    }
  } catch (error) {
    say(`Could not set up the player: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    host,
    config,
    // A reconnect already waiting in the core (2, 5 or 15 s) still finishes
    // after q: the terminal is back, but the process lives up to about 15 s to
    // restart the music. Deliberate: quitting never stops the music.
    close() {
      isClosed = true
      detach()
      stopPoller()
    },
    status: () => status,
    statusSeq: () => statusSeq,
  }
}

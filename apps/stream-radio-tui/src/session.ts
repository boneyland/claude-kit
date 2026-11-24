import type { Host } from '../../../plugins/stream-radio/core/host'
import { checkDefault, connect, detach, loadLast, loadRepeat, loadVolume, locate, start, stopPoller } from '../../../plugins/stream-radio/core/player'
import { loadConfig, type TuiConfig } from './config'
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
}

// Opens the terminal player's session: loads config and saved state, follows
// the live shared player if there is one (or watches for one), and plays
// argv[0] when given. A failed start shows in status(), it is never thrown.
export async function openSession(argv: string[], opts: SessionOptions = {}): Promise<Session> {
  const env = opts.env ?? process.env
  const onChange = opts.onChange ?? (() => undefined)
  let status = ''
  let isClosed = false
  const say = (text: string) => {
    if (isClosed) return
    status = text
    onChange()
  }
  const host = nodeHost({ titleChanged: onChange, watching: onChange }, memoryStore(onChange), {
    env,
    run: opts.run,
    onToast: say,
  })
  const config = await loadConfig(env)

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

  return {
    host,
    config,
    close() {
      isClosed = true
      detach()
      stopPoller()
    },
    status: () => status,
  }
}

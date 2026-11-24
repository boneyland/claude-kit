import type { Host } from './host'

// Where the player keeps its files: one fixed folder, so every program that
// drives the same player (the mod, a terminal player) finds the same socket.
export async function stateDir(env: (name: string) => Promise<string | undefined>): Promise<string> {
  const state = await env('XDG_STATE_HOME')
  if (state) return `${state}/stream-radio`
  const home = await env('HOME')
  return home ? `${home}/.local/state/stream-radio` : ''
}

// ONE player for every session. mpv runs detached from all of them (setsid),
// listening on one socket in the player's folder, and keeps playing until
// someone stops it. Next to it in that folder:
// - player.json, what was last asked of the player (Intent): every session
//   reads it when the player goes away, to tell a stop or a new start from a
//   drop worth reconnecting;
// - reconnect.lock, held by the one session that reconnects after a drop;
// - mpv.log, the player's errors, for saying why something would not play;
// - state.json, what is kept across sessions and shared with the TUI (saved.ts).
export type Paths = { sock: string; intent: string; lock: string; log: string; state: string }
let dataDir: string | undefined

export async function paths(h: Host): Promise<Paths> {
  // Not kept while empty: a hook that cannot tell where the folder is must not
  // pin the files to the filesystem root for the rest of the session.
  if (!dataDir) {
    dataDir = await h.dataDir()
    // The first time the folder is known, make sure it exists.
    if (dataDir) await h.run(['mkdir', '-p', dataDir], { timeoutMs: 3000 }).catch(() => undefined)
  }
  return { sock: `${dataDir}/mpv.sock`, intent: `${dataDir}/player.json`, lock: `${dataDir}/reconnect.lock`, log: `${dataDir}/mpv.log`, state: `${dataDir}/state.json` }
}

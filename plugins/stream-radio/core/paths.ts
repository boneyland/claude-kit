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
// queue: the queue once edited, as a playlist file the player plays.
export type Paths = { sock: string; intent: string; lock: string; log: string; state: string; queue: string }
let dataDir: string | undefined

export async function paths(h: Host): Promise<Paths> {
  // Not kept while empty: a hook that cannot tell where the folder is must not
  // pin the files to the filesystem root for the rest of the session.
  if (!dataDir) {
    dataDir = await h.dataDir()
    // The first time the folder is known, make sure it exists.
    if (dataDir) await h.run(['mkdir', '-p', dataDir], { timeoutMs: 3000 }).catch(() => undefined)
  }
  return { sock: `${dataDir}/mpv.sock`, intent: `${dataDir}/player.json`, lock: `${dataDir}/reconnect.lock`, log: `${dataDir}/mpv.log`, state: `${dataDir}/state.json`, queue: `${dataDir}/queue.m3u` }
}

// What mpv's directory filter plays: its sound, video and playlist kinds.
export const PLAYABLE_EXTS: ReadonlySet<string> = new Set(
  'mp3 flac ogg oga opus m4a aac wav wma alac ape wv aiff aif mka mpc tta dsf dff mp4 m4v mkv webm avi mov wmv flv ts mpg mpeg m3u m3u8 pls cue'.split(' '),
)

// A file mpv would play from a folder; a dotfile never.
export function isPlayable(name: string): boolean {
  if (name.startsWith('.')) return false
  const dot = name.lastIndexOf('.')
  return dot > 0 && PLAYABLE_EXTS.has(name.slice(dot + 1).toLowerCase())
}

// Names in the order a person reads them: 2 before 10, any case.
export const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// A folder's playable files, through its subfolders (dot-folders skipped), as
// absolute paths in name order.
export async function listSongs(h: Host, folder: string): Promise<string[]> {
  const base = folder.replace(/\/+$/, '') || '/'
  const entries = await h.fs.list(base)
  const songs: string[] = []
  for (const e of entries) {
    const path = `${base === '/' ? '' : base}/${e.name}`
    if (e.kind === 'dir' && !e.name.startsWith('.')) songs.push(...(await listSongs(h, path)))
    else if (e.kind === 'file' && isPlayable(e.name)) songs.push(path)
  }
  return songs.sort(byName)
}

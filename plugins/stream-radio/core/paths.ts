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
// queue: the played order as a playlist file, the only thing mpv is handed.
// queueJson, place, prev, queueLock: the queue the app owns, where it got to,
// the last cleared queue, and the lock around changing it (storedFile.ts).
export type Paths = { sock: string; intent: string; lock: string; log: string; state: string; queue: string; queueJson: string; place: string; prev: string; queueLock: string }
let dataDir: string | undefined

export async function paths(h: Host): Promise<Paths> {
  // Not kept while empty: a hook that cannot tell where the folder is must not
  // pin the files to the filesystem root for the rest of the session.
  if (!dataDir) {
    dataDir = await h.dataDir()
    // The first time the folder is known, make sure it exists.
    if (dataDir) await h.run(['mkdir', '-p', dataDir], { timeoutMs: 3000 }).catch(() => undefined)
  }
  return { sock: `${dataDir}/mpv.sock`, intent: `${dataDir}/player.json`, lock: `${dataDir}/reconnect.lock`, log: `${dataDir}/mpv.log`, state: `${dataDir}/state.json`, queue: `${dataDir}/queue.m3u`, queueJson: `${dataDir}/queue.json`, place: `${dataDir}/queue-place.json`, prev: `${dataDir}/queue.prev.json`, queueLock: `${dataDir}/queue.lock` }
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

// The most songs a folder expands to; here rather than in expand.ts, which
// imports this file (expand.ts re-exports it).
export const MAX_SONGS = 10_000

// The resolved path of `path` (symlinks followed); undefined when it cannot be had.
async function realPath(h: Host, path: string): Promise<string | undefined> {
  try {
    const r = await h.run(['realpath', '-e', '--', path], { timeoutMs: 3000 })
    const out = r.stdout.replace(/\n$/, '')
    return r.exitCode === 0 && out.startsWith('/') ? out : undefined
  } catch {
    return undefined
  }
}

// A folder's playable files, through its subfolders (dot-folders skipped), as
// absolute paths in name order, at most `limit` of them: it stops walking once
// it has that many, so a folder of tens of thousands of files is not all listed.
// As mpv's own folder scan did: a symlink counts as what it points to (a linked
// folder is walked once, never back into one it came through), and a subfolder
// that cannot be read is skipped. Only the folder itself unreadable throws.
export async function listSongs(h: Host, folder: string, limit = MAX_SONGS): Promise<string[]> {
  const songs: string[] = []
  const top = folder.replace(/\/+$/, '') || '/'
  // resolved paths of the folders walked into through a link (and the top), so
  // a link loop ends; undefined until the first linked folder needs it
  let followed: Set<string> | undefined
  let rootReal = ''
  const childOf = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`
  // real: the folder's resolved path, as far as it is known ('' not yet)
  const walk = async (dir: string, real: string, isTop: boolean): Promise<void> => {
    let listing
    try {
      listing = await h.fs.list(dir)
    } catch (error) {
      if (isTop) throw error
      h.log?.(`stream-radio: skipped ${dir}: ${error instanceof Error ? error.message : String(error)}`, 'debug')
      return
    }
    const entries = listing.slice().sort((a, b) => byName(a.name, b.name))
    for (const e of entries) {
      if (songs.length >= limit) return
      if (e.name.startsWith('.')) continue
      const path = childOf(dir, e.name)
      let kind = e.kind
      if (kind === 'other') kind = (await Promise.resolve().then(() => h.fs.stat(path)).catch(() => undefined))?.kind ?? 'other'
      if (kind === 'dir') {
        if (e.kind === 'dir') {
          await walk(path, real && childOf(real, e.name), false)
          continue
        }
        // a linked folder: walked only when where it leads is known and new
        if (!followed) {
          rootReal = (await realPath(h, top)) ?? ''
          followed = new Set(rootReal ? [rootReal] : [])
        }
        if (!rootReal) continue
        const to = await realPath(h, path)
        // reached through no link: the top's resolved path and the rest as is
        const here = real || `${rootReal === '/' ? '' : rootReal}${top === '/' ? dir : dir.slice(top.length)}` || '/'
        if (!to || followed.has(to) || here === to || here.startsWith(`${to}/`)) continue
        followed.add(to)
        await walk(path, to, false)
      } else if (kind === 'file' && isPlayable(e.name)) songs.push(path)
    }
  }
  await walk(top, '', true)
  return songs
}

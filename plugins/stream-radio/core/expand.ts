// Turning what the person plays or adds into songs, so the app owns the list
// instead of handing mpv a folder or a playlist file to expand: a folder, a
// local or remote .m3u/.pls, a YouTube playlist, or one thing as it is.
import type { Host } from './host'
import { baseName } from './nowplaying'
import { isPlayable, listSongs, MAX_SONGS } from './paths'
import type { QueueEntry } from './stored'

export { MAX_SONGS }

// start: the entry to play first (a video link's own video in its playlist), else 0.
export type Expanded = { entries: QueueEntry[]; root: string; note: string; start: number }

export type Video = { url: string; title: string; channel: string }
export type PlaylistListing = { title: string; entries: Video[] } | { error: string }

// How many videos a listing reads at most, so a huge channel stays bounded.
const MAX_ENTRIES = 1000
// A playlist file inside a playlist file, this many levels.
const MAX_DEPTH = 3

const text = (v: unknown) => (typeof v === 'string' ? v : '')

// A YouTube (or other yt-dlp) playlist's videos, without fetching each one;
// a single video's URL lists that video alone.
export async function listPlaylist(h: Host, url: string): Promise<PlaylistListing> {
  let result
  try {
    result = await h.run(['yt-dlp', '--flat-playlist', '-J', '--playlist-end', String(MAX_ENTRIES), url], { timeoutMs: 60000 })
  } catch (error) {
    return { error: `yt-dlp couldn't run: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (result.exitCode !== 0) {
    const errors = result.stderr.split('\n').filter(l => l.startsWith('ERROR:'))
    const last = errors[errors.length - 1]
    return { error: last ? last.slice('ERROR:'.length).trim() : `yt-dlp failed (exit ${result.exitCode}).` }
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(result.stdout)
  } catch {
    return { error: "yt-dlp's listing couldn't be read." }
  }
  if (!data || typeof data !== 'object') return { error: "yt-dlp's listing couldn't be read." }
  const channelOf = (e: Record<string, unknown>) => text(e.channel) || text(e.uploader)
  // what the site lists is the network's word: a local path or file:// in it is dropped
  const fromNet = (u: string) => (isNetwork(u) ? u : '')
  if (!Array.isArray(data.entries)) {
    const one = fromNet(text(data.webpage_url)) || fromNet(text(data.original_url)) || url
    return { title: text(data.title) || one, entries: [{ url: one, title: text(data.title) || one, channel: channelOf(data) }] }
  }
  const entries = (data.entries as Record<string, unknown>[]).flatMap(e => {
    const u = e && typeof e === 'object' ? fromNet(text(e.url)) : ''
    return u ? [{ url: u, title: text(e.title) || u, channel: channelOf(e) }] : []
  })
  return { title: text(data.title) || url, entries }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s)
const extOf = (path: string) => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
const isPlaylistExt = (ext: string) => ext === 'm3u' || ext === 'pls'

// The path part of a URL, for its extension: '' when it does not parse.
function urlPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

// The lines of an .m3u or .pls as { line, title } in order, not yet resolved.
function parsePlaylist(body: string, ext: string): { line: string; title?: string }[] {
  const lines = body.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim())
  const out: { line: string; title?: string }[] = []
  if (ext === 'pls') {
    const files = new Map<string, string>()
    const titles = new Map<string, string>()
    for (const l of lines) {
      const m = /^(File|Title)(\d+)\s*=\s*(.*)$/i.exec(l)
      if (!m) continue
      ;(m[1]!.toLowerCase() === 'file' ? files : titles).set(m[2]!, m[3]!)
    }
    for (const [n, line] of [...files].sort((a, b) => Number(a[0]) - Number(b[0]))) if (line) out.push({ line, title: titles.get(n) || undefined })
    return out
  }
  let title: string | undefined
  for (const l of lines) {
    if (!l) continue
    if (l.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(l)
      if (m) title = m[1]!.trim() || undefined
      continue
    }
    out.push({ line: l, title })
    title = undefined
  }
  return out
}

// What a playlist (a YouTube list, or a remote file's lines) adds up to; room is
// how many more entries may still be added, shared down through nested files.
type Budget = { room: number; capped: boolean; notes: string[] }

function push(into: QueueEntry[], budget: Budget, entry: QueueEntry): boolean {
  if (budget.room <= 0) {
    budget.capped = true
    return false
  }
  into.push(entry)
  budget.room -= 1
  return true
}

// A remote playlist file's body, or undefined when it could not be fetched.
async function fetchBody(h: Host, url: string): Promise<string | undefined> {
  try {
    // http(s) only, redirects too: a playlist URL never reads a local file
    const r = await h.run(['curl', '-fsSL', '--max-filesize', '1048576', '--max-time', '10', '--proto', '=http,https', '--proto-redir', '=http,https', url], {
      timeoutMs: 15000,
    })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

// What a remote playlist may name: network streams, never a local file (mpv
// refuses those from a playlist it fetched; the queue file is local, so the
// rule is kept here, and wherever a list from the network becomes the queue's).
// mms, rtsp and rtmp stay for old internet radio lists; ytdl:// is how mpv's
// yt-dlp hook names a playlist's videos (yt-dlp itself refuses file://).
export const isNetwork = (s: string) => /^(https?|mms|mmsh|rtsp|rtmps?|ytdl):\/\//i.test(s)

// An HLS playlist is a stream, not a list of songs.
const isHls = (body: string) => /^﻿?\s*#EXTM3U/.test(body) && /^\s*#EXT-X-/m.test(body)

async function expandPlaylistFile(h: Host, source: string, depth: number, budget: Budget, into: QueueEntry[]): Promise<void> {
  const remote = isUrl(source)
  const ext = extOf(remote ? urlPath(source) : source)
  let body: string | undefined
  if (remote) body = await fetchBody(h, source)
  else body = await h.fs.read(source).catch(() => undefined)
  if (body === undefined) {
    if (remote) {
      // Maybe not a playlist at all (a stream that happens to end .m3u): add it as is.
      budget.notes.push(`Couldn't read the playlist at ${source}; added it as it is.`)
      push(into, budget, { path: source })
    } else budget.notes.push(`Couldn't read the playlist ${source}.`)
    return
  }
  if (remote && ext === 'm3u' && isHls(body)) {
    push(into, budget, { path: source })
    return
  }
  const folder = remote ? '' : source.replace(/\/[^/]*$/, '') || '/'
  for (const { line, title } of parsePlaylist(body, ext)) {
    if (budget.room <= 0) {
      budget.capped = true
      return
    }
    let resolved: string
    if (isUrl(line)) resolved = line
    else if (remote) {
      // a relative line is on the same server; a path from the root, file://
      // or any other scheme would be a local file or something else: dropped
      if (line.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(line)) {
        if (isNetwork(line)) push(into, budget, title ? { path: line, title } : { path: line })
        continue
      }
      try {
        resolved = new URL(line, source).href
      } catch {
        continue
      }
      if (!isNetwork(resolved)) continue
    } else if (/^file:\/\//i.test(line)) {
      try {
        resolved = decodeURIComponent(line.slice('file://'.length).replace(/^localhost(?=\/)/i, ''))
      } catch {
        continue
      }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      // mms://, rtsp:// and the like: one stream each, as they are.
      push(into, budget, title ? { path: line, title } : { path: line })
      continue
    } else resolved = line.startsWith('/') ? line : `${folder === '/' ? '' : folder}/${line}`
    const lineExt = extOf(isUrl(resolved) ? urlPath(resolved) : resolved)
    if (isPlaylistExt(lineExt)) {
      if (depth < MAX_DEPTH) await expandPlaylistFile(h, resolved, depth + 1, budget, into)
      continue
    }
    // Anything that is not a playable file name may be a folder ("Vol. 1").
    if (!isUrl(resolved) && (resolved.endsWith('/') || !isPlayable(baseName(resolved)))) {
      const st = await h.fs.stat(resolved.replace(/\/+$/, '') || '/').catch(() => undefined)
      if (st?.kind === 'dir') {
        const songs = await listSongs(h, resolved, budget.room + 1)
        for (const p of songs) if (!push(into, budget, { path: p })) break
        continue
      }
    }
    push(into, budget, title ? { path: resolved, title } : { path: resolved })
  }
}

// A YouTube video's id from its link: watch?v=ID, youtu.be/ID, /shorts/ID or
// /live/ID; '' for anything else.
function videoOf(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  const v = u.searchParams.get('v')
  if (v) return v
  if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.split('/')[1] ?? ''
  const m = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(u.pathname)
  return m && /(^|\.)youtube\.com$/i.test(u.hostname) ? m[1]! : ''
}

// What to queue for `source`: a folder's songs, a playlist file's lines, a
// YouTube playlist's videos, or the one thing itself (a file, a stream, a single
// video, an .m3u8 or a .cue). limit caps a long listing; note says when it did.
export async function expandSource(h: Host, source: string, limit = MAX_SONGS): Promise<Expanded> {
  const one = (): Expanded => ({ entries: [{ path: source }], root: '', note: '', start: 0 })
  if (isUrl(source)) {
    const ext = extOf(urlPath(source))
    if (isPlaylistExt(ext)) {
      const budget: Budget = { room: limit, capped: false, notes: [] }
      const entries: QueueEntry[] = []
      await expandPlaylistFile(h, source, 1, budget, entries)
      if (budget.capped) budget.notes.push(`Added the first ${limit} songs of ${source}.`)
      return { entries, root: '', note: budget.notes.join(' '), start: 0 }
    }
    let query = ''
    try {
      query = new URL(source).searchParams.has('list') ? 'list' : ''
    } catch {
      query = ''
    }
    if (ext === 'm3u8' || !query) return one()
    const listing = await listPlaylist(h, source)
    if ('error' in listing) return { entries: [{ path: source }], root: '', note: `Couldn't list ${source} (${listing.error}); added it as it is.`, start: 0 }
    const capped = listing.entries.length > limit
    const entries = listing.entries.slice(0, limit).map(v => ({ path: v.url, title: v.title }))
    // a link to a video in a playlist (v= and list=) starts at that video, as mpv did
    const video = videoOf(source)
    const start = video ? entries.findIndex(e => videoOf(e.path) === video) : -1
    return {
      entries,
      root: '',
      note: capped ? `Added the first ${limit} songs of ${source}.` : '',
      start: Math.max(0, start),
    }
  }
  const st = await h.fs.stat(source).catch(() => undefined)
  if (st?.kind === 'dir') {
    const found = await listSongs(h, source, limit + 1)
    const folder = source.replace(/\/+$/, '') || '/'
    const capped = found.length > limit
    return {
      entries: found.slice(0, limit).map(path => ({ path })),
      root: folder,
      note: capped ? `Added the first ${limit} songs of ${folder}.` : '',
      start: 0,
    }
  }
  if (isPlaylistExt(extOf(source))) {
    const budget: Budget = { room: limit, capped: false, notes: [] }
    const entries: QueueEntry[] = []
    await expandPlaylistFile(h, source, 1, budget, entries)
    if (budget.capped) budget.notes.push(`Added the first ${limit} songs of ${source}.`)
    return { entries, root: '', note: budget.notes.join(' '), start: 0 }
  }
  return one()
}

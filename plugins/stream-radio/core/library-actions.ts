// What the library does, for any front end to call: the song playing, the
// favourite toggle, adding to and removing from a playlist, playing one, and
// the history as text. Each answers with the line to show.
import type { Host } from './host'
import { FAVOURITES, addMissing, markOf, removeSongs, toggle, whenPlayed, type Play, type Song } from './library'
import { editPlaylist, listPlaylists, readHistory, readPlaylist } from './libraryFile'
import { baseName } from './nowplaying'
import { playEntries, type PlayerConfig } from './player'
import { played } from './stored'
import { readPlace, readStored } from './storedFile'

const BUSY = 'The library is busy; try again.'
const NOTHING = 'Nothing playing.'

// The queue's current entry (the first when the place has none), as a song;
// a chapter video is its whole entry. Undefined with an empty queue.
export async function playingSong(h: Host): Promise<Song | undefined> {
  const [q, place] = await Promise.all([readStored(h), readPlace(h)])
  const byPlace = place.current === null ? undefined : q.entries.find(e => e.id === place.current)
  const entry = byPlace ?? played(q)[0]
  if (!entry) return undefined
  const title = entry.title || (byPlace ? await h.vars.read('playing').catch(() => '') : '')
  return title ? { path: entry.path, title } : { path: entry.path }
}

// The playlist a typed name means (fav is Favourites; any case), or undefined.
async function resolve(h: Host, typed: string): Promise<{ name: string; file: string } | undefined> {
  const low = typed.trim().toLowerCase()
  const want = low === 'fav' ? FAVOURITES.toLowerCase() : low
  return (await listPlaylists(h)).find(l => l.name.toLowerCase() === want)
}

export async function toggleFavourite(h: Host, songs: readonly Song[]): Promise<string> {
  if (songs.length === 0) return NOTHING
  const home = await h.home().catch(() => '')
  let added = false
  const done = await editPlaylist(h, FAVOURITES, f => {
    added = markOf(f, songs, home) !== 'all'
    return toggle(f, songs, home)
  })
  if (done === 'busy') return BUSY
  return added ? `Added to ${FAVOURITES}.` : `Removed from ${FAVOURITES}.`
}

export async function addTo(h: Host, list: string, songs: readonly Song[]): Promise<string> {
  if (songs.length === 0) return NOTHING
  const target = await resolve(h, list)
  if (!target) return `No playlist called ${list}.`
  const home = await h.home().catch(() => '')
  let added = 0
  const done = await editPlaylist(h, target.name, f => {
    const r = addMissing(f, songs, home)
    added = r.added
    return r.file
  })
  if (done === 'busy') return BUSY
  return added > 0 ? `Added to ${target.name}.` : `Already in ${target.name}.`
}

export async function removeFrom(h: Host, list: string, songs: readonly Song[]): Promise<string> {
  if (songs.length === 0) return NOTHING
  const target = await resolve(h, list)
  if (!target) return `No playlist called ${list}.`
  const home = await h.home().catch(() => '')
  let removed = 0
  const done = await editPlaylist(h, target.name, f => {
    const r = removeSongs(f, songs, home)
    removed = r.removed
    return r.file
  })
  if (done === 'busy') return BUSY
  return removed > 0 ? `Removed from ${target.name}.` : `Not in ${target.name}.`
}

// Plays a saved playlist, or the history (newest first), as the queue from
// song `start`. Resolves to what to show, or '' when started.
export async function playList(h: Host, config: PlayerConfig, list: string, start = 0): Promise<string> {
  if (list.trim().toLowerCase() === 'history') {
    const plays = await readHistory(h)
    if (plays.length === 0) return 'Nothing played yet.'
    return playEntries(h, config, plays.map(p => (p.title ? { path: p.path, title: p.title } : { path: p.path })), '', start)
  }
  const target = await resolve(h, list)
  if (!target) return `No playlist called ${list}.`
  const songs = (await readPlaylist(h, target.name)).lines.flatMap(l => (l.kind === 'song' ? [l.song] : []))
  if (songs.length === 0) return `${target.name} is empty.`
  return playEntries(h, config, songs.map(s => (s.title ? { path: s.path, title: s.title } : { path: s.path })), target.file, start)
}

// The newest `n` plays, a line each; `now` in unix seconds.
export function historyText(plays: readonly Play[], now: number, n = 20): string {
  if (plays.length === 0) return 'Nothing played yet.'
  return plays.slice(0, n).map(p => `${whenPlayed(p.at, now)}  ${p.title || baseName(p.path)}`).join('\n')
}

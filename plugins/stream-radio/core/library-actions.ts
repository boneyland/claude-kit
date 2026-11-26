// What the library does, for any front end to call: the song playing, the
// favourite toggle, adding to and removing from a playlist, playing one, and
// the history as text. Each answers with the line to show.
import type { Host } from './host'
import { FAVOURITES, addMissing, markOf, removeSongs, songsOf, toggle, whenPlayed, type Mark, type Play, type Song } from './library'
import { GONE, editPlaylist, listPlaylists, readHistory, readPlaylist } from './libraryFile'
import { baseName } from './nowplaying'
import { playEntries, type PlayerConfig } from './player'
import { played, type QueueEntry } from './stored'
import { readPlace, readStored } from './storedFile'

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
  if (typeof done === 'string') return done
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
  }, { mustExist: target.name !== FAVOURITES })
  if (typeof done === 'string') return done
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
  }, { mustExist: target.name !== FAVOURITES })
  if (typeof done === 'string') return done
  return removed > 0 ? `Removed from ${target.name}.` : `Not in ${target.name}.`
}

export type PlayPlan = { entries: QueueEntry[]; source: string; name: string }

const entryOf = (s: Song): QueueEntry => (s.title ? { path: s.path, title: s.title } : { path: s.path })

// What playing a saved playlist, or the history (newest first), would start:
// the entries, what the queue is called, and the name to show; or the message
// to show when there is nothing to play.
export async function planList(h: Host, list: string): Promise<PlayPlan | string> {
  if (list.trim().toLowerCase() === 'history') {
    const plays = await readHistory(h)
    if (plays.length === 0) return 'Nothing played yet.'
    return { entries: plays.map(p => entryOf({ path: p.path, title: p.title })), source: '', name: 'history' }
  }
  const target = await resolve(h, list)
  if (!target) return `No playlist called ${list}.`
  const songs = songsOf(await readPlaylist(h, target.name))
  if (songs.length === 0) return `${target.name} is empty.`
  return { entries: songs.map(entryOf), source: target.file, name: target.name }
}

// Plays a saved playlist, or the history, as the queue from song `start`.
// Resolves to what to show, or '' when started.
export async function playList(h: Host, config: PlayerConfig, list: string, start = 0): Promise<string> {
  const plan = await planList(h, list)
  return typeof plan === 'string' ? plan : playEntries(h, config, plan.entries, plan.source, start)
}

// The newest `n` plays, a line each; `now` in unix seconds.
export function historyText(plays: readonly Play[], now: number, n = 20): string {
  if (plays.length === 0) return 'Nothing played yet.'
  return plays.slice(0, n).map(p => `${whenPlayed(p.at, now)}  ${p.title || baseName(p.path)}`).join('\n')
}

// A row of Add to playlist's checklist: a playlist, and how many of the songs
// acted on are in it.
export type ChecklistRow = { name: string; mark: Mark }

// How a checklist row draws its mark: every song in it, some, none.
export const MARK_GLYPH: Record<Mark, string> = { all: '✓', some: '–', none: ' ' }

export { GONE }

// Favourites, then the saved playlists by name, each marked from its file as it is now.
export async function checklistRows(h: Host, songs: readonly Song[]): Promise<ChecklistRow[]> {
  const home = await h.home().catch(() => '')
  const lists = await listPlaylists(h)
  return Promise.all(lists.map(async l => ({ name: l.name, mark: markOf(await readPlaylist(h, l.name), songs, home) })))
}

// A checklist row chosen: blank or – adds the songs missing, ✓ takes them all
// out. Resolves to what to say; a saved playlist no longer there says so and is left gone.
export async function toggleIn(h: Host, name: string, songs: readonly Song[]): Promise<string> {
  if (name === FAVOURITES) return toggleFavourite(h, songs)
  const home = await h.home().catch(() => '')
  let isAdding = false
  const done = await editPlaylist(h, name, f => {
    isAdding = markOf(f, songs, home) !== 'all'
    return toggle(f, songs, home)
  }, { mustExist: true }) // deleted or renamed elsewhere since the checklist read it: not made again
  if (typeof done === 'string') return done
  return isAdding ? `Added to ${name}.` : `Removed from ${name}.`
}

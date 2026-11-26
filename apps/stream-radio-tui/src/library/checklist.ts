import type { Host } from '@core/host'
import { FAVOURITES, markOf, toggle, type Mark, type Song } from '@core/library'
import { toggleFavourite } from '@core/library-actions'
import { editPlaylist, listMtime, listPlaylists, readPlaylist } from '@core/libraryFile'

// A row of Add to playlist's checklist: a playlist, and how many of the songs
// acted on are in it.
export type ChecklistRow = { name: string; mark: Mark }

const BUSY = 'The playlists are busy; try again.'
export const GONE = 'That playlist is gone.'

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
  // deleted or renamed elsewhere since the checklist read it: not made again
  if ((await listMtime(h, name)) === 0) return GONE
  const home = await h.home().catch(() => '')
  let isAdding = false
  const done = await editPlaylist(h, name, f => {
    isAdding = markOf(f, songs, home) !== 'all'
    return toggle(f, songs, home)
  })
  if (done === 'busy') return BUSY
  return isAdding ? `Added to ${name}.` : `Removed from ${name}.`
}

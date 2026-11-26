// The Radio panel's library: the ★ button and Add to playlist's checklist,
// which act on the queue's song, and the picker of what the panel lists (the
// queue, Favourites, Recently played, each saved playlist). While the panel is
// open it looks at the lists' mtimes every 2 s and reads again what changed.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderElement, Timer } from 'claude-code'

import type { ChecklistSong, ShownList } from '../types'
import { FAVOURITES, songKey, songsOf, whenPlayed } from '../core/library'
import { GONE, MARK_GLYPH, checklistRows, playingSong, toggleFavourite, toggleIn } from '../core/library-actions'
import { createPlaylist, listMtime, listPlaylists, readHistory, readPlaylist } from '../core/libraryFile'
import { baseName, fit, textWidth } from '../core/nowplaying'
import { paths } from '../core/paths'
import type { Host } from '../core/host'
import type { QueueEntry } from '../core/stored'

export const POLL_MS = 2000
// Recently played rows drawn at most; a click still plays the whole history.
const HISTORY_ROWS = 200
const QUEUE_VIEW = 'queue'
const HISTORY_VIEW = 'history'
const FAV_VIEW = 'fav'
const LIST = 'list:'

// What the panel lists: queue, fav, history or list:<name>.
const listView = atom({ plugin: 'stream-radio', key: 'listView' } as const, QUEUE_VIEW)
const NO_LIST: ShownList = { view: QUEUE_VIEW, name: '', source: '', songs: [], isGone: false }
const shownList = atom({ plugin: 'stream-radio', key: 'shownList' } as const, NO_LIST)
// The saved playlists by name, Favourites aside.
const listNames = atom({ plugin: 'stream-radio', key: 'listNames' } as const, [] as string[])
// Whether the queue's song is in Favourites: the ★ filled.
const isFavourite = atom({ plugin: 'stream-radio', key: 'isFavourite' } as const, false)
// Add to playlist's checklist: the songs it was opened on (none: closed) and each list's mark.
const NO_CHECKLIST = { songs: [] as ChecklistSong[], rows: [] as { name: string; mark: 'all' | 'some' | 'none' }[] }
const checklist = atom({ plugin: 'stream-radio', key: 'checklist' } as const, NO_CHECKLIST)

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select'>

const nameOfView = (view: string) => (view === FAV_VIEW ? FAVOURITES : view.startsWith(LIST) ? view.slice(LIST.length) : '')

// The mtimes the last look saw; -1: read again.
const UNSEEN = { fav: -1, dir: -1, view: '', shown: -1 }
let seen = { ...UNSEEN }
let favKeys = new Set<string>()
let poller: Timer | undefined
let lastTitle: string | undefined
let running: Promise<void> | undefined
let again = false

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function viewMtime(h: Host, view: string): Promise<number> {
  if (view === HISTORY_VIEW) return h.fs.stat((await paths(h)).history).then(s => s.mtimeMs, () => 0)
  return listMtime(h, nameOfView(view))
}

async function readView(h: Host, view: string, mtime: number): Promise<ShownList> {
  if (view === HISTORY_VIEW) {
    const plays = await readHistory(h)
    return { view, name: 'Recently played', source: '', songs: plays.map(p => (p.title ? { path: p.path, title: p.title, at: p.at } : { path: p.path, at: p.at })), isGone: false }
  }
  const name = nameOfView(view)
  const songs = songsOf(await readPlaylist(h, name))
  return { view, name, source: `${await h.libraryDir()}/${name}.m3u`, songs, isGone: name !== FAVOURITES && mtime === 0 }
}

// One look: Favourites (for the ★), the folder (for the picker's names), the
// list shown and the checklist's marks, each read again only when its mtime moved.
async function look($: EngineInterface, h: Host) {
  const home = await h.home().catch(() => '')
  const favMtime = await listMtime(h, FAVOURITES)
  const isFavChanged = favMtime !== seen.fav
  if (isFavChanged) {
    favKeys = new Set(songsOf(await readPlaylist(h, FAVOURITES)).map(s => songKey(s.path, home)))
    seen.fav = favMtime
  }
  const dirMtime = await h.fs.stat(await h.libraryDir()).then(s => s.mtimeMs, () => 0)
  const isDirChanged = dirMtime !== seen.dir
  if (isDirChanged) {
    const names = (await listPlaylists(h)).map(l => l.name).filter(n => n !== FAVOURITES)
    seen.dir = dirMtime
    if (!same(names, await read($, listNames))) await update($, listNames, () => names)
  }
  const view = await read($, listView)
  if (view !== QUEUE_VIEW) {
    const mtime = await viewMtime(h, view)
    if (view !== seen.view || mtime !== seen.shown) {
      const shown = await readView(h, view, mtime)
      // the picker moved on while this read
      if ((await read($, listView)) === view) {
        await update($, shownList, () => shown)
        seen.view = view
        seen.shown = mtime
      }
    }
  } else seen.view = QUEUE_VIEW
  const open = await read($, checklist)
  if (open.songs.length > 0 && (isFavChanged || isDirChanged)) {
    const rows = await checklistRows(h, open.songs)
    await update($, checklist, c => (c.songs === open.songs || same(c.songs, open.songs) ? { ...c, rows } : c))
  }
  const song = await playingSong(h)
  const isFav = !!song && favKeys.has(songKey(song.path, home))
  if (isFav !== (await read($, isFavourite))) await update($, isFavourite, () => isFav)
}

// A look now; one asked while another runs follows it.
function refresh($: EngineInterface, h: Host): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await look($, h).catch(error => h.log(`stream-radio: could not read the playlists: ${error instanceof Error ? error.message : String(error)}`, 'debug'))
    } while (again)
  })().finally(() => (running = undefined))
  return running
}

// Everything read again: after a change made here.
function changed($: EngineInterface, h: Host): Promise<void> {
  seen = { ...UNSEEN }
  return refresh($, h)
}

// A poll: none once the panel is gone, even closed without a ui.close heard
// (its drawing threw, say).
async function tick($: EngineInterface, h: Host, pane: string) {
  const isOpen = await $.ui.panes().then(ps => ps.some(p => p.id === pane), () => true)
  if (!isOpen) return stopLibraryPoll()
  await refresh($, h)
}

export function stopLibraryPoll() {
  poller?.cancel()
  poller = undefined
  lastTitle = undefined
}

// The panel closed (or about to open): back to the queue, no checklist, no polling.
export async function resetLibrary($: EngineInterface) {
  stopLibraryPoll()
  seen = { ...UNSEEN }
  await update($, listView, () => QUEUE_VIEW)
  await update($, shownList, () => NO_LIST)
  await update($, checklist, () => NO_CHECKLIST)
}

const entryOf = (s: { path: string; title?: string }): QueueEntry => (s.title ? { path: s.path, title: s.title } : { path: s.path })

type Parts = {
  // the ★ and Add to playlist row, and the checklist when it is open
  controls: RenderElement
  // the list picker
  picker: RenderElement
  // the shown list's rows; undefined while the queue is shown
  list: RenderElement | undefined
}

// The library's parts of the panel. Drawing starts the polling (the panel is
// open); a new title is a song change and looks at once.
// act: runs work and shows its reply; later: shows a play's reply when it comes.
export async function libraryParts(
  $: EngineInterface,
  ui: Ui,
  opts: {
    host: () => Host
    // the panel's id
    pane: string
    hasQueue: boolean
    title: string
    width: number
    act: (work: () => Promise<string>) => Promise<void>
    later: (work: Promise<string>) => void
    playEntries: (h: Host, entries: QueueEntry[], source: string, start: number) => Promise<string>
  },
): Promise<Parts> {
  const { Box, Text, Button, Input, Select } = ui
  const { host, act, width } = opts
  if (!poller) {
    poller = $.clock.every(POLL_MS, () => void tick($, host(), opts.pane))
    void refresh($, host())
  } else if (opts.title !== lastTitle) void refresh($, host())
  lastTitle = opts.title
  const view = await read($, listView)
  const names = await read($, listNames)
  const isFav = await read($, isFavourite)
  const open = await read($, checklist)
  const shown = view === QUEUE_VIEW ? NO_LIST : await read($, shownList)

  const starLabel = `${isFav ? '★' : '☆'} Favourite (8)`
  const toggleStar = () =>
    act(async () => {
      const h = host()
      const song = await playingSong(h)
      if (!song) return 'Nothing playing.'
      const said = await toggleFavourite(h, [song])
      await changed($, h)
      return said
    })
  const openChecklist = () =>
    act(async () => {
      const h = host()
      // the song as the checklist opens: what every toggle in it acts on
      const song = await playingSong(h)
      if (!song) return 'Nothing playing.'
      const songs: ChecklistSong[] = [song.title ? { path: song.path, title: song.title } : { path: song.path }]
      const rows = await checklistRows(h, songs)
      await update($, checklist, () => ({ songs, rows }))
      return ''
    })
  const remark = async (h: Host, songs: ChecklistSong[]) => {
    const rows = await checklistRows(h, songs)
    await update($, checklist, c => (same(c.songs, songs) ? { ...c, rows } : c))
  }
  const toggleRow = (name: string) =>
    act(async () => {
      const h = host()
      const said = await toggleIn(h, name, open.songs)
      await remark(h, open.songs)
      await changed($, h)
      return said
    })
  const newPlaylist = (value: string) =>
    act(async () => {
      const h = host()
      const name = value.trim()
      const said = await createPlaylist(h, name, open.songs)
      if (said) return said
      await remark(h, open.songs)
      await changed($, h)
      return `Made the playlist "${name}".`
    })

  const songTitle = open.songs[0] ? open.songs[0].title || baseName(open.songs[0].path) : ''
  const controls = (
    <Box flexDirection="column">
      {opts.hasQueue ? (
        <Box flexDirection="row" gap={1}>
          <Button key="fav" label={starLabel} hotkey="8" onPress={toggleStar} />
          <Button key="add-to" label="Add to playlist… (a)" hotkey="a" onPress={openChecklist} />
        </Box>
      ) : (
        <Text dimColor>{'☆ Favourite · Add to playlist… (with a song in the queue)'}</Text>
      )}
      {open.songs.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>{fit(`Add to playlist · ${songTitle}`, width)}</Text>
          {open.rows.map(row => (
            <Button
              key={`check-${row.name}`}
              plain
              label={fit(`${MARK_GLYPH[row.mark]} ${row.name}`, width)}
              onPress={() => toggleRow(row.name)}
            />
          ))}
          <Input key="new-playlist" placeholder="+ New playlist… (type a name)" submitLabel="Enter to make it" onSubmit={(value: string) => newPlaylist(value)} />
          <Button key="check-close" label="Done (c)" hotkey="c" onPress={() => update($, checklist, () => NO_CHECKLIST)} />
        </Box>
      ) : null}
    </Box>
  )

  const options = [
    { value: QUEUE_VIEW, label: 'Queue' },
    { value: FAV_VIEW, label: FAVOURITES },
    { value: HISTORY_VIEW, label: 'Recently played' },
    ...names.map(n => ({ value: `${LIST}${n}`, label: n })),
  ]
  // a list deleted elsewhere while shown stays pickable until another is picked
  if (!options.some(o => o.value === view)) options.push({ value: view, label: `${nameOfView(view)} (gone)` })
  const picker = (
    <Select
      key="list"
      label="List: "
      options={options}
      value={view}
      onSelect={(value: string) =>
        void (async () => {
          await update($, listView, () => value)
          if (value !== QUEUE_VIEW) await refresh($, host())
        })().catch(() => undefined)
      }
    />
  )

  if (view === QUEUE_VIEW) return { controls, picker, list: undefined }
  const isHistory = view === HISTORY_VIEW
  const now = isHistory ? Math.floor((await host().now()) / 1000) : 0
  const songs = shown.view === view ? shown.songs : []
  const rows = isHistory ? songs.slice(0, HISTORY_ROWS) : songs
  const play = (i: number) =>
    act(async () => {
      // the list as shown when clicked
      opts.later(opts.playEntries(host(), songs.map(entryOf), shown.source, i))
      return ''
    })
  const list = (
    <Box flexDirection="column">
      {shown.isGone ? (
        <Text dimColor>{GONE}</Text>
      ) : shown.view === view && songs.length === 0 ? (
        <Text dimColor>{isHistory ? 'Nothing played yet.' : `${shown.name} is empty.`}</Text>
      ) : null}
      {rows.map((s, i) => {
        const name = `${i + 1}. ${s.title || baseName(s.path)}`
        if (isHistory && s.at !== undefined) {
          const when = whenPlayed(s.at, now)
          const label = fit(name, Math.max(1, width - textWidth(when) - 1))
          return (
            <Button key={`song-${i}`} plain label={label} onPress={() => play(i)}>
              {label} <Text dimColor>{when}</Text>
            </Button>
          )
        }
        const label = fit(name, width)
        return (
          <Button key={`song-${i}`} plain dimColor label={label} onPress={() => play(i)} />
        )
      })}
      {songs.length > rows.length ? <Text dimColor>{`and ${songs.length - rows.length} more`}</Text> : null}
    </Box>
  )
  return { controls, picker, list }
}

// What the footer shows: the stream's title, or empty when nothing plays.
export type Playing = string

// The queue's entries or the file's chapters, by title; current is the one
// playing, -1 when unknown.
// paths: each queue entry's file or URL; root: the local folder they were
// played from, '' for none, under which the panel groups them by folder.
export type Queue = { kind: 'playlist' | 'chapters' | 'none'; items: string[]; current: number; paths: string[]; root: string }

// Where a URL got to: its playlist entry (-1 without a playlist), the seconds
// into it (-1 for a live stream) and the song or chapter title.
export type Resume = { url: string; index: number; seconds: number; title: string }

// A song the checklist acts on.
export type ChecklistSong = { path: string; title?: string }

// The list the panel shows instead of the queue: its view (fav, history or
// list:<name>), its name, its file ('' for the history), its songs (with when
// each played, for the history) and whether it was deleted elsewhere.
export type ShownList = { view: string; name: string; source: string; songs: { path: string; title?: string; at?: number }[]; isGone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'stream-radio': {
      playing: Playing
      isPaused: boolean
      // How far into the current file, in seconds; -1 for a live stream or nothing playing.
      elapsed: number
      // The current chapter's title (often the song in a multi-song video); empty when none.
      chapter: string
      // The last URL that actually played; the idle button plays it again.
      lastUrl: string
      // How far a title too long for the footer has scrolled, in ticks.
      scroll: number
      // What the panel lists to pick from: the queue, else the file's chapters.
      queue: Queue
      // The folders the panel's queue shows open.
      openFolders: string[]
      // The reply to the panel's last action; empty for none.
      notice: string
      // The player's volume, 0 to 100.
      // all, one or off; kept across sessions.
      repeat: 'all' | 'one' | 'off'
      // What the panel's list is narrowed to; empty for all of it.
      filter: string
      // Whether the playing queue is shuffled.
      isShuffled: boolean
      volume: number
      // Where the last URL got to, kept across a reload.
      resumeAt: Resume
      // What the panel lists: queue, fav, history or list:<name>.
      listView: string
      // That list as last read; unused while the queue is shown.
      shownList: ShownList
      // The saved playlists by name, Favourites aside, for the picker.
      listNames: string[]
      // Whether the queue's song is in Favourites: the panel's ★ filled.
      isFavourite: boolean
      // Add to playlist's checklist: the songs it opened on (none: closed) and each list's mark.
      checklist: { songs: ChecklistSong[]; rows: { name: string; mark: 'all' | 'some' | 'none' }[] }
    }
  }
}

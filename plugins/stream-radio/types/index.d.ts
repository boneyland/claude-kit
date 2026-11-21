// What the footer shows: the stream's title, or empty when nothing plays.
export type Playing = string

// The playlist's entries or the file's chapters, by title; current is the one
// playing, -1 when unknown.
// paths: each playlist entry's file or URL; root: the local folder they were
// played from, '' for none, under which the panel groups them by folder.
export type Queue = { kind: 'playlist' | 'chapters' | 'none'; items: string[]; current: number; paths: string[]; root: string }

// Where a URL got to: its playlist entry (-1 without a playlist), the seconds
// into it (-1 for a live stream) and the song or chapter title.
export type Resume = { url: string; index: number; seconds: number; title: string }

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
      // The default stream the last load saw; a change clears lastUrl.
      knownDefault: string
      // How far a title too long for the footer has scrolled, in ticks.
      scroll: number
      // What the panel lists to pick from: the playlist, else the file's chapters.
      queue: Queue
      // The folders the panel's playlist shows open.
      openFolders: string[]
      // The reply to the panel's last action; empty for none.
      notice: string
      // The player's volume, 0 to 100.
      volume: number
      // Where the last URL got to, kept across a reload.
      resumeAt: Resume
    }
  }
}

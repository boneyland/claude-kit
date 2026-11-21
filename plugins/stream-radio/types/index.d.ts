// What the footer shows: the stream's title, or empty when nothing plays.
export type Playing = string

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
    }
  }
}

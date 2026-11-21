// What the footer shows: the stream's title, or empty when nothing plays.
export type Playing = string

declare module 'claude-code' {
  interface PluginState {
    'stream-radio': {
      playing: Playing
      isPaused: boolean
      // How far into the current file, 0 to 100; -1 for a live stream or nothing playing.
      percent: number
    }
  }
}

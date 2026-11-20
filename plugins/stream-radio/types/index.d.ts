// What the footer shows: the stream's title, or empty when nothing plays.
export type Playing = string

declare module 'claude-code' {
  interface PluginState {
    'stream-radio': {
      playing: Playing
    }
  }
}

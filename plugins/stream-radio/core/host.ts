// The seam between the player core and whatever runs it: the Claude Code mod
// (hooks/host-claude.ts, on `$`) or the standalone TUI (on Node). The core
// imports nothing from either: everything outside it comes through a Host.
import type { Repeat } from './nowplaying'

// Kept identical to types/index.d.ts (checked in hooks/host-claude.ts).
// The playlist's entries or the file's chapters, by title; current is the one
// playing, -1 when unknown.
// paths: each playlist entry's file or URL; root: the local folder they were
// played from, '' for none, under which the panel groups them by folder.
export type Queue = { kind: 'playlist' | 'chapters' | 'none'; items: string[]; current: number; paths: string[]; root: string }

// Kept identical to types/index.d.ts (checked in hooks/host-claude.ts).
// Where a URL got to: its playlist entry (-1 without a playlist), the seconds
// into it (-1 for a live stream) and the song or chapter title.
export type Resume = { url: string; index: number; seconds: number; title: string }

export type WatchStream = AsyncIterableIterator<string> & {
  return(value?: unknown): Promise<IteratorResult<string, unknown>>
}

export type RunResult = { exitCode: number; stdout: string; stderr: string }

// The player's state, by key: what the footer, the panel and the TUI draw from.
export type PlayerKeys = {
  // the stream's title, or empty when nothing plays
  playing: string
  isPaused: boolean
  // seconds into the current file; -1 for a live stream or nothing playing
  elapsed: number
  // the current chapter's title; empty when none
  chapter: string
  // the last URL that actually played
  lastUrl: string
  // the default stream the last load saw; a change clears lastUrl
  knownDefault: string
  // what there is to pick from: the playlist, else the file's chapters
  queue: Queue
  // the folders the playlist shows open
  openFolders: string[]
  // what the list is narrowed to; empty for all of it
  filter: string
  // where the last URL got to
  resumeAt: Resume
  // 0 to 100
  volume: number
  repeat: Repeat
  isShuffled: boolean
}

// Named read/change, not get/set: Claude Code's validator reads any
// `.state.get(` as its own `$.state.get`.
export interface StateStore {
  read<K extends keyof PlayerKeys>(key: K): Promise<PlayerKeys[K]>
  change<K extends keyof PlayerKeys>(key: K, fn: (prev: PlayerKeys[K]) => PlayerKeys[K]): Promise<PlayerKeys[K]>
}

export interface Host {
  program: 'mod' | 'tui'
  run(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<RunResult>
  // One mpv command on `socket`: its reply's data, or undefined when nothing
  // listens or mpv refused.
  ipc(socket: string, command: readonly unknown[]): Promise<{ data: unknown } | undefined>
  // The player's changes on `socket`, as chunks of `mpv-ipc.py --watch` lines;
  // ends when the player goes away. return() must end the watch at once, even
  // while it waits for the next chunk (a paused player sends none).
  watch(socket: string, props: readonly string[]): WatchStream
  now(): Promise<number>
  sleep(ms: number): Promise<void>
  every(ms: number, fn: () => void): { cancel(): void }
  fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other'; mtimeMs: number }>
  }
  // the person's home folder (HOME); empty when unknown
  home(): Promise<string>
  cwd(): Promise<string>
  // The folder holding mpv.sock, player.json, reconnect.lock and mpv.log.
  dataDir(): Promise<string>
  // Kept across sessions on this machine.
  saved: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  vars: StateStore
  // shown to the person, or only in the debug log with to 'debug'
  log(text: string, to?: 'debug'): void
  toast(text: string): void
  // What the drawing side reacts to: a new title (restart the scroll), and
  // following a player or not (run the scroller or stop it).
  events: { titleChanged(): void | Promise<void>; watching(isOn: boolean): void }
}

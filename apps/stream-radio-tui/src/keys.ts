import type { Key } from 'ink'
import type { Song } from '@core/library'
import type { Tab } from './ui/Tabs'
import type { Edit } from './ui/lineEdit'

// list: keys are commands; filter, open and name: keys edit a line of text
// (open's with a cursor, in the Files heading; name's a playlist's name, new or
// renamed, with a cursor); help: the key list shows, and keys scroll or close
// it; menu: a row's menu is open, and keys choose from it; checklist: Add to
// playlist's checklist is open, and keys choose and toggle its rows.
export type Mode = 'list' | 'filter' | 'open' | 'name' | 'help' | 'menu' | 'checklist'

export type Action =
  | { kind: 'up' }
  | { kind: 'down' }
  // PgUp, PgDn (by: page), Home, End (by: all): the cursor that far up (-1) or down
  | { kind: 'jump'; by: 'page' | 'all'; dir: 1 | -1 }
  // play the selected song, or open or shut the selected folder; play: from a
  // Playlists song's menu, the list as it was when the menu opened, and the song
  | { kind: 'enter'; play?: { songs: readonly Song[]; source: string; index: number } }
  | { kind: 'shutFolder' }
  | { kind: 'openFolder' }
  | { kind: 'pause' }
  | { kind: 'next' }
  | { kind: 'prev' }
  // seconds back (-) or ahead from where it is
  | { kind: 'seek'; by: number }
  // one step louder (1) or quieter (-1): the same change in loudness at any level
  | { kind: 'volume'; dir: 1 | -1 }
  | { kind: 'shuffle' }
  | { kind: 'repeat' }
  | { kind: 'filterMode' }
  | { kind: 'openMode' }
  | { kind: 'last' }
  | { kind: 'stop' }
  | { kind: 'quit' }
  // Ctrl-C: quits only when pressed twice in a row
  | { kind: 'interrupt' }
  | { kind: 'help' }
  | { kind: 'closeHelp' }
  // in a text mode
  | { kind: 'type'; text: string }
  | { kind: 'erase' }
  // open: the location being edited in the Files heading, with a cursor
  | { kind: 'lineEdit'; edit: Edit }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  // to the next tab (1) or the one before (-1)
  | { kind: 'tab'; dir: 1 | -1 }
  // the picked songs (or the cursor's) one place up (-1) or down
  | { kind: 'move'; by: 1 | -1 }
  // from: a Playlists song's menu, the songs it was opened on and their list
  | { kind: 'remove'; from?: { list: string; picks: readonly { index: number; song: Song }[] } }
  // the whole queue, stopping the player; from a key, only when pressed twice
  | { kind: 'clearQueue'; isSure?: boolean }
  // the cursor a row up or down, picking the rows from the anchor
  | { kind: 'extendPick'; by: 1 | -1 }
  | { kind: 'togglePick' }
  | { kind: 'clearPick' }
  // sort by the next field; by this one, the other way round
  | { kind: 'sortNext' }
  | { kind: 'sortReverse' }
  // Files: the picked rows (or the cursor's) to the queue's end, or to play
  // next; Playlists, from a list's menu: `list`, the list it was opened on
  | { kind: 'add'; where: 'end' | 'next'; list?: string; songs?: readonly Song[] }
  // Files: the folder above
  | { kind: 'folderUp' }
  // Files, at the folder of the song playing
  | { kind: 'goPlaying' }
  // the cursor's row's menu
  | { kind: 'menu' }
  // Playlists, from a list's menu (`name`: the list it was opened on, so a
  // poll that moves the rows meanwhile can't change which): play it from its
  // first song; rename it; delete it, or clear Recently played (each asks
  // first, then isSure)
  | { kind: 'playList'; name: string }
  | { kind: 'rename'; name: string }
  | { kind: 'deleteList'; name: string; isSure?: boolean }
  | { kind: 'clearHistory'; isSure?: boolean }
  // * and P: the picked rows' songs (or the cursor's; with no row, the song
  // playing) in or out of Favourites, or the checklist of playlists for them.
  // From a menu, `songs`: what it was opened on (toExpand: Files rows, a
  // folder still to be expanded into its songs); `isPlaying`: the song
  // playing, whatever the rows
  | ({ kind: 'favourite' } & LibraryOn)
  | ({ kind: 'addToList' } & LibraryOn)

// What favourite and addToList act on; neither field: the rows, as the keys do.
export type LibraryOn = { songs?: readonly Song[]; toExpand?: boolean; isPlaying?: boolean }

// How far b and f jump, as the mod's panel does.
export const SEEK_SECONDS = 10

const LETTERS: Record<string, Action> = {
  k: { kind: 'up' },
  j: { kind: 'down' },
  ' ': { kind: 'pause' },
  n: { kind: 'next' },
  p: { kind: 'prev' },
  b: { kind: 'seek', by: -SEEK_SECONDS },
  f: { kind: 'seek', by: SEEK_SECONDS },
  '+': { kind: 'volume', dir: 1 },
  '=': { kind: 'volume', dir: 1 },
  '-': { kind: 'volume', dir: -1 },
  s: { kind: 'shuffle' },
  r: { kind: 'repeat' },
  '/': { kind: 'filterMode' },
  o: { kind: 'openMode' },
  l: { kind: 'last' },
  x: { kind: 'stop' },
  q: { kind: 'quit' },
  '?': { kind: 'help' },
}

// No key held or named; a Keys to set one flag on.
export const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
}

// Ink's Key, with the Home and End keys its useInput leaves out (homeEnd reads them).
export type Keys = Key & { home?: boolean; end?: boolean }

// What terminals send for Home and End, unmodified (xterm, VT220, rxvt).
const HOME_END: Record<string, 'home' | 'end'> = {
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[7~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[8~': 'end',
}
// Whether a read from the terminal is the Home or End key; undefined for anything else.
export const homeEnd = (data: string | Buffer): 'home' | 'end' | undefined => HOME_END[String(data)]

// A key that edits the Files location.
const CTRL_EDITS: Record<string, Edit> = {
  a: { kind: 'start' },
  e: { kind: 'end' },
  u: { kind: 'eraseToStart' },
  k: { kind: 'eraseToEnd' },
  w: { kind: 'eraseWord' },
  d: { kind: 'eraseAfter' },
}
function lineKey(input: string, key: Keys): Edit | null {
  if (key.home) return { kind: 'start' }
  if (key.end) return { kind: 'end' }
  if (key.leftArrow) return { kind: 'left' }
  if (key.rightArrow) return { kind: 'right' }
  // Ink names the key most terminals send for Backspace (DEL) `delete`.
  if (key.backspace || key.delete) return { kind: 'erase' }
  if (key.ctrl) return CTRL_EDITS[input] ?? null
  if (key.meta || key.tab || !input || /[\x00-\x1f\x7f]/.test(input)) return null
  return { kind: 'insert', text: input }
}

// Which tab shows, and whether any row of it is picked.
export type KeyContext = { tab: Tab; hasPick: boolean }

// What a key press means in `mode`; null for a key that means nothing there.
export function keyAction(input: string, key: Keys, mode: Mode, ctx: KeyContext = { tab: 'queue', hasPick: false }): Action | null {
  if (key.ctrl && input === 'c') return { kind: 'interrupt' }
  if (mode === 'help') {
    if (key.escape || input === '?' || input === 'q') return { kind: 'closeHelp' }
    if (key.upArrow || input === 'k') return { kind: 'up' }
    if (key.downArrow || input === 'j') return { kind: 'down' }
    return jumpOf(key)
  }
  if (mode === 'menu' || mode === 'checklist') {
    if (key.escape || input === 'q' || (mode === 'menu' ? input === 'm' : input === 'P')) return { kind: 'cancel' }
    if (key.upArrow || input === 'k') return { kind: 'up' }
    if (key.downArrow || input === 'j') return { kind: 'down' }
    if (key.return) return { kind: 'submit' }
    return null
  }
  if (mode !== 'list') {
    if (key.return) return { kind: 'submit' }
    if (key.escape) return { kind: 'cancel' }
    if (mode === 'open' || mode === 'name') {
      const e = lineKey(input, key)
      if (e) return { kind: 'lineEdit', edit: e }
    }
    // Ink names the key most terminals send for Backspace (DEL) `delete`.
    if (key.backspace || key.delete) return { kind: 'erase' }
    if (key.ctrl || key.meta || key.tab || !input || /[\x00-\x1f\x7f]/.test(input)) return null
    return { kind: 'type', text: input }
  }
  // Tab and Shift-Tab (Ink reports it as Tab with shift)
  if (key.tab) return { kind: 'tab', dir: key.shift ? -1 : 1 }
  const isQueue = ctx.tab === 'queue'
  const canRemove = isQueue || ctx.tab === 'playlists'
  // the Queue and a playlist's songs move
  const canMove = canRemove
  // Ink calls Esc meta too, so it is read first
  if (key.escape) return ctx.hasPick ? { kind: 'clearPick' } : null
  if ((key.upArrow || key.downArrow) && key.shift) return { kind: 'extendPick', by: key.upArrow ? -1 : 1 }
  if ((key.upArrow || key.downArrow) && key.meta) return canMove ? { kind: 'move', by: key.upArrow ? -1 : 1 } : null
  // Ink names the key most terminals send for Backspace `delete` too
  if (key.delete || key.backspace) return canRemove ? { kind: 'remove' } : null
  if (input === ' ' && ctx.hasPick) return { kind: 'togglePick' }
  if (canMove && (input === 'u' || input === 'd') && !key.ctrl && !key.meta) return { kind: 'move', by: input === 'u' ? -1 : 1 }
  // plain letters only: Ctrl-A or Alt-S are someone else's chords
  const isPlain = !key.ctrl && !key.meta
  if (isPlain && !isQueue && (input === 'a' || input === 'A')) return { kind: 'add', where: input === 'a' ? 'end' : 'next' }
  if (isPlain && input === 'm') return { kind: 'menu' }
  if (isPlain && input === '*') return { kind: 'favourite' }
  if (isPlain && input === 'P') return { kind: 'addToList' }
  if (isPlain && !isQueue && input === 'U') return { kind: 'folderUp' }
  if (isPlain && input === 'G') return { kind: 'goPlaying' }
  if (isPlain && input === 'S') return { kind: 'sortNext' }
  if (isPlain && input === 'R') return { kind: 'sortReverse' }
  if (isPlain && isQueue && input === 'C') return { kind: 'clearQueue' }
  if (key.upArrow) return { kind: 'up' }
  if (key.downArrow) return { kind: 'down' }
  const jump = jumpOf(key)
  if (jump) return jump
  if (key.leftArrow) return { kind: 'shutFolder' }
  if (key.rightArrow) return { kind: 'openFolder' }
  if (key.return) return { kind: 'enter' }
  if (key.ctrl || key.meta) return null
  return LETTERS[input] ?? null
}

function jumpOf(key: Keys): Action | null {
  if (key.pageUp || key.pageDown) return { kind: 'jump', by: 'page', dir: key.pageUp ? -1 : 1 }
  if (key.home || key.end) return { kind: 'jump', by: 'all', dir: key.home ? -1 : 1 }
  return null
}

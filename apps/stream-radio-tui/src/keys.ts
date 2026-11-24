import type { Key } from 'ink'
import type { Tab } from './ui/Tabs'

// list: keys are commands; filter and open: keys edit a line of text; help:
// the key list shows, and keys scroll or close it; menu: a row's menu is
// open, and keys choose from it.
export type Mode = 'list' | 'filter' | 'open' | 'help' | 'menu'

export type Action =
  | { kind: 'up' }
  | { kind: 'down' }
  // play the selected song, or open or shut the selected folder
  | { kind: 'enter' }
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
  | { kind: 'submit' }
  | { kind: 'cancel' }
  // to the other tab
  | { kind: 'tab' }
  // the picked songs (or the cursor's) one place up (-1) or down
  | { kind: 'move'; by: 1 | -1 }
  | { kind: 'remove' }
  // the cursor a row up or down, picking the rows from the anchor
  | { kind: 'extendPick'; by: 1 | -1 }
  | { kind: 'togglePick' }
  | { kind: 'clearPick' }
  // sort by the next field; by this one, the other way round
  | { kind: 'sortNext' }
  | { kind: 'sortReverse' }
  // Files: the picked rows (or the cursor's) to the queue's end, or to play next
  | { kind: 'add'; where: 'end' | 'next' }
  // the cursor's row's menu
  | { kind: 'menu' }

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

// Which tab shows, and whether any row of it is picked.
export type KeyContext = { tab: Tab; hasPick: boolean }

// What a key press means in `mode`; null for a key that means nothing there.
export function keyAction(input: string, key: Key, mode: Mode, ctx: KeyContext = { tab: 'playlist', hasPick: false }): Action | null {
  if (key.ctrl && input === 'c') return { kind: 'interrupt' }
  if (mode === 'help') {
    if (key.escape || input === '?' || input === 'q') return { kind: 'closeHelp' }
    if (key.upArrow || input === 'k') return { kind: 'up' }
    if (key.downArrow || input === 'j') return { kind: 'down' }
    return null
  }
  if (mode === 'menu') {
    if (key.escape || input === 'm' || input === 'q') return { kind: 'cancel' }
    if (key.upArrow || input === 'k') return { kind: 'up' }
    if (key.downArrow || input === 'j') return { kind: 'down' }
    if (key.return) return { kind: 'submit' }
    return null
  }
  if (mode !== 'list') {
    if (key.return) return { kind: 'submit' }
    if (key.escape) return { kind: 'cancel' }
    // Ink names the key most terminals send for Backspace (DEL) `delete`.
    if (key.backspace || key.delete) return { kind: 'erase' }
    if (key.ctrl || key.meta || key.tab || !input || /[\x00-\x1f\x7f]/.test(input)) return null
    return { kind: 'type', text: input }
  }
  // Tab and Shift-Tab: with two tabs, either goes to the other
  if (key.tab) return { kind: 'tab' }
  const isPlaylist = ctx.tab === 'playlist'
  // Ink calls Esc meta too, so it is read first
  if (key.escape) return ctx.hasPick ? { kind: 'clearPick' } : null
  if ((key.upArrow || key.downArrow) && key.shift) return { kind: 'extendPick', by: key.upArrow ? -1 : 1 }
  if ((key.upArrow || key.downArrow) && key.meta) return isPlaylist ? { kind: 'move', by: key.upArrow ? -1 : 1 } : null
  // Ink names the key most terminals send for Backspace `delete` too
  if (key.delete || key.backspace) return isPlaylist ? { kind: 'remove' } : null
  if (input === ' ' && ctx.hasPick) return { kind: 'togglePick' }
  if (isPlaylist && (input === 'u' || input === 'd') && !key.ctrl && !key.meta) return { kind: 'move', by: input === 'u' ? -1 : 1 }
  // plain letters only: Ctrl-A or Alt-S are someone else's chords
  const isPlain = !key.ctrl && !key.meta
  if (isPlain && !isPlaylist && (input === 'a' || input === 'A')) return { kind: 'add', where: input === 'a' ? 'end' : 'next' }
  if (isPlain && input === 'm') return { kind: 'menu' }
  if (isPlain && input === 'S') return { kind: 'sortNext' }
  if (isPlain && input === 'R') return { kind: 'sortReverse' }
  if (key.upArrow) return { kind: 'up' }
  if (key.downArrow) return { kind: 'down' }
  if (key.leftArrow) return { kind: 'shutFolder' }
  if (key.rightArrow) return { kind: 'openFolder' }
  if (key.return) return { kind: 'enter' }
  if (key.ctrl || key.meta) return null
  return LETTERS[input] ?? null
}

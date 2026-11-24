import type { Key } from 'ink'

// list: keys are commands; filter and open: keys edit a line of text; help:
// the key list shows, and keys scroll or close it.
export type Mode = 'list' | 'filter' | 'open' | 'help'

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
  // one step louder (1) or quieter (-1): the same change in loudness at any level
  | { kind: 'volume'; dir: 1 | -1 }
  | { kind: 'shuffle' }
  | { kind: 'repeat' }
  | { kind: 'filterMode' }
  | { kind: 'openMode' }
  | { kind: 'last' }
  | { kind: 'stop' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'closeHelp' }
  // in a text mode
  | { kind: 'type'; text: string }
  | { kind: 'erase' }
  | { kind: 'submit' }
  | { kind: 'cancel' }

const LETTERS: Record<string, Action> = {
  k: { kind: 'up' },
  j: { kind: 'down' },
  ' ': { kind: 'pause' },
  n: { kind: 'next' },
  p: { kind: 'prev' },
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

// What a key press means in `mode`; null for a key that means nothing there.
export function keyAction(input: string, key: Key, mode: Mode): Action | null {
  if (key.ctrl && input === 'c') return { kind: 'quit' }
  if (mode === 'help') {
    if (key.escape || input === '?' || input === 'q') return { kind: 'closeHelp' }
    if (key.upArrow || input === 'k') return { kind: 'up' }
    if (key.downArrow || input === 'j') return { kind: 'down' }
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
  if (key.upArrow) return { kind: 'up' }
  if (key.downArrow) return { kind: 'down' }
  if (key.leftArrow) return { kind: 'shutFolder' }
  if (key.rightArrow) return { kind: 'openFolder' }
  if (key.return) return { kind: 'enter' }
  if (key.ctrl || key.meta) return null
  return LETTERS[input] ?? null
}

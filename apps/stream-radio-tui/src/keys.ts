import type { Key } from 'ink'
import { VOLUME_STEP } from '../../../plugins/stream-radio/core/nowplaying'

// list: keys are commands; filter and open: keys edit a line of text.
export type Mode = 'list' | 'filter' | 'open'

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
  | { kind: 'volume'; by: number }
  | { kind: 'shuffle' }
  | { kind: 'repeat' }
  | { kind: 'filterMode' }
  | { kind: 'openMode' }
  | { kind: 'last' }
  | { kind: 'stop' }
  | { kind: 'quit' }
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
  '+': { kind: 'volume', by: VOLUME_STEP },
  '=': { kind: 'volume', by: VOLUME_STEP },
  '-': { kind: 'volume', by: -VOLUME_STEP },
  s: { kind: 'shuffle' },
  r: { kind: 'repeat' },
  '/': { kind: 'filterMode' },
  o: { kind: 'openMode' },
  l: { kind: 'last' },
  x: { kind: 'stop' },
  q: { kind: 'quit' },
}

// What a key press means in `mode`; null for a key that means nothing there.
export function keyAction(input: string, key: Key, mode: Mode): Action | null {
  if (key.ctrl && input === 'c') return { kind: 'quit' }
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

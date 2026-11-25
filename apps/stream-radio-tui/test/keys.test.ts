import { describe, expect, test } from 'vitest'
import type { Key } from 'ink'
import { keyAction, type Action, type Mode } from '../src/keys'
import type { Edit } from '../src/ui/lineEdit'

const NONE: Key = {
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
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k })

type Case = [name: string, input: string, key: Key, expected: Action | null]

const listCases: Case[] = [
  ['↑', '', key({ upArrow: true }), { kind: 'up' }],
  ['k', 'k', key(), { kind: 'up' }],
  ['↓', '', key({ downArrow: true }), { kind: 'down' }],
  ['j', 'j', key(), { kind: 'down' }],
  ['Enter', '\r', key({ return: true }), { kind: 'enter' }],
  ['←', '', key({ leftArrow: true }), { kind: 'shutFolder' }],
  ['→', '', key({ rightArrow: true }), { kind: 'openFolder' }],
  ['space', ' ', key(), { kind: 'pause' }],
  ['n', 'n', key(), { kind: 'next' }],
  ['p', 'p', key(), { kind: 'prev' }],
  ['b', 'b', key(), { kind: 'seek', by: -10 }],
  ['f', 'f', key(), { kind: 'seek', by: 10 }],
  ['+', '+', key(), { kind: 'volume', dir: 1 }],
  ['=', '=', key(), { kind: 'volume', dir: 1 }],
  ['-', '-', key(), { kind: 'volume', dir: -1 }],
  ['s', 's', key(), { kind: 'shuffle' }],
  ['r', 'r', key(), { kind: 'repeat' }],
  ['/', '/', key(), { kind: 'filterMode' }],
  ['o', 'o', key(), { kind: 'openMode' }],
  ['l', 'l', key(), { kind: 'last' }],
  ['x', 'x', key(), { kind: 'stop' }],
  ['q', 'q', key(), { kind: 'quit' }],
  ['Ctrl-C', 'c', key({ ctrl: true }), { kind: 'interrupt' }],
  ['?', '?', key({ shift: true }), { kind: 'help' }],
  ['an unbound letter', 'z', key(), null],
  ['Esc', '', key({ escape: true }), null],
  ['Ctrl-N is not n', 'n', key({ ctrl: true }), null],
]

// The same keys in a text mode: letters are text, the rest edits or leaves.
const textCases: Case[] = [
  ['a letter', 'q', key(), { kind: 'type', text: 'q' }],
  ['space', ' ', key(), { kind: 'type', text: ' ' }],
  ['/', '/', key(), { kind: 'type', text: '/' }],
  ['+', '+', key(), { kind: 'type', text: '+' }],
  ['pasted text', '~/Music/Album', key(), { kind: 'type', text: '~/Music/Album' }],
  ['a capital', 'A', key({ shift: true }), { kind: 'type', text: 'A' }],
  ['Enter', '\r', key({ return: true }), { kind: 'submit' }],
  ['Esc', '', key({ escape: true }), { kind: 'cancel' }],
  ['Backspace', '', key({ backspace: true }), { kind: 'erase' }],
  ['Delete (most terminals send it for Backspace)', '', key({ delete: true }), { kind: 'erase' }],
  ['Ctrl-C', 'c', key({ ctrl: true }), { kind: 'interrupt' }],
  ['↑', '', key({ upArrow: true }), null],
  ['←', '', key({ leftArrow: true }), null],
  ['Tab', '\t', key({ tab: true }), null],
  ['Ctrl-A', 'a', key({ ctrl: true }), null],
  ['Alt-x', 'x', key({ meta: true }), null],
]

describe('keyAction in the list', () => {
  test.each(listCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, 'list')).toEqual(expected)
  })
})

describe('keyAction in filter mode', () => {
  test.each(textCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, 'filter')).toEqual(expected)
  })
})

// The Files location, edited in its heading: the same keys, at a cursor, and
// the keys that move it.
const lineEdit = (edit: Edit): Action => ({ kind: 'lineEdit', edit })
const openCases: Case[] = [
  ...textCases.map(([name, input, k, expected]): Case => {
    if (expected?.kind === 'type') return [name, input, k, lineEdit({ kind: 'insert', text: expected.text })]
    if (expected?.kind === 'erase') return [name, input, k, lineEdit({ kind: 'erase' })]
    if (name === '←' || name === 'Ctrl-A') return [name, input, k, name === '←' ? lineEdit({ kind: 'left' }) : lineEdit({ kind: 'start' })]
    return [name, input, k, expected]
  }),
  ['→', '', key({ rightArrow: true }), lineEdit({ kind: 'right' })],
  ['Ctrl-E', 'e', key({ ctrl: true }), lineEdit({ kind: 'end' })],
  ['Ctrl-U', 'u', key({ ctrl: true }), lineEdit({ kind: 'eraseToStart' })],
  ['Ctrl-K', 'k', key({ ctrl: true }), lineEdit({ kind: 'eraseToEnd' })],
  ['Ctrl-W', 'w', key({ ctrl: true }), lineEdit({ kind: 'eraseWord' })],
  ['Ctrl-D', 'd', key({ ctrl: true }), lineEdit({ kind: 'eraseAfter' })],
  ['Ctrl-X does nothing', 'x', key({ ctrl: true }), null],
]

describe('keyAction in open mode', () => {
  test.each(openCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, 'open')).toEqual(expected)
  })
})

// The key list: it closes, scrolls, or takes Ctrl-C; nothing else acts.
const helpCases: Case[] = [
  ['?', '?', key({ shift: true }), { kind: 'closeHelp' }],
  ['Esc', '', key({ escape: true }), { kind: 'closeHelp' }],
  ['q closes it, not the TUI', 'q', key(), { kind: 'closeHelp' }],
  ['↑', '', key({ upArrow: true }), { kind: 'up' }],
  ['k', 'k', key(), { kind: 'up' }],
  ['↓', '', key({ downArrow: true }), { kind: 'down' }],
  ['j', 'j', key(), { kind: 'down' }],
  ['Ctrl-C', 'c', key({ ctrl: true }), { kind: 'interrupt' }],
  ['x does nothing here', 'x', key(), null],
  ['space does nothing here', ' ', key(), null],
]

describe('keyAction in the key list', () => {
  test.each(helpCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, 'help')).toEqual(expected)
  })
})

describe('pick and move keys', () => {
  const PL = { tab: 'playlist' as const, hasPick: false }
  const PICKED = { tab: 'playlist' as const, hasPick: true }
  const FILES = { tab: 'files' as const, hasPick: false }
  test('Alt-↑/↓ and u/d move, in the Playlist', () => {
    expect(keyAction('', key({ upArrow: true, meta: true }), 'list', PL)).toEqual({ kind: 'move', by: -1 })
    expect(keyAction('', key({ downArrow: true, meta: true }), 'list', PL)).toEqual({ kind: 'move', by: 1 })
    expect(keyAction('u', key(), 'list', PL)).toEqual({ kind: 'move', by: -1 })
    expect(keyAction('d', key(), 'list', PL)).toEqual({ kind: 'move', by: 1 })
    expect(keyAction('d', key(), 'list', FILES)).toBeNull()
  })
  test('Delete (and Backspace) removes, in the Playlist', () => {
    expect(keyAction('', key({ delete: true }), 'list', PL)).toEqual({ kind: 'remove' })
    expect(keyAction('', key({ backspace: true }), 'list', PL)).toEqual({ kind: 'remove' })
    expect(keyAction('', key({ delete: true }), 'list', FILES)).toBeNull()
  })
  test('Shift-↑/↓ extend the pick, in either tab', () => {
    expect(keyAction('', key({ upArrow: true, shift: true }), 'list', PL)).toEqual({ kind: 'extendPick', by: -1 })
    expect(keyAction('', key({ downArrow: true, shift: true }), 'list', FILES)).toEqual({ kind: 'extendPick', by: 1 })
  })
  test('Space picks while any row is picked, else pauses; Esc clears a pick', () => {
    expect(keyAction(' ', key(), 'list', PL)).toEqual({ kind: 'pause' })
    expect(keyAction(' ', key(), 'list', PICKED)).toEqual({ kind: 'togglePick' })
    expect(keyAction('', key({ escape: true, meta: true }), 'list', PICKED)).toEqual({ kind: 'clearPick' })
    expect(keyAction('', key({ escape: true, meta: true }), 'list', PL)).toBeNull()
  })
  test('S and R sort', () => {
    expect(keyAction('S', key({ shift: true }), 'list', PL)).toEqual({ kind: 'sortNext' })
    expect(keyAction('R', key({ shift: true }), 'list', PL)).toEqual({ kind: 'sortReverse' })
  })
})

describe('chords are not letters', () => {
  test('Ctrl or Alt with a, A, S or R does nothing', () => {
    const FILES = { tab: 'files' as const, hasPick: false }
    const PL = { tab: 'playlist' as const, hasPick: false }
    expect(keyAction('a', key({ ctrl: true }), 'list', FILES)).toBeNull()
    expect(keyAction('A', key({ meta: true, shift: true }), 'list', FILES)).toBeNull()
    expect(keyAction('S', key({ meta: true, shift: true }), 'list', PL)).toBeNull()
    expect(keyAction('R', key({ meta: true, shift: true }), 'list', PL)).toBeNull()
    expect(keyAction('s', key({ ctrl: true }), 'list', PL)).toBeNull()
  })
})


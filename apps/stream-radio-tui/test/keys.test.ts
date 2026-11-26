import { describe, expect, test } from 'vitest'
import type { Key } from 'ink'
import { homeEnd, keyAction, type Action, type Keys, type Mode } from '../src/keys'
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
const key = (k: Partial<Keys> = {}): Keys => ({ ...NONE, ...k })

type Case = [name: string, input: string, key: Keys, expected: Action | null]

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
  ['PgUp', '', key({ pageUp: true }), { kind: 'jump', by: 'page', dir: -1 }],
  ['PgDn', '', key({ pageDown: true }), { kind: 'jump', by: 'page', dir: 1 }],
  ['Home', '', key({ home: true }), { kind: 'jump', by: 'all', dir: -1 }],
  ['End', '', key({ end: true }), { kind: 'jump', by: 'all', dir: 1 }],
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
  ['Home', '', key({ home: true }), lineEdit({ kind: 'start' })],
  ['End', '', key({ end: true }), lineEdit({ kind: 'end' })],
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
  ['PgUp', '', key({ pageUp: true }), { kind: 'jump', by: 'page', dir: -1 }],
  ['End', '', key({ end: true }), { kind: 'jump', by: 'all', dir: 1 }],
  ['x does nothing here', 'x', key(), null],
  ['space does nothing here', ' ', key(), null],
]

describe('keyAction in the key list', () => {
  test.each(helpCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, 'help')).toEqual(expected)
  })
})

describe('pick and move keys', () => {
  const PL = { tab: 'queue' as const, hasPick: false }
  const PICKED = { tab: 'queue' as const, hasPick: true }
  const FILES = { tab: 'files' as const, hasPick: false }
  test('Alt-↑/↓ and u/d move, in the Queue', () => {
    expect(keyAction('', key({ upArrow: true, meta: true }), 'list', PL)).toEqual({ kind: 'move', by: -1 })
    expect(keyAction('', key({ downArrow: true, meta: true }), 'list', PL)).toEqual({ kind: 'move', by: 1 })
    expect(keyAction('u', key(), 'list', PL)).toEqual({ kind: 'move', by: -1 })
    expect(keyAction('d', key(), 'list', PL)).toEqual({ kind: 'move', by: 1 })
    expect(keyAction('d', key(), 'list', FILES)).toBeNull()
  })
  test('Delete (and Backspace) removes, in the Queue', () => {
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

describe('tabs and the Playlists tab', () => {
  const PLS = { tab: 'playlists' as const, hasPick: false }
  test('Tab goes to the next tab, Shift-Tab (Ink: tab with shift) to the one before', () => {
    expect(keyAction('\t', key({ tab: true }), 'list', PLS)).toEqual({ kind: 'tab', dir: 1 })
    expect(keyAction('', key({ tab: true, shift: true }), 'list', PLS)).toEqual({ kind: 'tab', dir: -1 })
    expect(keyAction('\t', key({ tab: true }), 'list')).toEqual({ kind: 'tab', dir: 1 })
  })
  test('a, A, U and Delete act in Playlists; C, u and d do not', () => {
    expect(keyAction('a', key(), 'list', PLS)).toEqual({ kind: 'add', where: 'end' })
    expect(keyAction('A', key({ shift: true }), 'list', PLS)).toEqual({ kind: 'add', where: 'next' })
    expect(keyAction('U', key({ shift: true }), 'list', PLS)).toEqual({ kind: 'folderUp' })
    expect(keyAction('', key({ delete: true }), 'list', PLS)).toEqual({ kind: 'remove' })
    expect(keyAction('', key({ backspace: true }), 'list', PLS)).toEqual({ kind: 'remove' })
    expect(keyAction('C', key({ shift: true }), 'list', PLS)).toBeNull()
    expect(keyAction('d', key(), 'list', PLS)).toBeNull()
  })
  test('the name prompt edits a line, as the Files location does', () => {
    expect(keyAction('x', key(), 'name')).toEqual({ kind: 'lineEdit', edit: { kind: 'insert', text: 'x' } })
    expect(keyAction('', key({ leftArrow: true }), 'name')).toEqual({ kind: 'lineEdit', edit: { kind: 'left' } })
    expect(keyAction('', key({ backspace: true }), 'name')).toEqual({ kind: 'lineEdit', edit: { kind: 'erase' } })
    expect(keyAction('\r', key({ return: true }), 'name')).toEqual({ kind: 'submit' })
    expect(keyAction('', key({ escape: true }), 'name')).toEqual({ kind: 'cancel' })
    expect(keyAction('q', key(), 'name')).toEqual({ kind: 'lineEdit', edit: { kind: 'insert', text: 'q' } })
  })
})

describe('chords are not letters', () => {
  test('Ctrl or Alt with a, A, S or R does nothing', () => {
    const FILES = { tab: 'files' as const, hasPick: false }
    const PL = { tab: 'queue' as const, hasPick: false }
    expect(keyAction('a', key({ ctrl: true }), 'list', FILES)).toBeNull()
    expect(keyAction('A', key({ meta: true, shift: true }), 'list', FILES)).toBeNull()
    expect(keyAction('S', key({ meta: true, shift: true }), 'list', PL)).toBeNull()
    expect(keyAction('R', key({ meta: true, shift: true }), 'list', PL)).toBeNull()
    expect(keyAction('s', key({ ctrl: true }), 'list', PL)).toBeNull()
  })
})


describe('homeEnd', () => {
  test.each([
    ['\x1b[H', 'home'],
    ['\x1bOH', 'home'],
    ['\x1b[1~', 'home'],
    ['\x1b[7~', 'home'],
    ['\x1b[F', 'end'],
    ['\x1bOF', 'end'],
    ['\x1b[4~', 'end'],
    ['\x1b[8~', 'end'],
  ])('%j is %s', (seq, name) => {
    expect(homeEnd(seq)).toBe(name)
    expect(homeEnd(Buffer.from(seq))).toBe(name)
  })
  test('anything else is neither', () => {
    for (const seq of ['H', '\x1b[A', '\x1b[5~', '\x1b[1;5H', '\x1b[H\x1b[H']) expect(homeEnd(seq)).toBeUndefined()
  })
})

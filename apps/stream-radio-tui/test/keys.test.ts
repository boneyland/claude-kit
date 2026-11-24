import { describe, expect, test } from 'vitest'
import type { Key } from 'ink'
import { keyAction, type Action, type Mode } from '../src/keys'

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

describe.each(['filter', 'open'] as Mode[])('keyAction in %s mode', mode => {
  test.each(textCases)('%s', (_name, input, k, expected) => {
    expect(keyAction(input, k, mode)).toEqual(expected)
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

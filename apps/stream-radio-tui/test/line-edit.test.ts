import { describe, expect, test } from 'vitest'
import { edit, indexAt, shown, type Line } from '../src/ui/lineEdit'

const at = (text: string, i = text.length): Line => ({ text, at: i })

describe('edit', () => {
  test('inserts at the cursor', () => {
    expect(edit(at('~/Mic', 3), { kind: 'insert', text: 'us' })).toEqual({ text: '~/Music', at: 5 })
  })
  test('erases before and after the cursor', () => {
    expect(edit(at('abc', 2), { kind: 'erase' })).toEqual({ text: 'ac', at: 1 })
    expect(edit(at('abc', 2), { kind: 'eraseAfter' })).toEqual({ text: 'ab', at: 2 })
    expect(edit(at('abc', 0), { kind: 'erase' })).toEqual({ text: 'abc', at: 0 })
    expect(edit(at('abc'), { kind: 'eraseAfter' })).toEqual({ text: 'abc', at: 3 })
  })
  test('a letter and its combining mark move and erase as one', () => {
    const text = 'Amélie'
    expect(edit(at(text, 4), { kind: 'left' }).at).toBe(2)
    expect(edit(at(text, 2), { kind: 'right' }).at).toBe(4)
    expect(edit(at(text, 4), { kind: 'erase' })).toEqual({ text: 'Amlie', at: 2 })
  })
  test('Ctrl-W takes off one folder', () => {
    expect(edit(at('~/Music/Jazz/'), { kind: 'eraseWord' })).toEqual({ text: '~/Music/', at: 8 })
    expect(edit(at('~/Music/'), { kind: 'eraseWord' })).toEqual({ text: '~/', at: 2 })
  })
  test('erases to either end, and jumps there', () => {
    expect(edit(at('abcd', 2), { kind: 'eraseToStart' })).toEqual({ text: 'cd', at: 0 })
    expect(edit(at('abcd', 2), { kind: 'eraseToEnd' })).toEqual({ text: 'ab', at: 2 })
    expect(edit(at('abcd', 2), { kind: 'start' }).at).toBe(0)
    expect(edit(at('abcd', 2), { kind: 'end' }).at).toBe(4)
  })
})

describe('shown', () => {
  test('all of a line that fits, the cursor on its grapheme', () => {
    expect(shown(at('abcd', 1), 10)).toEqual({ from: 0, before: 'a', under: 'b', after: 'cd' })
    expect(shown(at('abcd'), 10)).toEqual({ from: 0, before: 'abcd', under: ' ', after: '' })
  })
  test('a long line ends at the cursor, the cursor cell kept', () => {
    expect(shown(at('abcdefgh'), 4)).toEqual({ from: 5, before: 'fgh', under: ' ', after: '' })
    expect(shown(at('abcdefgh', 6), 4)).toEqual({ from: 3, before: 'def', under: 'g', after: '' })
  })
  test('the start of a long line, cursor near it, cuts the end', () => {
    expect(shown(at('abcdefgh', 1), 4)).toEqual({ from: 0, before: 'a', under: 'b', after: 'cd' })
  })
  test('wide characters take two cells', () => {
    expect(shown(at('音楽'), 4)).toEqual({ from: 3 - 2, before: '楽', under: ' ', after: '' })
  })
})

describe('indexAt', () => {
  test('before the grapheme clicked, or after the last', () => {
    expect(indexAt(at('abcd', 0), 10, 2)).toBe(2)
    expect(indexAt(at('abcd', 0), 10, 9)).toBe(4)
  })
  test('counts from the first grapheme shown', () => {
    expect(indexAt(at('abcdefgh'), 4, 0)).toBe(5)
  })
  test('a click on either cell of a wide character lands before it', () => {
    expect(indexAt(at('a音b', 0), 10, 1)).toBe(1)
    expect(indexAt(at('a音b', 0), 10, 2)).toBe(1)
    expect(indexAt(at('a音b', 0), 10, 3)).toBe(2)
  })
  test('past what shows of a cut line, at the last showing', () => {
    expect(indexAt(at('abcdefgh', 1), 4, 3)).toBe(3)
    expect(indexAt(at('abcdefgh', 1), 4, 9)).toBe(4)
  })
})

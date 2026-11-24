import { describe, expect, test } from 'vitest'
import { PassThrough } from 'node:stream'
import { splitMouse } from '../src/mouse/sgr'
import { mouseInput } from '../src/mouse/input'

describe('splitMouse', () => {
  test('a left press, at 0-based cells', () => {
    expect(splitMouse('', '\x1b[<0;10;5M')).toEqual({ text: '', held: '', events: [{ kind: 'press', button: 'left', x: 9, y: 4 }] })
  })
  test('release, wheel and the right button', () => {
    expect(splitMouse('', '\x1b[<0;1;1m').events[0]).toMatchObject({ kind: 'release', button: 'left' })
    expect(splitMouse('', '\x1b[<64;3;3M').events[0]).toEqual({ kind: 'wheel', button: 'none', dir: 'up', x: 2, y: 2 })
    expect(splitMouse('', '\x1b[<65;3;3M').events[0]).toMatchObject({ kind: 'wheel', dir: 'down' })
    expect(splitMouse('', '\x1b[<2;1;1M').events[0]).toMatchObject({ kind: 'press', button: 'right' })
  })
  test('keys around a report pass on; the report does not', () => {
    const r = splitMouse('', 'a\x1b[<0;1;1Mb')
    expect(r.text).toBe('ab')
    expect(r.events).toHaveLength(1)
  })
  test('a report split across two reads is held, then read whole', () => {
    const first = splitMouse('', 'x\x1b[<0;1')
    expect(first).toEqual({ text: 'x', held: '\x1b[<0;1', events: [] })
    const second = splitMouse(first.held, '2;3M')
    expect(second.text).toBe('')
    expect(second.events).toEqual([{ kind: 'press', button: 'left', x: 11, y: 2 }])
  })
  test('a lone Escape, or an arrow prefix, at the end is passed on at once', () => {
    expect(splitMouse('', '\x1b')).toEqual({ text: '\x1b', held: '', events: [] })
    expect(splitMouse('', '\x1b[')).toEqual({ text: '\x1b[', held: '', events: [] })
    expect(splitMouse('', '\x1b[A').text).toBe('\x1b[A')
  })
  test('motion is dropped', () => {
    expect(splitMouse('', '\x1b[<32;4;4M')).toEqual({ text: '', held: '', events: [] })
  })
})

describe('mouseInput', () => {
  test('Ink reads only the keys; subscribers get the clicks', async () => {
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => source }) as unknown as NodeJS.ReadStream
    const input = mouseInput(source)
    const got: unknown[] = []
    input.subscribe(e => got.push(e))
    expect(input.stdin.isTTY).toBe(true)
    ;(source as unknown as PassThrough).write('q\x1b[<0;2;2Mj')
    await new Promise(r => setTimeout(r, 10))
    expect(String(input.stdin.read())).toBe('qj')
    expect(got).toEqual([{ kind: 'press', button: 'left', x: 1, y: 1 }])
  })
  test('stdin paused by the probe flows again once Ink turns raw mode on', async () => {
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => source }) as unknown as NodeJS.ReadStream
    source.pause()
    const input = mouseInput(source)
    input.stdin.setRawMode(true)
    ;(source as unknown as PassThrough).write('q')
    await new Promise(r => setTimeout(r, 10))
    expect(String(input.stdin.read())).toBe('q')
  })
})

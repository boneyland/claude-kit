import { describe, expect, test } from 'vitest'
import { PassThrough } from 'node:stream'
import { graphicsOn, parseProbeReply, probeTerminal } from '../src/gfx/probe'

const OK = '\x1b_Gi=31;OK\x1b\\'
const DA1 = '\x1b[?62;22c'

describe('parseProbeReply', () => {
  test('an OK before the device attributes means Kitty graphics', () => {
    expect(parseProbeReply(OK + DA1)).toEqual({ kitty: true, isDone: true })
  })
  test('the device attributes alone mean none', () => {
    expect(parseProbeReply(DA1)).toEqual({ kitty: false, isDone: true })
  })
  test('the cell size comes from the 16t answer, height first', () => {
    expect(parseProbeReply(`${OK}\x1b[6;18;9t${DA1}`)).toEqual({ kitty: true, cell: { width: 9, height: 18 }, isDone: true })
  })
  test('a reply still arriving is not done', () => {
    expect(parseProbeReply(OK + '\x1b[6;18').isDone).toBe(false)
  })
  test('an error answer is not support', () => {
    expect(parseProbeReply('\x1b_Gi=31;ENOTSUPPORTED:x\x1b\\' + DA1).kitty).toBe(false)
  })
})

describe('graphicsOn', () => {
  const yes = { kitty: true }
  test('off and on are what they say, whatever the terminal', () => {
    expect(graphicsOn({}, 'off', yes)).toBe(false)
    expect(graphicsOn({ TMUX: '/tmp/t' }, 'on', { kitty: false })).toBe(true)
  })
  test('auto follows the terminal answer', () => {
    expect(graphicsOn({}, 'auto', yes)).toBe(true)
    expect(graphicsOn({}, 'auto', { kitty: false })).toBe(false)
  })
  test('auto is off inside tmux or screen', () => {
    expect(graphicsOn({ TMUX: '/tmp/t' }, 'auto', yes)).toBe(false)
    expect(graphicsOn({ STY: '1.pts' }, 'auto', yes)).toBe(false)
  })
  test('auto is off in terminals without placeholders: WezTerm and Konsole', () => {
    expect(graphicsOn({ TERM_PROGRAM: 'WezTerm' }, 'auto', yes)).toBe(false)
    expect(graphicsOn({ KONSOLE_VERSION: '240802' }, 'auto', yes)).toBe(false)
  })
})

describe('probeTerminal', () => {
  test('without a terminal it asks nothing', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    let written = ''
    ;(stdout as unknown as PassThrough).on('data', d => (written += d))
    expect(await probeTerminal(stdin, stdout)).toEqual({ kitty: false })
    expect(written).toBe('')
  })
  test('a terminal that answers is read, and raw mode is put back', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(on: boolean) { this.isRaw = on } })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    stdout.on('data', () => stdin.write(`${OK}\x1b[6;20;10t${DA1}`))
    const probe = await probeTerminal(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream)
    expect(probe).toEqual({ kitty: true, cell: { width: 10, height: 20 } })
    expect(stdin.isRaw).toBe(false)
  })
  test('a terminal that never answers times out as none', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    expect(await probeTerminal(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, 30)).toEqual({ kitty: false })
  })
})

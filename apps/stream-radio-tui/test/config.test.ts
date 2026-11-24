import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config'

const DEFAULTS = { volume: 60, player: 'mpv', androidClient: false, defaultUrl: '', graphics: 'auto', mouse: 'on' }
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cfg-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (text: string) => {
  fs.mkdirSync(path.join(dir, 'stream-radio'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'stream-radio', 'config.json'), text)
}
const env = () => ({ XDG_CONFIG_HOME: dir })

describe('loadConfig', () => {
  test('the mouse is on unless set off', async () => {
    write('{"mouse": "off"}')
    expect((await loadConfig(env())).mouse).toBe('off')
    write('{"mouse": false}')
    expect((await loadConfig(env())).mouse).toBe('on')
  })
  test('graphics can be forced on or off; anything else is auto', async () => {
    write('{"graphics": "on"}')
    expect((await loadConfig(env())).graphics).toBe('on')
    write('{"graphics": "off"}')
    expect((await loadConfig(env())).graphics).toBe('off')
    write('{"graphics": "yes"}')
    expect((await loadConfig(env())).graphics).toBe('auto')
  })
  test('a missing file gives the defaults', async () => {
    expect(await loadConfig(env())).toEqual(DEFAULTS)
  })
  test('a volume over 100 is clamped', async () => {
    write('{"volume": 140}')
    expect((await loadConfig(env())).volume).toBe(100)
    write('{"volume": -5}')
    expect((await loadConfig(env())).volume).toBe(0)
  })
  test('a bad file gives the defaults', async () => {
    write('not json')
    expect(await loadConfig(env())).toEqual(DEFAULTS)
  })
  test('a wrong-typed field falls back, the others stay', async () => {
    write('{"volume":"loud","player":"mpv2","androidClient":true,"defaultUrl":5}')
    expect(await loadConfig(env())).toEqual({ ...DEFAULTS, player: 'mpv2', androidClient: true })
  })
  test('reads defaultUrl', async () => {
    write('{"defaultUrl":"https://example.com/live"}')
    expect((await loadConfig(env())).defaultUrl).toBe('https://example.com/live')
  })
  test('without XDG_CONFIG_HOME it reads HOME/.config', async () => {
    fs.mkdirSync(path.join(dir, '.config/stream-radio'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.config/stream-radio/config.json'), '{"volume": 7}')
    expect((await loadConfig({ HOME: dir })).volume).toBe(7)
  })
})

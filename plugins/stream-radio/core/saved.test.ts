import { expect, test } from 'claude-code/testing'

import type { Host, PlayerKeys } from './host'
import { checkDefault, loadVolume, NO_RESUME } from './player'
import { migrateFromStore, readSaved, updateSaved, type SavedState } from './saved'

const STATE = '/data/state.json'
const EMPTY: SavedState = { version: 1, last: null, knownDefault: {}, volume: null, repeat: null }
const AT = { url: '/m', index: 2, seconds: 80, title: 'Song' }

// A Host over files in memory: only what the saved state reaches. run makes
// folders and moves files; every argv is kept.
function hostOf(program: 'mod' | 'tui', files: Record<string, string> = {}) {
  const ran: string[][] = []
  const vars: Partial<PlayerKeys> = { lastUrl: '', resumeAt: NO_RESUME, knownDefault: '', volume: 0 }
  const h = {
    program,
    dataDir: async () => '/data',
    run: async (argv: readonly string[]) => {
      ran.push([...argv])
      if (argv[0] === 'mv' && argv[1] === '-f') {
        files[argv[3]!] = files[argv[2]!]!
        delete files[argv[2]!]
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`)
        return files[path]!
      },
      write: async (path: string, text: string) => void (files[path] = text),
      exists: async (path: string) => path in files,
    },
    vars: {
      read: async (key: keyof PlayerKeys) => vars[key],
      change: async (key: keyof PlayerKeys, fn: (prev: unknown) => unknown) => ((vars as Record<string, unknown>)[key] = fn(vars[key])),
    },
  } as unknown as Host
  return { h, files, ran, vars }
}

test('a missing, broken or empty state.json reads as the empty state', async () => {
  expect(await readSaved(hostOf('mod').h)).toEqual(EMPTY)
  expect(await readSaved(hostOf('mod', { [STATE]: '{not json' }).h)).toEqual(EMPTY)
  expect(await readSaved(hostOf('mod', { [STATE]: '{"version":1}' }).h)).toEqual(EMPTY)
  expect(await readSaved(hostOf('mod', { [STATE]: '[1,2]' }).h)).toEqual(EMPTY)
})

test('a field of the wrong shape is dropped on its own', async () => {
  const text = JSON.stringify({ version: 1, last: 'x', knownDefault: { mod: 3, tui: 'B' }, volume: { value: 40, configured: { mod: 60 } }, repeat: 'sometimes' })
  expect(await readSaved(hostOf('mod', { [STATE]: text }).h)).toEqual({ ...EMPTY, knownDefault: { tui: 'B' }, volume: { value: 40, configured: { mod: 60 } } })
})

test('an update writes a temp file beside state.json, then moves it over', async () => {
  const { h, files, ran } = hostOf('mod', { [STATE]: JSON.stringify({ version: 1, repeat: 'one' }) })
  await updateSaved(h, s => ({ ...s, volume: { value: 30, configured: { mod: 60 } } }))
  const mv = ran.find(argv => argv[0] === 'mv')!
  expect(mv.slice(0, 2)).toEqual(['mv', '-f'])
  expect(mv[2]).toMatch(/^\/data\/state\.json\.[^/]+\.tmp$/)
  expect(mv[3]).toBe(STATE)
  expect(Object.keys(files)).toEqual([STATE])
  // re-read first: what was there is kept
  expect(JSON.parse(files[STATE]!)).toEqual({ ...EMPTY, repeat: 'one', volume: { value: 30, configured: { mod: 60 } } })
})

test("the mod's store moves into state.json once", async () => {
  const store: Record<string, unknown> = {
    last: { url: '/m', resumeAt: AT, knownDefault: 'https://example.com/d' },
    volume: { value: 35, configured: 60 },
    repeat: 'off',
  }
  const { h, files } = hostOf('mod')
  expect(await migrateFromStore(h, { get: async k => store[k] })).toBe(true)
  expect(JSON.parse(files[STATE]!)).toEqual({
    version: 1,
    last: { url: '/m', resumeAt: AT },
    knownDefault: { mod: 'https://example.com/d' },
    volume: { value: 35, configured: { mod: 60 } },
    repeat: 'off',
  })
})

test('once the mod has run on state.json, the store is left alone', async () => {
  const before = JSON.stringify({ version: 1, knownDefault: { mod: '' } })
  const { h, files } = hostOf('mod', { [STATE]: before })
  expect(await migrateFromStore(h, { get: async () => 'all' })).toBe(false)
  expect(files[STATE]).toBe(before)
})

test('a state.json the TUI wrote first still takes the store, keeping what the TUI saved', async () => {
  const store: Record<string, unknown> = {
    last: { url: '/m', resumeAt: AT, knownDefault: 'https://example.com/d' },
    volume: { value: 35, configured: 60 },
    repeat: 'one',
  }
  const { h, files } = hostOf('mod', { [STATE]: JSON.stringify({ version: 1, last: null, knownDefault: { tui: 'B' } }) })
  expect(await migrateFromStore(h, { get: async k => store[k] })).toBe(true)
  expect(JSON.parse(files[STATE]!)).toEqual({
    version: 1,
    last: { url: '/m', resumeAt: AT },
    knownDefault: { mod: 'https://example.com/d', tui: 'B' },
    volume: { value: 35, configured: { mod: 60 } },
    repeat: 'one',
  })
})

test("a value the TUI saved is not overwritten by the store's", async () => {
  const store: Record<string, unknown> = { repeat: 'one' }
  const { h } = hostOf('mod', { [STATE]: JSON.stringify({ version: 1, repeat: 'off', knownDefault: { tui: 'B' } }) })
  await migrateFromStore(h, { get: async k => store[k] })
  expect((await readSaved(h)).repeat).toBe('off')
})

test('an empty store writes nothing', async () => {
  const { h, files } = hostOf('mod')
  expect(await migrateFromStore(h, { get: async () => undefined })).toBe(false)
  expect(files).toEqual({})
})

test("each program keeps the saved volume while its own setting is unchanged", async () => {
  const text = JSON.stringify({ version: 1, volume: { value: 45, configured: { mod: 60, tui: 80 } } })
  const mod = hostOf('mod', { [STATE]: text })
  await loadVolume(mod.h, 60)
  expect(mod.vars.volume).toBe(45)
  const tui = hostOf('tui', { [STATE]: text })
  await loadVolume(tui.h, 80)
  expect(tui.vars.volume).toBe(45)
  const changed = hostOf('mod', { [STATE]: text })
  await loadVolume(changed.h, 70)
  expect(changed.vars.volume).toBe(70)
})

test("a changed default stream clears the last URL only for its own program", async () => {
  const text = JSON.stringify({ version: 1, last: { url: '/m', resumeAt: AT }, knownDefault: { mod: 'A' } })
  // the TUI's own default, different from the mod's: the last URL stays
  const tui = hostOf('tui', { [STATE]: text })
  await checkDefault(tui.h, 'B')
  expect(await readSaved(tui.h)).toMatchObject({ last: { url: '/m' }, knownDefault: { mod: 'A', tui: 'B' } })
  // the mod's default unchanged: it stays too
  const same = hostOf('mod', { ...tui.files })
  await checkDefault(same.h, 'A')
  expect((await readSaved(same.h)).last).toEqual({ url: '/m', resumeAt: AT })
  // the mod's default changed: it goes
  const mod = hostOf('mod', { ...tui.files })
  mod.vars.lastUrl = '/m'
  mod.vars.resumeAt = AT
  await checkDefault(mod.h, 'C')
  expect(await readSaved(mod.h)).toMatchObject({ last: null, knownDefault: { mod: 'C', tui: 'B' } })
  expect(mod.vars.lastUrl).toBe('')
  expect(mod.vars.resumeAt).toEqual(NO_RESUME)
})

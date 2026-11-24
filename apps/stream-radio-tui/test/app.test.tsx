import { afterEach, describe, expect, test, vi } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host, PlayerKeys } from '../../../plugins/stream-radio/core/host'
import * as player from '../../../plugins/stream-radio/core/player'
import { VOLUME_STEP } from '../../../plugins/stream-radio/core/nowplaying'
import { DEFAULT_CONFIG } from '../src/config'
import { memoryStore } from '../src/host-node'
import type { Session } from '../src/session'
import { App } from '../src/ui/App'

// The actions that would talk to mpv are spies; everything else in the core
// (the rows, the times) is the real thing.
vi.mock('../../../plugins/stream-radio/core/player', async original => {
  const real = await original<typeof import('../../../plugins/stream-radio/core/player')>()
  return {
    ...real,
    togglePause: vi.fn(async () => true),
    step: vi.fn(async () => ''),
    pick: vi.fn(async () => ''),
    setVolume: vi.fn(async (_h: Host, _c: number, level: number) => `Volume ${level}%.`),
    toggleShuffle: vi.fn(async () => 'Shuffled.'),
    setRepeat: vi.fn(async () => 'Repeat: this song.'),
    stopPlaying: vi.fn(async () => undefined),
    resume: vi.fn(),
    start: vi.fn(),
    locate: vi.fn(async (_h: Host, args: string) => ({ kind: 'play', url: args })),
    mpv: vi.fn(async (_h: Host, command: readonly unknown[]) => (command[1] === 'duration' ? { data: 245 } : undefined)),
  }
})

const ALBUM = '/m/Album'
const PLAYING: Partial<PlayerKeys> = {
  playing: 'Song three',
  elapsed: 161,
  lastUrl: ALBUM,
  queue: {
    kind: 'playlist',
    items: ['Intro', 'Song two', 'Song three', 'Other'],
    paths: [`${ALBUM}/Disc 1/01.mp3`, `${ALBUM}/Disc 1/02.mp3`, `${ALBUM}/Disc 1/03.mp3`, `${ALBUM}/Disc 2/01.mp3`],
    root: ALBUM,
    current: 2,
  },
  openFolders: [`${ALBUM}/Disc 1`],
  volume: 60,
}

const tick = () => new Promise(r => setTimeout(r, 30))
const UP = '\x1b[A'
const ENTER = '\r'

// A session over a real store: the App draws what is in it and calls the
// (mocked) core actions with its host.
async function show(columns: number, state: Partial<PlayerKeys> = PLAYING, status = '') {
  const listeners = new Set<() => void>()
  let seq = status ? 1 : 0
  const vars = memoryStore(() => listeners.forEach(fn => fn()))
  for (const [k, v] of Object.entries(state)) await vars.change(k as keyof PlayerKeys, () => v as never)
  const host = { program: 'tui', vars } as unknown as Host
  const session: Session = { host, config: { ...DEFAULT_CONFIG }, close: vi.fn(), status: () => status, statusSeq: () => seq }
  // the session says something (again), as its say() does
  const say = (text: string) => {
    status = text
    seq += 1
    listeners.forEach(fn => fn())
  }
  const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }
  const ui = render(<App session={session} subscribe={subscribe} />)
  if (columns !== 100) {
    Object.defineProperty(ui.stdout, 'columns', { value: columns, configurable: true })
    ui.stdout.emit('resize')
  }
  await tick()
  const lines = () => (ui.lastFrame() ?? '').split('\n')
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      ui.stdin.write(k)
      await tick()
    }
  }
  return { ui, session, host, vars, lines, press, say }
}

const lineOf = (lines: string[], re: RegExp) => lines.findIndex(l => re.test(l))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('drawing', () => {
  test('at 100 columns: the list on the left, now playing beside it, both hint lines', async () => {
    const { lines } = await show(100)
    const all = lines()
    expect(all[0]).toContain('stream-radio')
    // the current song's row carries the mark
    expect(all[lineOf(all, /3\. Song three/)]).toMatch(/▶\s+3\. Song three/)
    expect(all.some(l => /^\s*2\. Song two/.test(l.trimStart()) && !l.includes('▶ '))).toBe(true)
    // now playing sits on the same line as the list's heading
    const heading = lineOf(all, /Playlist/)
    expect(all[heading]).toMatch(/Playlist.*▶ Song three/)
    expect(all.join('\n')).toMatch(/2:41 ━+─* 4:05/)
    expect(all.join('\n')).toContain('vol 60')
    expect(all.join('\n')).toContain('repeat all')
    expect(all.join('\n')).toContain('shuffle off')
    expect(lineOf(all, /space pause.*n\/p next\/prev.*\/ filter/)).toBeGreaterThan(heading)
    expect(lineOf(all, /o open url\/path.*l play last.*x stop.*q quit/)).toBeGreaterThan(heading)
    expect(all.every(l => l.length <= 100)).toBe(true)
  })

  test('under 80 columns now playing stacks above the list', async () => {
    const { lines } = await show(60)
    const all = lines()
    const title = lineOf(all, /▶ Song three/)
    const heading = lineOf(all, /Playlist/)
    expect(title).toBeGreaterThan(-1)
    expect(heading).toBeGreaterThan(title)
    expect(all[heading]).not.toContain('Song three')
    expect(all[lineOf(all, /3\. Song three/)]).toMatch(/▶\s+3\. Song three/)
    expect(lineOf(all, /space pause/)).toBeGreaterThan(heading)
    expect(lineOf(all, /q quit/)).toBeGreaterThan(heading)
    expect(all.every(l => l.length <= 60)).toBe(true)
  })

  test('a live stream shows ♪ live instead of a bar', async () => {
    const { lines } = await show(100, { playing: 'Radio Paradise', elapsed: -1 })
    expect(lines().join('\n')).toContain('♪ live')
    expect(lines().join('\n')).not.toContain('━')
  })

  test("a start failure's reason shows on the status line, above the hints", async () => {
    const { lines } = await show(100, {}, 'mpv: not found')
    const all = lines()
    const hint = lineOf(all, /space pause/)
    expect(all[hint - 1]).toContain('mpv: not found')
  })
})

test('the same status said again shows again, after a reply replaced it', async () => {
  const { press, lines, say } = await show(100, PLAYING, 'mpv: not found')
  await press('+')
  expect(lines().join('\n')).not.toContain('mpv: not found')
  say('mpv: not found')
  await tick()
  const all = lines()
  expect(all[lineOf(all, /space pause/) - 1]).toContain('mpv: not found')
})

describe('keys', () => {
  test('keys written back to back, before a redraw, each see the mode the one before set', async () => {
    const { ui, lines } = await show(100)
    for (const k of ['/', 'a', 'b', 'c']) ui.stdin.write(k)
    await tick()
    expect(lines().join('\n')).toContain('/ filter: abc_')
  })

  test('a fast Enter after typing in open mode submits all of it', async () => {
    const { ui, host } = await show(100)
    for (const k of ['o', '/', 'm', ENTER]) ui.stdin.write(k)
    await tick()
    expect(player.locate).toHaveBeenCalledWith(host, '/m', '')
  })

  test("o with a path that won't play puts the reason on the status line", async () => {
    vi.mocked(player.locate).mockResolvedValueOnce({ kind: 'error', text: 'No such file or folder: /nope' })
    const { press, lines } = await show(100)
    await press('o', '/nope', ENTER)
    const all = lines()
    expect(all[lineOf(all, /space pause/) - 1]).toContain('No such file or folder: /nope')
  })

  test('space pauses through the core', async () => {
    const { press, host } = await show(100)
    await press(' ')
    expect(player.togglePause).toHaveBeenCalledWith(host)
  })

  test('q lets go of the player and never stops it', async () => {
    const { press, session } = await show(100)
    await press('q')
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(player.stopPlaying).not.toHaveBeenCalled()
  })

  test('x stops the player', async () => {
    const { press, host, session } = await show(100)
    await press('x')
    expect(player.stopPlaying).toHaveBeenCalledWith(host, session.config)
    expect(session.close).not.toHaveBeenCalled()
  })

  test("an action's reply shows on the status line", async () => {
    const { press, host, lines } = await show(100)
    await press('+')
    expect(player.setVolume).toHaveBeenCalledWith(host, DEFAULT_CONFIG.volume, 65)
    expect(lines().join('\n')).toContain('Volume 65%.')
  })

  test('keys that arrive together each step from the volume the one before set', async () => {
    const { ui, vars } = await show(100)
    const set = async (h: Host, _c: number, level: number) => {
      await h.vars.change('volume', () => level)
      return `Volume ${level}%.`
    }
    vi.mocked(player.setVolume).mockImplementationOnce(set).mockImplementationOnce(set).mockImplementationOnce(set)
    ui.stdin.write('+')
    ui.stdin.write('+')
    ui.stdin.write('+')
    await tick()
    expect(await vars.read('volume')).toBe(60 + 3 * VOLUME_STEP)
    expect(vi.mocked(player.setVolume).mock.calls.map(c => c[2])).toEqual([60 + VOLUME_STEP, 60 + 2 * VOLUME_STEP, 60 + 3 * VOLUME_STEP])
  })

  test('Enter on a folder shuts it (the mark moves to it); on a song, plays it', async () => {
    const { press, host, vars, lines } = await show(100)
    await press(UP, ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, 1)
    await press(UP, UP, ENTER)
    expect(await vars.read('openFolders')).toEqual([])
    expect(lines().join('\n')).not.toContain('Song two')
    expect(lines().join('\n')).toMatch(/▶ ▸ 📁 Disc 1\/ · 3/)
    await press('\x1b[C')
    expect(await vars.read('openFolders')).toEqual([`${ALBUM}/Disc 1`])
  })

  test('/ filters as you type; Enter plays the first match', async () => {
    const { press, host, lines } = await show(100)
    await press('/', 'o', 't', 'h')
    expect(lines().join('\n')).toContain('/ filter: oth')
    expect(lines().join('\n')).not.toContain('Intro')
    await press(ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, 3)
  })

  test('o opens a URL or path', async () => {
    const { press, host, session } = await show(100)
    await press('o', '/m/x', ENTER)
    expect(player.locate).toHaveBeenCalledWith(host, '/m/x', '')
    expect(player.start).toHaveBeenCalledWith(host, session.config, '/m/x')
  })
})

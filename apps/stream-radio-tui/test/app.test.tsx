import { afterAll, afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import nodeFs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host, PlayerKeys } from '@core/host'
import * as player from '@core/player'
import { moveBy, moveTo } from '@core/queue'
import { DEFAULT_CONFIG } from '../src/config'
import { memoryStore, nodeHost } from '../src/host-node'
import type { Session } from '../src/session'
import { App } from '../src/ui/App'
import type { Media } from '../src/media'
import type { Wave } from '../src/media/peaks'
import { kittyGraphics, type Graphics } from '../src/gfx/screen'
import { tilde } from '../src/ui/hooks'
import { ICONS } from '../src/ui/Controls'
import type { MouseEvent, MouseSource } from '../src/mouse/sgr'
import { tagReader, type TagReader } from '../src/media/tags'

// What the mocked mpv answers, unless a test says otherwise (and afterEach
// puts it back): the length, and the song's tags.
const { defaultMpv } = vi.hoisted(() => ({
  defaultMpv: async (_h: unknown, command: readonly unknown[]) =>
    command[1] === 'duration' ? { data: 245 } : command[1] === 'metadata' ? { data: { ARTIST: 'The Band', Album: 'The Album' } } : undefined,
}))

// The actions that would talk to mpv are spies; everything else in the core
// (the rows, the times) is the real thing.
vi.mock('@core/player', async original => {
  const real = await original<typeof import('@core/player')>()
  return {
    ...real,
    togglePause: vi.fn(async () => true),
    step: vi.fn(async () => ''),
    pick: vi.fn(async () => ''),
    setVolume: vi.fn(async (_h: Host, _c: number, level: number) => `Volume ${level}%.`),
    toggleShuffle: vi.fn(async () => 'Shuffled.'),
    setRepeat: vi.fn(async () => 'Repeat: this song.'),
    stopPlaying: vi.fn(async () => undefined),
    resumeQueue: vi.fn(async () => ''),
    playQueue: vi.fn(async () => ''),
    seek: vi.fn(async () => ''),
    playSource: vi.fn(async () => ''),
    locate: vi.fn(async (_h: Host, args: string) => ({ kind: 'play', url: args })),
    mpv: vi.fn(defaultMpv),
    // as the core does: the queue in the store follows the new order
    reorderQueue: vi.fn(async (h: Host, order: readonly number[]) => {
      await h.vars.change('queue', q => ({ ...q, items: order.map(i => q.items[i]!), paths: q.paths.length ? order.map(i => q.paths[i]!) : q.paths }))
      return ''
    }),
    sortQueue: vi.fn(async (h: Host, _field: string, _rev: boolean, order: readonly number[]) => {
      await h.vars.change('queue', q => ({ ...q, items: order.map(i => q.items[i]!), paths: q.paths.length ? order.map(i => q.paths[i]!) : q.paths }))
      return ''
    }),
    unsortQueue: vi.fn(async () => ''),
    clearQueue: vi.fn(async () => 'Cleared the queue. l brings it back.'),
    removeFromQueue: vi.fn(async () => ''),
    addToQueue: vi.fn(async () => ''),
    playEntries: vi.fn(async () => ''),
    // the real expansion, unless a test says otherwise
    expandEntries: vi.fn(real.expandEntries),
  }
})

// One state folder for the whole file: core's paths() keeps the first it sees.
const TMP = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'sr-app-'))
const STATE = nodePath.join(TMP, 'state')
nodeFs.mkdirSync(STATE, { recursive: true })
afterAll(() => nodeFs.rmSync(TMP, { recursive: true, force: true }))

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
// Until the screen holds still for a tick, at most 2 s: a slow machine, or a
// cold first test, takes longer than one tick to draw what a key did.
async function settle(frame: () => string | undefined) {
  const end = Date.now() + 2000
  let last = frame()
  for (;;) {
    await tick()
    const now = frame()
    if (now === last || Date.now() > end) return
    last = now
  }
}
const UP = '\x1b[A'
const ENTER = '\r'
const ESC = '\x1b'
const [PG_UP, PG_DOWN, HOME, END] = ['\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F']

// A session over a real store: the App draws what is in it and calls the
// (mocked) core actions with its host.
// library: the saved playlists' data folder (XDG_DATA_HOME), files read for real, and the poll's timer.
type Extra = { media?: Media; graphics?: Graphics; rows?: number; tags?: TagReader; fs?: Partial<Host['fs']>; library?: { data: string; every: Host['every'] } }
async function show(columns: number, state: Partial<PlayerKeys> = PLAYING, status = '', home = '', extra: Extra = {}) {
  const { media, graphics, rows, tags, fs, library } = extra
  const listeners = new Set<() => void>()
  let seq = status ? 1 : 0
  const vars = memoryStore(() => listeners.forEach(fn => fn()))
  for (const [k, v] of Object.entries(state)) await vars.change(k as keyof PlayerKeys, () => v as never)
  const host = (
    library
      ? { ...nodeHost({ titleChanged: () => undefined, watching: () => undefined }, vars, { env: { HOME: home || TMP, XDG_DATA_HOME: library.data } }), home: async () => home, dataDir: async () => STATE, every: library.every }
      : { program: 'tui', vars, home: async () => home, fs, dataDir: async () => STATE, libraryDir: async () => '', every: () => ({ cancel: () => undefined }) }
  ) as unknown as Host
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
  const mouseFns = new Set<(e: MouseEvent) => void>()
  const mouse: MouseSource = fn => (mouseFns.add(fn), () => void mouseFns.delete(fn))
  const onMouse = (e: MouseEvent) => mouseFns.forEach(fn => fn(e))
  const ui = render(<App session={session} subscribe={subscribe} media={media} graphics={graphics} mouse={mouse} tags={tags} />)
  if (columns !== 100 || rows) {
    Object.defineProperty(ui.stdout, 'columns', { value: columns, configurable: true })
    if (rows) Object.defineProperty(ui.stdout, 'rows', { value: rows, configurable: true })
    ui.stdout.emit('resize')
  }
  // the player draws once its state is read: keys sent before then are lost
  await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('stream-radio'), { timeout: 5000 })
  const frame = () => ui.lastFrame()
  await settle(frame)
  const lines = () => (ui.lastFrame() ?? '').split('\n')
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      ui.stdin.write(k)
      await settle(frame)
    }
  }
  // The mouse: cells are 0-based from the top left, as the app is drawn.
  const click = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'left', x, y })
    onMouse({ kind: 'release', button: 'left', x, y })
    await settle(frame)
  }
  const dblclick = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'left', x, y })
    onMouse({ kind: 'press', button: 'left', x, y })
    await settle(frame)
  }
  const rightClick = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'right', x, y })
    onMouse({ kind: 'release', button: 'right', x, y })
    await settle(frame)
  }
  const modClick = async (x: number, y: number, mod: 'shift' | 'alt' | 'ctrl') => {
    const mods = { shift: mod === 'shift', alt: mod === 'alt', ctrl: mod === 'ctrl' }
    onMouse({ kind: 'press', button: 'left', x, y, mods })
    onMouse({ kind: 'release', button: 'left', x, y, mods })
    await settle(frame)
  }
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    onMouse({ kind: 'press', button: 'left', ...from })
    await settle(frame)
    onMouse({ kind: 'drag', button: 'left', x: to.x, y: Math.round((from.y + to.y) / 2) })
    onMouse({ kind: 'drag', button: 'left', ...to })
    await settle(frame)
    onMouse({ kind: 'release', button: 'left', ...to })
    await settle(frame)
  }
  const wheel = async (x: number, y: number, dir: 'up' | 'down') => {
    onMouse({ kind: 'wheel', button: 'none', dir, x, y })
    await settle(frame)
  }
  // Where `text` first shows: its line, and the column of its first character.
  const where = (text: string) => {
    const y = lines().findIndex(l => l.includes(text))
    expect(y, `"${text}" on screen`).toBeGreaterThanOrEqual(0)
    const line = stripAnsi(lines()[y])
    return { x: columnOf(line, line.indexOf(text)), y }
  }
  const settled = () => settle(frame)
  return { ui, session, host, vars, lines, press, settled, say, click, dblclick, rightClick, modClick, drag, wheel, where }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
// The screen column of `line[index]`: an emoji such as 📁 takes two; the
// private-use characters (Nerd Font icons, the image placeholder), one.
const columnOf = (line: string, index: number) =>
  [...line.slice(0, index)].reduce((n, ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return n + (cp > 0xffff && cp < 0xf0000 ? 2 : 1)
  }, 0)

const lineOf = (lines: string[], re: RegExp) => lines.findIndex(l => re.test(l))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.mocked(player.mpv).mockImplementation(defaultMpv as typeof player.mpv)
})

describe('drawing', () => {
  test('at 100 columns: the list on the left, now playing beside it, both hint lines', async () => {
    const { lines } = await show(100)
    // the length comes from mpv after the first draw; a cold first test can outlast the tick
    await vi.waitFor(() => expect(lines().join('\n')).toMatch(/2:41 ━+─* 4:05/))
    const all = lines()
    expect(all[0]).toContain('stream-radio')
    // the current song's row carries the mark
    expect(all[lineOf(all, /3\. Song three/)]).toMatch(/▶\s+3\. Song three/)
    expect(all.some(l => /^\s*2\. Song two/.test(l.trimStart()) && !l.includes('▶ '))).toBe(true)
    // now playing sits on the same line as the list's heading
    const heading = lineOf(all, /Queue/)
    expect(stripAnsi(all[heading])).toMatch(/Queue.*▶ ☆ Song three/)
    expect(all.join('\n')).toMatch(/2:41 ━+─* 4:05/)
    expect(all.join('\n')).toContain('vol 60%')
    expect(all.join('\n')).toContain('repeat all')
    expect(all.join('\n')).toContain('shuffle off')
    expect(lineOf(all, /space pause.*n\/p next\/prev.*\/ filter/)).toBeGreaterThan(heading)
    expect(lineOf(all, /\? all keys.*o go to.*l resume.*x stop.*q quit/)).toBeGreaterThan(heading)
    expect(all.every(l => [...l].length <= 100)).toBe(true)
  })

  test('under 80 columns now playing stacks above the list', async () => {
    const { lines } = await show(60)
    const all = lines()
    const title = all.findIndex(l => stripAnsi(l).includes('▶ ☆ Song three'))
    const heading = lineOf(all, /Queue/)
    expect(title).toBeGreaterThan(-1)
    expect(heading).toBeGreaterThan(title)
    expect(all[heading]).not.toContain('Song three')
    expect(all[lineOf(all, /3\. Song three/)]).toMatch(/▶\s+3\. Song three/)
    expect(lineOf(all, /space pause/)).toBeGreaterThan(heading)
    expect(lineOf(all, /q quit/)).toBeGreaterThan(heading)
    expect(all.every(l => l.length <= 60)).toBe(true)
  })

  test('the queue under the home folder is headed with ~', async () => {
    const { lines } = await show(100, PLAYING, '', '/m')
    expect(lines().join('\n')).toContain('Queue · ~/Album')
    expect(tilde('/m', '/m')).toBe('~')
    expect(tilde('/music/Album', '/m')).toBe('/music/Album')
    expect(tilde('/m/Album', '')).toBe('/m/Album')
  })

  test('a live stream shows ♪ live instead of a bar', async () => {
    const { lines } = await show(100, { playing: 'Radio Paradise', elapsed: -1 })
    expect(lines().join('\n')).toContain('♪ live')
    expect(lines().join('\n')).not.toContain('━')
  })

  test('a length mpv does not know yet at the title change is asked again as the position moves', async () => {
    // The queue's next file: the title changes while mpv is still opening it,
    // so its duration is unavailable then; a second later it is known.
    let isLoaded = false
    vi.mocked(player.mpv).mockImplementation(async (_h, command) =>
      command[1] === 'duration' ? (isLoaded ? { data: 245 } : undefined) : undefined,
    )
    const { settled, lines, vars } = await show(100)
    expect(lines().join('\n')).toContain('♪ live')
    isLoaded = true
    await vars.change('elapsed', () => 162)
    await settled()
    expect(lines().join('\n')).not.toContain('♪ live')
    expect(lines().join('\n')).toContain('4:05')
  })

  test("a start failure's reason shows on the status line, above the hints", async () => {
    const { lines } = await show(100, {}, 'mpv: not found')
    const all = lines()
    const hint = lineOf(all, /space pause/)
    expect(all[hint - 1]).toContain('mpv: not found')
  })
})

// A Media whose decodes the test resolves by hand, one per file.
function fakeMedia() {
  const pending = new Map<string, { resolve: (w: Wave | undefined) => void; signal: AbortSignal }>()
  const media: Media = {
    isLocalFile: async () => true,
    peaks: (file, signal) => new Promise(resolve => pending.set(file, { resolve, signal })),
    sources: async () => [],
    art: async () => undefined,
  }
  return { media, pending }
}
const BRAILLE = /[\u2800-\u28FF]{20,}/
const flat = (v: number): Wave => ({ peak: new Uint8Array(2048).fill(v), rms: new Uint8Array(2048).fill(v >> 1) })
const SONG3 = `${ALBUM}/Disc 1/03.mp3`

describe('pane', () => {
  test('a local song shows its waveform, four rows, at the foot of the pane, with the times above it', async () => {
    const { media, pending } = fakeMedia()
    const { lines } = await show(100, PLAYING, '', '', { media })
    await vi.waitFor(() => expect(pending.has(SONG3)).toBe(true))
    pending.get(SONG3)!.resolve(flat(128))
    await vi.waitFor(() => expect(lines().filter(l => BRAILLE.test(l))).toHaveLength(4))
    const all = lines()
    const wave = all.findIndex(l => BRAILLE.test(l))
    expect(all[wave - 1]).toMatch(/2:41\s+4:05/)
    expect(all.join('\n')).not.toContain('━')
    // the pane runs down to the line above the text line
    expect(all[wave + 4]).not.toContain('│')
  })

  test('until the waveform is ready the bar shows', async () => {
    const { media } = fakeMedia()
    const { lines } = await show(100, PLAYING, '', '', { media })
    await vi.waitFor(() => expect(lines().join('\n')).toMatch(/2:41 ━+─* 4:05/))
    expect(lines().some(l => BRAILLE.test(l))).toBe(false)
  })

  test("a song changed before its waveform came back never shows the old one, and the old decode is stopped", async () => {
    const { media, pending } = fakeMedia()
    const { settled, lines, vars } = await show(100, PLAYING, '', '', { media })
    await vi.waitFor(() => expect(pending.has(SONG3)).toBe(true))
    await vars.change('queue', q => ({ ...q, current: 1 }))
    await vars.change('playing', () => 'Song two')
    await vi.waitFor(() => expect(pending.has(`${ALBUM}/Disc 1/02.mp3`)).toBe(true))
    expect(pending.get(SONG3)!.signal.aborted).toBe(true)
    pending.get(SONG3)!.resolve(flat(255))
    await settled()
    expect(lines().some(l => BRAILLE.test(l))).toBe(false)
  })

  test("the artist and album show under the title", async () => {
    const { lines } = await show(100)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('The Band · The Album'))
  })

  test('the controls and the volume bar share a line; repeat and shuffle the next', async () => {
    const { lines } = await show(100)
    const at = lineOf(lines(), new RegExp(`${ICONS.prev} +${ICONS.pause} +${ICONS.next} +${ICONS.stop} +\\|.*vol 60%.*\\|`, 'u'))
    expect(at).toBeGreaterThan(0)
    expect(lines()[at + 1]).toMatch(/repeat all\s+shuffle off/)
  })
})

// The escapes a fake terminal was sent, and a Graphics that sends them there.
function fakeScreen() {
  const out: string[] = []
  const graphics = kittyGraphics(s => void out.push(s), { width: 8, height: 16 })
  return { graphics, sent: () => out.join(''), clear: () => void (out.length = 0) }
}
const P = '\u{10EEEE}'
const sgr = (id: number) => `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`
const placed = (id: number) => `a=p,U=1,q=2,i=${id},`
const deleted = (id: number) => `a=d,d=I,q=2,i=${id}\x1b`
// Media with an 800×450 picture and a waveform, both at once.
const pictureMedia = (art = true): Media => ({
  isLocalFile: async () => true,
  peaks: async () => flat(128),
  sources: async () => [{ kind: 'file', path: SONG3 }],
  art: async () => (art ? { width: 800, height: 450, rgba: new Uint8Array(800 * 450 * 4) } : undefined),
})

describe('pixels', () => {
  // 100 columns: the pane is 33 wide; 40 rows: the pane is 33 tall, 24 of
  // them free for art. 800×450 at 33 columns of 8×16 cells is 9 rows.
  test('the art sits at the top of the pane, the title under it, the waveform at the foot', async () => {
    const screen = fakeScreen()
    const { lines } = await show(100, PLAYING, '', '', { media: pictureMedia(), graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(lines().filter(l => l.includes(sgr(1)))).toHaveLength(1))
    const all = lines()
    const artRows = [...Array(9).keys()].map(i => all.findIndex(l => l.includes(sgr(1 + i) + P.repeat(33))))
    expect(artRows.every(r => r > 0)).toBe(true)
    expect(all.findIndex(l => l.includes(sgr(10)))).toBe(-1)
    const title = all.findIndex(l => stripAnsi(l).includes('▶ ☆ Song three'))
    expect(title).toBe(artRows[8] + 1)
    // sent from an effect, just after the rows are drawn
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(9)))
    expect(screen.sent()).toContain(placed(1))
    await vi.waitFor(() => expect(lines().some(l => l.includes(sgr(201)))).toBe(true))
    const wave = lines().findIndex(l => l.includes(sgr(201)))
    for (const i of [1, 2, 3]) expect(lines()[wave + i]).toContain(sgr(201 + i))
    expect(lines()[wave - 1]).toMatch(/2:41\s+4:05/)
    expect(screen.sent()).toContain(placed(201))
    expect(screen.sent()).toContain(placed(204))
  })

  test('the next song keeps the art on screen until its own art is ready', async () => {
    const screen = fakeScreen()
    const later: ((a: { width: number; height: number; rgba: Uint8Array }) => void)[] = []
    const media: Media = {
      ...pictureMedia(),
      art: () => new Promise(resolve => later.push(resolve)),
    }
    const { settled, lines, vars } = await show(100, PLAYING, '', '', { media, graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(later).toHaveLength(1))
    later[0]({ width: 800, height: 450, rgba: new Uint8Array(800 * 450 * 4) })
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(9)))
    screen.clear()
    await vars.change('queue', q => ({ ...q, current: 1 }))
    await vars.change('playing', () => 'Song two')
    await vi.waitFor(() => expect(later).toHaveLength(2))
    await settled()
    // still drawn, nothing deleted, the title still under the art
    expect(lines().some(l => l.includes(sgr(9)))).toBe(true)
    expect(screen.sent()).not.toContain(deleted(1))
    expect(lines().findIndex(l => stripAnsi(l).includes('▶ ☆ Song two'))).toBe(lines().findIndex(l => l.includes(sgr(9))) + 1)
  })

  test('no art: a big ♪ drawn in pixels, square, at the top', async () => {
    const screen = fakeScreen()
    const { lines } = await show(100, PLAYING, '', '', { media: pictureMedia(false), graphics: screen.graphics, rows: 40 })
    // 33 columns of 8×16 cells: a square is 33 wide, 17 rows tall (264 px of 272)
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(17)))
    expect(screen.sent()).not.toContain(placed(18))
    expect(lines().some(l => l.includes(sgr(1) + P.repeat(33)))).toBe(true)
    expect(lines().findIndex(l => stripAnsi(l).includes('▶ ☆ Song three'))).toBe(lines().findIndex(l => l.includes(sgr(17))) + 1)
  })

  test('narrowing the pane refits the art and deletes the rows it no longer uses', async () => {
    const screen = fakeScreen()
    const { ui, lines } = await show(120, PLAYING, '', '', { media: pictureMedia(), graphics: screen.graphics, rows: 40 })
    // 120 columns: the pane is 40 wide, 11 rows of art
    await vi.waitFor(() => expect(lines().some(l => l.includes(sgr(11)))).toBe(true))
    screen.clear()
    Object.defineProperty(ui.stdout, 'columns', { value: 100, configurable: true })
    ui.stdout.emit('resize')
    await vi.waitFor(() => expect(screen.sent()).toContain(deleted(11)))
    expect(screen.sent()).toContain(deleted(10))
    expect(screen.sent()).toContain(placed(9))
    expect(lines().some(l => l.includes(sgr(10)))).toBe(false)
  })

  test('a drag of resizes redraws the text at once and the pictures once, when it stops', async () => {
    const screen = fakeScreen()
    const { ui, lines } = await show(120, PLAYING, '', '', { media: pictureMedia(), graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(11)))
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(201)))
    screen.clear()
    const sends = (id: number) => screen.sent().split(`a=t,`).filter(part => part.includes(`,i=${id},`)).length
    for (const columns of [118, 114, 110, 106, 102, 100]) {
      Object.defineProperty(ui.stdout, 'columns', { value: columns, configurable: true })
      ui.stdout.emit('resize')
      await new Promise(r => setTimeout(r, 20))
      // the text follows at once: nothing wider than the screen
      expect(lines().every(l => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length <= columns)).toBe(true)
    }
    // nothing sent while the size kept changing
    expect(sends(1)).toBe(0)
    expect(sends(201)).toBe(0)
    // then once, at the size it settled on: 33 columns, 9 rows of art
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(9)))
    await vi.waitFor(() => expect(sends(201)).toBe(1))
    expect(sends(1)).toBe(1)
    expect(screen.sent()).toContain(deleted(11))
    expect(lines().some(l => l.includes(sgr(9) + P.repeat(33)))).toBe(true)
  })

  test('narrow: no pictures, the bar as before, and what was shown is deleted', async () => {
    const screen = fakeScreen()
    const { ui, lines } = await show(100, PLAYING, '', '', { media: pictureMedia(), graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(1)))
    Object.defineProperty(ui.stdout, 'columns', { value: 60, configurable: true })
    ui.stdout.emit('resize')
    await vi.waitFor(() => expect(screen.sent()).toContain(deleted(1)))
    expect(lines().join('\n')).not.toContain(P)
    expect(lines().join('\n')).toMatch(/2:41 ━+─* 4:05/)
  })
})

test('the same status said again shows again, after a reply replaced it', async () => {
  const { settled, press, lines, say } = await show(100, PLAYING, 'mpv: not found')
  await press('+')
  expect(lines().join('\n')).not.toContain('mpv: not found')
  say('mpv: not found')
  await settled()
  const all = lines()
  expect(all[lineOf(all, /space pause/) - 1]).toContain('mpv: not found')
})

describe('keys', () => {
  test('keys written back to back, before a redraw, each see the mode the one before set', async () => {
    const { settled, ui, lines } = await show(100)
    for (const k of ['/', 'a', 'b', 'c']) ui.stdin.write(k)
    await settled()
    expect(lines().join('\n')).toContain('/ filter: abc_')
  })

  test('a fast Enter after typing in open mode submits all of it', async () => {
    const { settled, ui, lines } = await show(100)
    for (const k of ['o', '/', 'n', 'o', ENTER]) ui.stdin.write(k)
    await settled()
    // no files in this host: the whole path typed is the one that isn't there
    expect(lines().join('\n')).toContain('No such folder: /no')
  })

  test('space pauses through the core', async () => {
    const { press, host } = await show(100)
    await press(' ')
    expect(player.togglePause).toHaveBeenCalledWith(host)
  })

  test("space while stopped with a queue plays it from its song's start, as ▶ does", async () => {
    const { press, host, session, ui } = await show(100, { ...PLAYING, playing: '', elapsed: -1 })
    await press(' ')
    expect(player.playQueue).toHaveBeenCalledWith(host, session.config, session.config.defaultUrl)
    expect(player.togglePause).not.toHaveBeenCalled()
    expect(ui.lastFrame()).not.toContain('The player is not ready yet.')
  })

  test('q lets go of the player and never stops it', async () => {
    const { press, session } = await show(100)
    await press('q')
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(player.stopPlaying).not.toHaveBeenCalled()
  })

  test('Ctrl-C once only says how to quit; again within 2 seconds quits', async () => {
    let now = 10_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    onTestFinished(() => clock.mockRestore())
    const { press, session, lines } = await show(100)
    await press('\x03')
    expect(session.close).not.toHaveBeenCalled()
    expect(lines().join('\n')).toContain('Press Ctrl+C again to quit.')
    // too late: the first press has lapsed, this one only warns again
    now += 2500
    await press('\x03')
    expect(session.close).not.toHaveBeenCalled()
    now += 1500
    await press('\x03')
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
    expect(player.setVolume).toHaveBeenCalledWith(host, DEFAULT_CONFIG.volume, 67)
    expect(lines().join('\n')).toContain('Volume 67%.')
    // a step down from 60 is as much quieter as a step up is louder
    await press('-')
    expect(player.setVolume).toHaveBeenLastCalledWith(host, DEFAULT_CONFIG.volume, 53)
  })

  test('l while the last URL plays leaves it be and says so', async () => {
    const { press, lines } = await show(100)
    await press('l')
    expect(player.resumeQueue).not.toHaveBeenCalled()
    expect(lines().join('\n')).toContain('Already playing Song three.')
  })

  test('l while a play is still loading or connecting resumes, not "Already playing loading…"', async () => {
    for (const playing of ['loading…', 'connecting…']) {
      vi.mocked(player.resumeQueue).mockClear()
      const { press, host, lines, ui } = await show(100, { ...PLAYING, playing })
      await press('l')
      expect(player.resumeQueue).toHaveBeenCalledWith(host, expect.anything(), expect.anything())
      expect(lines().join('\n')).not.toContain('Already playing')
      ui.unmount()
    }
  })

  test('l after a stop picks the last URL up again', async () => {
    const { press, host } = await show(100, { ...PLAYING, playing: '', elapsed: -1 })
    await press('l')
    expect(player.resumeQueue).toHaveBeenCalledWith(host, expect.anything(), expect.anything())
  })

  test('keys that arrive together each step from the volume the one before set', async () => {
    const { settled, ui, vars } = await show(100)
    const set = async (h: Host, _c: number, level: number) => {
      await h.vars.change('volume', () => level)
      return `Volume ${level}%.`
    }
    vi.mocked(player.setVolume).mockImplementationOnce(set).mockImplementationOnce(set).mockImplementationOnce(set)
    ui.stdin.write('+')
    ui.stdin.write('+')
    ui.stdin.write('+')
    await settled()
    expect(await vars.read('volume')).toBe(84)
    expect(vi.mocked(player.setVolume).mock.calls.map(c => c[2])).toEqual([67, 75, 84])
  })

  test('Enter on a song plays it', async () => {
    const { press, host } = await show(100)
    await press(UP, ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, expect.anything(), 1)
  })

  test('/ filters as you type; Enter plays the first match', async () => {
    const { press, host, lines } = await show(100)
    await press('/', 'o', 't', 'h')
    expect(lines().join('\n')).toContain('/ filter: oth')
    expect(lines().join('\n')).not.toContain('Intro')
    await press(ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, expect.anything(), 3)
  })

})

describe('mouse rows', () => {
  const LONG: Partial<PlayerKeys> = {
    ...PLAYING,
    queue: {
      kind: 'playlist',
      items: [...Array(30).keys()].map(i => `Track ${i + 1}`),
      paths: [...Array(30).keys()].map(i => `${ALBUM}/${String(i + 1).padStart(2, '0')}.mp3`),
      root: ALBUM,
      current: 0,
    },
    openFolders: [],
  }
  // The number of the first track the list shows.
  const firstShown = (all: string[]) => Number(/(\d+)\. Track/.exec(all[lineOf(all, /\d+\. Track/)])?.[1])

  test('a click selects a song; it does not play it', async () => {
    const { click, where, press, host } = await show(100)
    const at = where('Song two')
    await click(at.x, at.y)
    expect(player.pick).not.toHaveBeenCalled()
    await press(ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, expect.anything(), 1)
  })

  test('a double-click plays it', async () => {
    const { dblclick, where, host } = await show(100)
    const at = where('Song two')
    await dblclick(at.x, at.y)
    expect(player.pick).toHaveBeenCalledWith(host, expect.anything(), 1)
  })

  test('the wheel scrolls the list, not the selection; a click then lands where it points; a key brings the view back', async () => {
    const { wheel, click, where, press, lines, host } = await show(100, LONG)
    expect(firstShown(lines())).toBe(1)
    const list = where('Track 2')
    await wheel(list.x, list.y, 'down')
    expect(firstShown(lines())).toBe(4)
    // the selection stayed on the first track
    await press(ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), 0)
    // the row now under the pointer
    const under = Number(/(\d+)\. Track/.exec(lines()[list.y])![1])
    await click(list.x, list.y)
    expect(firstShown(lines())).toBe(4)
    await press(ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), under - 1)
    await press('j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j', 'j')
    expect(lines().some(l => l.includes(`${under + 20}. Track ${under + 20}`))).toBe(true)
  })

  test('the wheel stops at the ends', async () => {
    const { wheel, where, lines } = await show(100, LONG)
    const list = where('Track 2')
    for (let i = 0; i < 20; i++) await wheel(list.x, list.y, 'down')
    expect(lines().some(l => l.includes('30. Track 30'))).toBe(true)
    const last = firstShown(lines())
    await wheel(list.x, list.y, 'down')
    expect(firstShown(lines())).toBe(last)
    for (let i = 0; i < 20; i++) await wheel(list.x, list.y, 'up')
    expect(firstShown(lines())).toBe(1)
  })

  test('PgDn and PgUp move the cursor a page, keeping a row of the last; End and Home go to the last and first rows', async () => {
    const { press, lines, host } = await show(100, LONG)
    const height = lines().filter(l => /\d+\. Track/.test(l)).length
    await press(PG_DOWN, ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), height - 1)
    await press(END, ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), 29)
    expect(lines().some(l => l.includes('30. Track 30'))).toBe(true)
    await press(PG_UP, ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), 29 - (height - 1))
    await press(PG_DOWN, PG_DOWN, PG_DOWN, ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), 29)
    await press(HOME, ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, expect.anything(), 0)
    expect(firstShown(lines())).toBe(1)
  })

  test('End and Home bring a wheeled view back to the cursor', async () => {
    const { wheel, where, press, lines } = await show(100, LONG)
    const list = where('Track 2')
    await wheel(list.x, list.y, 'down')
    await press(HOME)
    expect(firstShown(lines())).toBe(1)
  })
})

describe('tabs', () => {
  // Tests draw without colour, so which tab shows is read from the heading
  // under the tab row.
  const INV = /^\s*Queue/
  const INV_FILES = /^\s*Files/
  const tabHeading = (all: string[]) => all[lineOf(all, /Files\s+Queue/) + 1] ?? ''
  const EMPTY: Partial<PlayerKeys> = { queue: { kind: 'none', items: [], paths: [], root: '', current: -1 } }

  test('starts on Queue with a queue, on Files without', async () => {
    const a = await show(100)
    expect(tabHeading(a.lines())).toMatch(INV)
    expect(a.lines().join('\n')).toContain('3. Song three')
    cleanup()
    const b = await show(100, EMPTY)
    expect(tabHeading(b.lines())).toMatch(INV_FILES)
  })

  test('Tab and Shift-Tab switch; each tab keeps its own list', async () => {
    const { press, lines } = await show(100)
    await press('\x1b[Z')
    expect(tabHeading(lines())).toMatch(INV_FILES)
    expect(lines().join('\n')).not.toContain('Song three ·')
    expect(lines().join('\n')).not.toMatch(/\d+\. Song two/)
    await press('\t')
    expect(tabHeading(lines())).toMatch(INV)
    expect(lines().join('\n')).toContain('2. Song two')
  })

  test('Tab cycles Files, Queue, Playlists; Shift-Tab goes back', async () => {
    const { press, lines } = await show(100)
    // each tab's list heading starts with its name
    const current = () => tabHeading(lines()).trim().split(' ')[0]
    expect(current()).toBe('Queue')
    await press('\t')
    expect(current()).toBe('Playlists')
    await press('\t')
    expect(current()).toBe('Files')
    await press('\t')
    expect(current()).toBe('Queue')
    await press('\x1b[Z')
    expect(current()).toBe('Files')
    await press('\x1b[Z')
    expect(current()).toBe('Playlists')
  })

  test('a click on a tab name switches', async () => {
    const { click, where, lines } = await show(100)
    const at = where(' Files ')
    await click(at.x + 2, at.y)
    expect(tabHeading(lines())).toMatch(INV_FILES)
    const back = where(' Queue ')
    await click(back.x + 2, back.y)
    expect(tabHeading(lines())).toMatch(INV)
  })

  test('rows show the title from the file\'s tags once read', async () => {
    const tags = tagReader(async p => ({ title: p.endsWith('02.mp3') ? 'Tagged Two' : '', artist: 'Tag Band', albumArtist: '', album: '' }))
    const fs = { stat: async () => ({ kind: 'file' as const, mtimeMs: 5 }) }
    const { lines } = await show(100, PLAYING, '', '', { tags, fs })
    await vi.waitFor(() => expect(lines().join('\n')).toMatch(/2\. Tagged Two · Tag Band/))
    expect(lines().join('\n')).toContain('1. Intro')
  })

  test('the queue is flat: every song, no folders, shut or not', async () => {
    const { lines } = await show(100, { ...PLAYING, openFolders: [] })
    const all = lines().join('\n')
    expect(all).not.toContain('📁')
    for (const n of ['1. Intro', '2. Song two', '3. Song three', '4. Other']) expect(all).toContain(n)
    // the folder, dimmed, after the title
    expect(all).toMatch(/4\. Other.*Disc 2/)
  })
})

// A small tree under /h, browsed in Files.
const BASE_TREE: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '/h': [{ name: 'Music', kind: 'dir' }],
  '/h/Music': [{ name: 'Album', kind: 'dir' }, { name: 'loose.mp3', kind: 'file' }, { name: 'cover.jpg', kind: 'file' }],
  '/h/Music/Album': [{ name: '01 One.flac', kind: 'file' }, { name: '02 Two.flac', kind: 'file' }],
  '/other': [{ name: 'x.mp3', kind: 'file' }],
}
function treeFs(tree: Record<string, { name: string; kind: 'file' | 'dir' }[]>, saved: Record<string, string> = {}) {
  return {
    list: async (p: string) => {
      if (!tree[p]) throw new Error('ENOENT')
      return tree[p]
    },
    stat: async (p: string) => {
      if (tree[p]) return { kind: 'dir' as const, mtimeMs: 1 }
      const slash = p.lastIndexOf('/')
      if (tree[p.slice(0, slash)]?.some(e => e.name === p.slice(slash + 1))) return { kind: 'file' as const, mtimeMs: 1 }
      throw new Error('ENOENT')
    },
    read: async (p: string) => {
      if (!(p in saved)) throw new Error('ENOENT')
      return saved[p]
    },
    write: async (p: string, text: string) => void (saved[p] = text),
    exists: async (p: string) => p in saved || p in tree,
  }
}
// Files showing ~/Music (nothing queued), with `over` replacing folders of the base tree.
const fsTree = (over: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {}) =>
  show(100, { queue: { kind: 'none', items: [], paths: [], root: '', current: -1 } }, '', '/h', { fs: treeFs({ ...BASE_TREE, ...over }) })

describe('files', () => {
  // A small tree, and a stat that knows it.
  const TREE: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    '/h': [{ name: 'Music', kind: 'dir' }],
    '/h/Music': [{ name: 'Album', kind: 'dir' }, { name: 'loose.mp3', kind: 'file' }, { name: 'cover.jpg', kind: 'file' }],
    '/h/Music/Album': [{ name: '01 One.flac', kind: 'file' }, { name: '02 Two.flac', kind: 'file' }],
    '/other': [{ name: 'x.mp3', kind: 'file' }],
  }
  const fsOf = (tree: Record<string, { name: string; kind: 'file' | 'dir' }[]>, saved: Record<string, string> = {}) => ({
    list: async (p: string) => {
      if (!tree[p]) throw new Error('ENOENT')
      return tree[p]
    },
    stat: async (p: string) => {
      if (tree[p]) return { kind: 'dir' as const, mtimeMs: 1 }
      const slash = p.lastIndexOf('/')
      if (tree[p.slice(0, slash)]?.some(e => e.name === p.slice(slash + 1))) return { kind: 'file' as const, mtimeMs: 1 }
      throw new Error('ENOENT')
    },
    read: async (p: string) => {
      if (!(p in saved)) throw new Error('ENOENT')
      return saved[p]
    },
    write: async (p: string, text: string) => void (saved[p] = text),
    exists: async (p: string) => p in saved || p in tree,
  })
  const EMPTY: Partial<PlayerKeys> = { queue: { kind: 'none', items: [], paths: [], root: '', current: -1 } }
  const showFiles = async (saved: Record<string, string> = {}, tree = TREE, extra: Extra = {}) => {
    return show(100, EMPTY, '', '/h', { fs: fsOf(tree, saved), ...extra })
  }
  const heading = (all: string[]) => all[lineOf(all, /Files\s+Queue/) + 1] ?? ''

  test('with nothing remembered it opens ~/Music: ../ first, folders, then playable files', async () => {
    const { lines } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · ~/Music'))
    const all = lines().join('\n')
    expect(all).toMatch(/\.\.\/[\s\S]*📁 Album\/[\s\S]*loose\.mp3/)
    expect(all).not.toContain('cover.jpg')
  })

  test('opens at the remembered folder', async () => {
    const { lines } = await showFiles({ [`${STATE}/tui-files.json`]: JSON.stringify({ folder: '/other' }) })
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · /other'))
    expect(lines().join('\n')).toContain('x.mp3')
  })

  test('a click on ../ goes up, and the folder is remembered', async () => {
    const saved: Record<string, string> = {}
    const { lines, click, where } = await showFiles(saved)
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    await click(where('../').x, where('../').y)
    await vi.waitFor(() => expect(heading(lines())).toMatch(/Files · ~(?!\/)/))
    expect(JSON.parse(saved[`${STATE}/tui-files.json`])).toEqual({ folder: '/h' })
  })

  test('U goes up a folder, as ../ does', async () => {
    const { lines, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    await press('U')
    await vi.waitFor(() => expect(heading(lines())).toMatch(/Files · ~(?!\/)/))
  })

  test("G opens Files at the playing song's folder, the cursor on it", async () => {
    const song = '/h/Music/Album/02 Two.flac'
    const playing: Partial<PlayerKeys> = {
      ...PLAYING,
      queue: { kind: 'playlist', items: ['One', 'Two'], paths: ['/h/Music/Album/01 One.flac', song], root: '/h/Music/Album', current: 1 },
    }
    const { lines, press, host, session } = await show(100, playing, '', '/h', { fs: fsOf(TREE) })
    await press('G')
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · ~/Music/Album'))
    await vi.waitFor(async () => {
      await press('a')
      expect(player.addToQueue).toHaveBeenLastCalledWith(host, session.config, [{ path: song }], 'end')
    })
  })

  test('G for a song its folder never lists leaves no jump waiting for later', async () => {
    const song = '/h/Music/Album/03 Three.flac'
    const playing: Partial<PlayerKeys> = {
      ...PLAYING,
      queue: { kind: 'playlist', items: ['Three'], paths: [song], root: '/h/Music/Album', current: 0 },
    }
    // the folder can't be read at first; read again later, it has the song
    let isReadable = false
    const fs = fsOf(TREE)
    const list = async (p: string) => {
      if (p !== '/h/Music/Album') return fs.list(p)
      if (!isReadable) throw new Error('EACCES')
      return [...TREE[p], { name: '03 Three.flac', kind: 'file' as const }]
    }
    const { lines, press, host, session } = await show(100, playing, '', '/h', { fs: { ...fs, list } })
    await press('G')
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · ~/Music/Album'))
    await vi.waitFor(() => expect(lines().join('\n')).toContain("Can't read /h/Music/Album"))
    isReadable = true
    await press('U')
    await vi.waitFor(() => expect(lines().join('\n')).toContain('📁 Album/'))
    // the cursor on Album, which opens: the song shows, and the cursor stays
    await press(...Array(1).fill('\x1b[B'), '\x1b[C')
    await vi.waitFor(() => expect(lines().join('\n')).toContain('03 Three.flac'))
    await press('a')
    expect(player.addToQueue).toHaveBeenLastCalledWith(host, session.config, [{ path: '/h/Music/Album' }], 'end')
  })

  test('G with nothing playing says so and stays', async () => {
    const { lines, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    await press('G')
    expect(lines().join('\n')).toContain('Nothing is playing.')
    expect(heading(lines())).toContain('Files · ~/Music')
  })

  test('a click on a folder opens it in place; Enter on it shuts it', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('📁 Album/'))
    await click(where('Album/').x, where('Album/').y)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('01 One.flac'))
    expect(lines().join('\n')).toContain('▾ 📁 Album/')
    await press(ENTER)
    expect(lines().join('\n')).not.toContain('01 One.flac')
  })

  test('o, a path, Enter: the tree moves there; a bad path says so and leaves it', async () => {
    const { lines, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    await press('o')
    expect(lines().join('\n')).toContain('go to a folder or URL')
    expect(heading(lines())).not.toContain('~/Music')
    await press('/other', ENTER)
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · /other'))
    await press('o', '/nope', ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('No such folder: /nope'))
    expect(heading(lines())).toContain('Files · /other')
  })

  test('a click on the heading edits the location there; a key types at the cursor', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    const t = where('~/Music')
    await click(t.x + 2, t.y)
    // the cursor on the M
    await press('X')
    expect(stripAnsi(heading(lines()))).toContain('Files · ~/XMusic')
    await press(ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('No such folder: /h/XMusic'))
    expect(heading(lines())).toContain('Files · ~/Music')
  })

  test('editing the heading: Ctrl-K, a new path, Enter goes there', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    const t = where('~/Music')
    await click(t.x, t.y)
    await press('\x0b', '/other', ENTER)
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · /other'))
  })

  test('Home and End move the cursor to the start and end of the location', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    const t = where('~/Music')
    await click(t.x + 2, t.y)
    await press(HOME, 'X', END, 'Y')
    expect(stripAnsi(heading(lines()))).toContain('Files · X~/MusicY')
  })

  test('arrows and Ctrl-W edit at the cursor; a click past the end puts it there', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    const t = where('~/Music')
    await click(t.x + 40, t.y)
    await press('/Album', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D')
    await press('\x17')
    expect(stripAnsi(heading(lines()))).toContain('Files · ~/Album')
  })

  test('Esc, or a click on a row, leaves the location as it was', async () => {
    const { lines, click, where, press } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    const t = where('~/Music')
    await click(t.x, t.y)
    await press('zz', ESC)
    expect(stripAnsi(heading(lines()))).toContain('Files · ~/Music')
    expect(lines().join('\n')).not.toContain('zz')
    await click(t.x, t.y)
    await press('zz')
    await click(where('Album/').x, where('Album/').y)
    expect(stripAnsi(heading(lines()))).toContain('Files · ~/Music')
    expect(lines().join('\n')).not.toContain('01 One.flac')
    // keys are commands again
    await press('U')
    await vi.waitFor(() => expect(heading(lines())).toMatch(/Files · ~(?!\/)/))
  })

  test('o from the Queue goes to Files', async () => {
    const { lines, press } = await show(100, PLAYING, '', '/h', { fs: fsOf(TREE) })
    await press('o')
    expect(heading(lines())).toMatch(/^\s*Files/)
  })

  test('a big folder lists before its tags arrive, and j moves the cursor', async () => {
    const big = { ...TREE, '/h/Music': [...Array(500).keys()].map(i => ({ name: `${String(i).padStart(3, '0')}.mp3`, kind: 'file' as const })) }
    // tags that never come
    const tags = tagReader(() => new Promise(() => {}))
    const { lines, press } = await showFiles({}, big, { tags })
    await vi.waitFor(() => expect(lines().join('\n')).toContain('000.mp3'))
    // ../ is row 0: two rows down is 001.mp3
    await press('j', 'j', 'a')
    expect(player.addToQueue).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ path: '/h/Music/001.mp3' }], 'end')
    await press('S')
    expect(lines().join('\n')).toContain('sort: modified')
  })
})

describe('files actions', () => {
  const sp = fsTree
  test('a double-click on a file adds it to the queue', async () => {
    const { lines, dblclick, where, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    await dblclick(where('loose.mp3').x, where('loose.mp3').y)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/loose.mp3' }], 'end')
    expect(player.pick).not.toHaveBeenCalled()
    expect(player.playSource).not.toHaveBeenCalled()
  })

  test('A with three rows picked adds them in one call, to play next; the pick clears and the status says how many', async () => {
    const { lines, press, host, session } = await sp({ '/h/Music': [...['a', 'b', 'c', 'd'].map(n => ({ name: `${n}.mp3`, kind: 'file' as const }))] })
    await vi.waitFor(() => expect(lines().join('\n')).toContain('a.mp3'))
    await press('j', '\x1b[1;2B', '\x1b[1;2B')
    expect(lines().join('\n')).toContain('3 picked')
    await press('A')
    expect(player.addToQueue).toHaveBeenCalledTimes(1)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/a.mp3' }, { path: '/h/Music/b.mp3' }, { path: '/h/Music/c.mp3' }], 'next')
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Added 3 songs to play next.'))
    expect(lines().join('\n')).not.toContain('picked')
  })

  test('a double-click on a folder adds it, and leaves it shut as it was', async () => {
    const { settled, lines, dblclick, where, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Album/'))
    await dblclick(where('Album/').x, where('Album/').y)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/Album' }], 'end')
    await settled()
    expect(lines().join('\n')).toContain('▸ 📁 Album/')
    expect(lines().join('\n')).not.toContain('01 One.flac')
  })

  test('Enter on a file adds it', async () => {
    const { lines, press, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    await press('j', 'j', ENTER)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/loose.mp3' }], 'end')
  })

  test('a right-click opens the menu at that row; Play next adds it next', async () => {
    const { lines, rightClick, click, where, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    await rightClick(where('loose.mp3').x, where('loose.mp3').y)
    expect(lines().join('\n')).toContain('Add to queue')
    await click(where('Play next').x + 1, where('Play next').y)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/loose.mp3' }], 'next')
    expect(lines().join('\n')).not.toContain('Play next')
  })

  test('m opens the menu at the cursor; ↓ Enter picks; Esc closes it without acting', async () => {
    const { lines, press, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    await press('j', 'j', 'm')
    expect(lines().join('\n')).toContain('Play next')
    await press(ESC)
    expect(lines().join('\n')).not.toContain('Play next')
    expect(player.addToQueue).not.toHaveBeenCalled()
    await press('m', '\x1b[B', ENTER)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/loose.mp3' }], 'next')
  })

  test('Space with no pick pauses; with a pick it picks', async () => {
    const { lines, press } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    await press(' ')
    expect(player.togglePause).toHaveBeenCalledTimes(1)
    await press('j', '\x1b[1;2B', ' ')
    expect(player.togglePause).toHaveBeenCalledTimes(1)
    expect(lines().join('\n')).toContain('1 picked')
  })

  test('the Queue menu removes a song', async () => {
    const { rightClick, click, where, host, session, lines } = await show(100)
    await rightClick(where('Song two').x, where('Song two').y)
    expect(lines().join('\n')).toContain('Move up')
    await click(where('Remove').x + 1, where('Remove').y)
    expect(player.removeFromQueue).toHaveBeenCalledWith(host, session.config, [1])
  })
})

describe('youtube in files', () => {
  const LIST = 'https://www.youtube.com/playlist?list=PL1'
  const MIX = { _type: 'playlist', title: 'Road Mix', entries: [
    { url: 'https://www.youtube.com/watch?v=1', title: 'Drive One', channel: 'Chan' },
    { url: 'https://www.youtube.com/watch?v=2', title: 'Drive Two', channel: 'Chan' },
  ] }
  const withRun = async (result: { exitCode: number; stdout: string; stderr: string }) => {
    const shown = await fsTree()
    ;(shown.host as unknown as { run: unknown }).run = vi.fn(async () => result)
    await vi.waitFor(() => expect(shown.lines().join('\n')).toContain('loose.mp3'))
    return shown
  }

  test('a playlist URL lists its videos under a folder of its title; adding the folder adds every video with its title', async () => {
    const { press, lines, host, session } = await withRun({ exitCode: 0, stdout: JSON.stringify(MIX), stderr: '' })
    await press('o', LIST, ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Drive Two'))
    expect(lines().join('\n')).toContain('▾ 📁 Road Mix/')
    expect(lines().join('\n')).toContain('Drive One · Chan')
    await press('j', 'a')
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [
      { path: 'https://www.youtube.com/watch?v=1', title: 'Drive One' },
      { path: 'https://www.youtube.com/watch?v=2', title: 'Drive Two' },
    ], 'end')
    expect(player.playSource).not.toHaveBeenCalled()
    expect(player.pick).not.toHaveBeenCalled()
  })

  test('one video added from the list keeps its title', async () => {
    const { press, host, session, lines } = await withRun({ exitCode: 0, stdout: JSON.stringify(MIX), stderr: '' })
    await press('o', LIST, ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Drive Two'))
    await press('j', 'j', 'j', 'A')
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: 'https://www.youtube.com/watch?v=2', title: 'Drive Two' }], 'next')
  })

  test("yt-dlp's error shows on the status line; the tree stays; nothing plays", async () => {
    const { press, lines } = await withRun({ exitCode: 1, stdout: '', stderr: 'ERROR: Private video' })
    await press('o', LIST, ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Private video'))
    expect(lines().join('\n')).toContain('Files · ~/Music')
    expect(lines().join('\n')).toContain('loose.mp3')
    expect(player.playSource).not.toHaveBeenCalled()
    expect(player.addToQueue).not.toHaveBeenCalled()
  })

  test('../ from the playlist goes back to the folder before it', async () => {
    const { press, lines, click, where } = await withRun({ exitCode: 0, stdout: JSON.stringify(MIX), stderr: '' })
    await press('o', LIST, ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Drive Two'))
    await click(where('../').x, where('../').y)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
  })
})

describe('pr review fixes', () => {
  test('a double-click on ../ goes up one folder, not two', async () => {
    const { lines, dblclick, where } = await show(100, { queue: { kind: 'none', items: [], paths: [], root: '', current: -1 } }, '', '/h', {
      fs: treeFs({ ...BASE_TREE, '/h/Music/Album': [{ name: '01 One.flac', kind: 'file' }] }, { [`${STATE}/tui-files.json`]: JSON.stringify({ folder: '/h/Music/Album' }) }),
    })
    await vi.waitFor(() => expect(lines().join('\n')).toContain('01 One.flac'))
    await dblclick(where('../').x, where('../').y)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    expect(lines().join('\n')).toContain('Files · ~/Music')
  })

  test('a YouTube playlist keeps its order, and a video in it twice shows twice', async () => {
    const shown = await fsTree()
    const mix = { _type: 'playlist', title: 'Mix', entries: [
      { url: 'https://y/z', title: 'Zed', channel: 'C' },
      { url: 'https://y/a', title: 'Alpha', channel: 'C' },
      { url: 'https://y/z', title: 'Zed', channel: 'C' },
    ] }
    ;(shown.host as unknown as { run: unknown }).run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(mix), stderr: '' }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => errors.mockRestore())
    await vi.waitFor(() => expect(shown.lines().join('\n')).toContain('loose.mp3'))
    await shown.press('o', 'https://www.youtube.com/playlist?list=x', ENTER)
    await vi.waitFor(() => expect(shown.lines().join('\n')).toContain('Alpha'))
    const all = shown.lines()
    const at = (t: RegExp) => all.findIndex(l => t.test(l))
    expect(at(/Zed/)).toBeLessThan(at(/Alpha/))
    expect(all.filter(l => /Zed/.test(l))).toHaveLength(2)
    expect(errors.mock.calls.some(c => String(c[0]).includes('same key'))).toBe(false)
  })

  test('the Queue stats its songs a few at a time, and a folder in the queue only once', async () => {
    let running = 0
    let most = 0
    const stats: string[] = []
    const fs = {
      stat: async (p: string) => {
        stats.push(p)
        running++
        most = Math.max(most, running)
        await new Promise(r => setTimeout(r, 1))
        running--
        return p.endsWith('/dir') ? { kind: 'dir' as const, mtimeMs: 1 } : { kind: 'file' as const, mtimeMs: 1 }
      },
    }
    const n = 200
    const big: Partial<PlayerKeys> = {
      ...PLAYING,
      queue: { kind: 'playlist', items: [...Array(n).keys()].map(i => `T${i}`), paths: [...[...Array(n - 1).keys()].map(i => `/m/${i}.mp3`), '/m/dir'], root: '/m', current: 0 },
    }
    const tags = tagReader(async () => ({ title: '', artist: '', albumArtist: '', album: '' }))
    const { settled, press } = await show(100, big, '', '', { fs, tags })
    await vi.waitFor(() => expect(new Set(stats).size).toBe(n), { timeout: 3000 })
    expect(most).toBeLessThanOrEqual(32)
    // more needs (a redraw that scrolls) don't stat the folder again
    await press('j', 'j', 'j')
    await settled()
    expect(stats.filter(p => p === '/m/dir')).toHaveLength(1)
  })
})

describe('queue editing', () => {
  const FIVE: Partial<PlayerKeys> = {
    ...PLAYING,
    queue: {
      kind: 'playlist',
      items: ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map(t => `${t} song`),
      paths: ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map(t => `/m/${t}.mp3`),
      root: '/m',
      current: 0,
    },
  }
  const SHIFT_DOWN = '\x1b[1;2B'
  const status = (all: string[]) => all[lineOf(all, /^─+$/) + 1] ?? ''

  test('C once only asks; C again clears the queue and stops', async () => {
    const { press, lines, host, session } = await show(100, FIVE)
    await press('C')
    expect(status(lines())).toContain('Press C again to clear all 5 songs.')
    expect(player.clearQueue).not.toHaveBeenCalled()
    await press('C')
    await vi.waitFor(() => expect(player.clearQueue).toHaveBeenCalledWith(host, session.config))
    await vi.waitFor(() => expect(status(lines())).toContain('Cleared the queue. l brings it back.'))
  })

  test("C in Files doesn't clear the queue", async () => {
    const { press } = await show(100, FIVE)
    await press('\x1b[Z', 'C', 'C')
    expect(player.clearQueue).not.toHaveBeenCalled()
  })

  test("the row's menu clears the queue at once", async () => {
    const { press, host, session } = await show(100, FIVE)
    await press('m', 'k', '\r')
    await vi.waitFor(() => expect(player.clearQueue).toHaveBeenCalledWith(host, session.config))
  })

  test('Shift-↓ twice picks 3 rows; Space then unpicks one, not pausing; Esc clears and Space pauses', async () => {
    const { press, lines } = await show(100, FIVE)
    await press(SHIFT_DOWN, SHIFT_DOWN)
    expect(status(lines())).toContain('3 picked · Space picks/unpicks · Esc clears')
    await press(' ')
    expect(status(lines())).toContain('2 picked')
    expect(player.togglePause).not.toHaveBeenCalled()
    await press(ESC)
    expect(status(lines())).not.toContain('picked')
    await press(' ')
    expect(player.togglePause).toHaveBeenCalled()
  })

  test('d moves the picked rows down and the pick follows them', async () => {
    const { press, host } = await show(100, FIVE)
    await press(SHIFT_DOWN, 'd')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, moveBy(5, [0, 1], 1).order)
    await press('d')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, moveBy(5, [1, 2], 1).order)
  })

  test('u and Alt-↑ move up; with no pick, the cursor\'s row', async () => {
    const { press, host } = await show(100, FIVE)
    await press('j', 'j', 'u')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, moveBy(5, [2], -1).order)
    await press('\x1b[1;3A')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, moveBy(5, [1], -1).order)
  })

  test('Delete removes the picked rows, and the pick clears', async () => {
    const { press, host, session, lines } = await show(100, FIVE)
    await press('j', SHIFT_DOWN, '\x1b[3~')
    expect(player.removeFromQueue).toHaveBeenCalledWith(host, session.config, [1, 2])
    expect(status(lines())).not.toContain('picked')
  })

  test('Ctrl-click picks one row; Alt-click and Shift-click pick a range', async () => {
    const { modClick, where, lines } = await show(100, FIVE)
    await modClick(where('Dd song').x, where('Dd song').y, 'ctrl')
    expect(status(lines())).toContain('1 picked')
    await modClick(where('Bb song').x, where('Bb song').y, 'alt')
    expect(status(lines())).toContain('3 picked')
    await modClick(where('Ee song').x, where('Ee song').y, 'shift')
    expect(status(lines())).toContain('2 picked')
  })

  test('a drag moves the row to where it is let go', async () => {
    const { drag, where, host } = await show(100, FIVE)
    await drag(where('Bb song'), where('Ee song'))
    expect(player.reorderQueue).toHaveBeenCalledWith(host, moveTo(5, [1], 4).order)
  })

  test('a drag of picked rows moves them all; the pick stays', async () => {
    const { drag, modClick, where, host, lines } = await show(100, FIVE)
    await modClick(where('Aa song').x, where('Aa song').y, 'ctrl')
    await modClick(where('Bb song').x, where('Bb song').y, 'ctrl')
    // from the other picked row: a press on Bb this soon would be a double-click
    await drag(where('Aa song'), where('Dd song'))
    expect(player.reorderQueue).toHaveBeenCalledWith(host, moveTo(5, [0, 1], 3).order)
    expect(status(lines())).toContain('2 picked')
  })

  test('S sorts the queue by title; R the other way', async () => {
    const { press, host, lines } = await show(100, { ...FIVE, queue: { ...FIVE.queue!, items: ['b', 'd', 'a', 'e', 'c'] } })
    await press('S')
    expect(player.sortQueue).toHaveBeenLastCalledWith(host, 'title', false, [2, 0, 4, 1, 3])
    expect(lines().join('\n')).toContain('sort: title')
    await press('R')
    // the queue is in title order now, so the other way round is its reverse
    expect(player.sortQueue).toHaveBeenLastCalledWith(host, 'title', true, [4, 3, 2, 1, 0])
  })

  test('a click on the ↓ after sort: sorts the other way round, and it turns to ↑; none while as queued', async () => {
    const { press, click, where, host, lines } = await show(100, { ...FIVE, queue: { ...FIVE.queue!, items: ['b', 'd', 'a', 'e', 'c'] } })
    expect(lines().join('\n')).toContain('sort: as queued ▾')
    expect(lines().join('\n')).not.toContain('▾ ↓')
    await press('S')
    const down = where('▾ ↓')
    await click(down.x + 2, down.y)
    expect(player.sortQueue).toHaveBeenLastCalledWith(host, 'title', true, [4, 3, 2, 1, 0])
    expect(lines().join('\n')).toContain('sort: title ▾ ↑')
    // the field part still goes to the next field
    const up = where('sort: title')
    await click(up.x, up.y)
    expect(player.sortQueue).toHaveBeenLastCalledWith(host, 'artist', false, expect.anything())
  })

  test('S past folder goes back to as queued: unsortQueue, and the tab row says so', async () => {
    const { press, host, lines } = await show(100, FIVE)
    await press('S', 'S', 'S', 'S', 'S')
    await vi.waitFor(() => expect(lines().join('\n')).toContain('sort: folder'))
    expect(player.unsortQueue).not.toHaveBeenCalled()
    await press('S')
    await vi.waitFor(() => expect(player.unsortQueue).toHaveBeenCalledWith(host))
    expect(lines().join('\n')).toContain('sort: as queued')
  })

  test('x keeps the playlist: still listed, the current row marked, Stopped.; Enter then picks a row', async () => {
    const { press, host, session, lines } = await show(100, FIVE)
    vi.mocked(player.stopPlaying).mockImplementationOnce(async h => {
      await h.vars.change('playing', () => '')
    })
    await press('x')
    await vi.waitFor(() => expect(status(lines())).toContain('Stopped.'))
    expect(lines().join('\n')).toMatch(/Aa song[\s\S]*Bb song[\s\S]*Cc song[\s\S]*Dd song[\s\S]*Ee song/)
    expect(lines().join('\n')).toContain('Enter plays the picked song')
    // the current row (Aa song, current: 0) keeps its mark while stopped
    expect(lines()[lineOf(lines(), /Aa song/)]).toMatch(/▶\s+1\. Aa song/)
    await press('j', ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, session.config, 1)
  })

  test('stopped with a saved place, now playing says l plays <song> at m:ss', async () => {
    const { lines } = await show(100, { ...FIVE, playing: '', resumeAt: { url: ALBUM, index: 2, seconds: 83, title: 'Cc song' } })
    expect(lines().join('\n')).toContain('l plays Cc song at 1:23')
  })

  test('a stopped queue can still be edited', async () => {
    const { press, host, session } = await show(100, { ...FIVE, playing: '' })
    await press('\x1b[3~')
    expect(player.removeFromQueue).toHaveBeenCalledWith(host, session.config, [0])
  })

  test('l with nothing played yet still asks resumeQueue, and shows its reply', async () => {
    vi.mocked(player.resumeQueue).mockResolvedValueOnce('Nothing has played yet, and there is no default stream.')
    const { press, host, session, lines } = await show(100, { ...FIVE, playing: '', lastUrl: '' })
    await press('l')
    expect(player.resumeQueue).toHaveBeenCalledWith(host, session.config, '')
    await vi.waitFor(() => expect(status(lines())).toContain('no default stream'))
  })

  test('S pressed again while a sort runs: only the last one asked runs after it', async () => {
    const { press, lines } = await show(100, { ...FIVE, queue: { ...FIVE.queue!, items: ['b', 'd', 'a', 'e', 'c'] } })
    let release = () => {}
    vi.mocked(player.sortQueue).mockImplementationOnce(() => new Promise<string>(res => (release = () => res(''))))
    await press('S', 'S', 'S', 'S')
    expect(player.sortQueue).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(player.sortQueue).toHaveBeenCalledTimes(2))
    await press('j')
    expect(player.sortQueue).toHaveBeenCalledTimes(2)
    expect(lines().join('\n')).toContain('sort: album ')
  })

  test('a song in the queue twice: only the picked copy moves', async () => {
    const twice = { ...FIVE, queue: { ...FIVE.queue!, items: ['a', 'b', 'a', 'c', 'd'], paths: ['/m/a', '/m/b', '/m/a', '/m/c', '/m/d'] } }
    const { press, host } = await show(100, twice)
    await press('j', 'j', 'u')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, [0, 2, 1, 3, 4])
  })
})

describe('review fixes', () => {
  const LONG5: Partial<PlayerKeys> = {
    ...PLAYING,
    queue: {
      kind: 'playlist',
      items: [...Array(12).keys()].map(i => `Track ${i + 1}`),
      paths: [...Array(12).keys()].map(i => `/m/${String(i + 1).padStart(2, '0')}.mp3`),
      root: '/m',
      current: 0,
    },
  }
  const status = (all: string[]) => all[lineOf(all, /^─+$/) + 1] ?? ''

  test('a menu item drawn over a row takes the click, not the row', async () => {
    const { rightClick, click, where, host, session, lines } = await show(100, LONG5)
    await rightClick(where('Track 2 ').x, where('Track 2 ').y)
    // the menu covers Track 3 and below; Remove sits over a row
    const remove = where('Remove')
    expect(lines()[remove.y]).not.toMatch(/Track/)
    await click(remove.x + 1, remove.y)
    expect(player.removeFromQueue).toHaveBeenCalledWith(host, session.config, [1])
    expect(player.pick).not.toHaveBeenCalled()
  })

  test('a click outside the open menu closes it and does nothing else', async () => {
    const { rightClick, click, where, press, lines } = await show(100, LONG5)
    await rightClick(where('Track 2 ').x, where('Track 2 ').y)
    await click(where(' Files ').x + 2, where(' Files ').y)
    expect(lines().join('\n')).not.toContain('Move up')
    // the click only closed the menu: still on the Queue, where Enter plays the row
    expect(lines()[lineOf(lines(), /Files\s+Queue/) + 1]).toMatch(/^\s*Queue/)
    await press(ENTER)
    expect(player.pick).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1)
    expect(player.addToQueue).not.toHaveBeenCalled()
  })

  test('chapters are not edited: Delete, u/d and S leave the queue alone; the menu only plays', async () => {
    const chapters: Partial<PlayerKeys> = { ...PLAYING, queue: { kind: 'chapters', items: ['One', 'Two', 'Three'], paths: [], root: '', current: 0 } }
    const { press, rightClick, where, lines } = await show(100, chapters)
    await press('\x1b[3~', 'd', 'u', 'S', 'R')
    expect(player.removeFromQueue).not.toHaveBeenCalled()
    expect(player.reorderQueue).not.toHaveBeenCalled()
    expect(player.sortQueue).not.toHaveBeenCalled()
    await rightClick(where('Two').x, where('Two').y)
    expect(lines().join('\n')).toContain('Play')
    expect(lines().join('\n')).not.toContain('Remove')
  })

  test('d then Delete before a redraw removes the song the cursor is on after the move', async () => {
    const { settled, ui, host, session } = await show(100, LONG5)
    ui.stdin.write('d')
    ui.stdin.write('\x1b[3~')
    await settled()
    await settled()
    // Track 1 moved to place 1; the Delete is for it, not for Track 2
    expect(player.removeFromQueue).toHaveBeenCalledWith(host, session.config, [1])
  })

  test('a pick lapses when the queue changes under it (a shuffle, another session)', async () => {
    const { settled, press, vars, lines, host, session } = await show(100, LONG5)
    await press('\x1b[1;2B', '\x1b[1;2B')
    expect(status(lines())).toContain('3 picked')
    await vars.change('queue', q => ({ ...q, items: [...q.items].reverse(), paths: [...q.paths].reverse() }))
    await settled()
    expect(status(lines())).not.toContain('picked')
    await press('\x1b[3~')
    expect(vi.mocked(player.removeFromQueue).mock.calls[0]![2]).toHaveLength(1)
    void host
    void session
  })

  test('in Files, a pick lapses when the rows above it change', async () => {
    const { press, lines } = await fsTree()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('loose.mp3'))
    // ../, Album/, loose.mp3: pick loose.mp3
    await press('j', 'j', '\x1b[1;2A', '\x1b[1;2B')
    expect(status(lines())).toContain('1 picked')
    // up to Album (the arrows keep the pick) and open it: the rows under it shift
    await press('k', '\x1b[C')
    await vi.waitFor(() => expect(lines().join('\n')).toContain('01 One.flac'))
    expect(status(lines())).not.toContain('picked')
    await press('a')
    expect(player.addToQueue).toHaveBeenCalledWith(expect.anything(), expect.anything(), [{ path: '/h/Music/Album' }], 'end')
  })
})

describe('mouse controls', () => {
  // The volume bar's edges on the line that shows it.
  const bar = (all: string[]) => {
    const y = lineOf(all, /vol \d+%/)
    const line = stripAnsi(all[y])
    const text = line.search(/vol \d+%/)
    return { y, left: columnOf(line, line.lastIndexOf('|', text)), right: columnOf(line, line.indexOf('|', text)) }
  }

  for (const columns of [100, 60, 40]) {
    test(`at ${columns} columns: previous, pause, next and stop; repeat and shuffle`, async () => {
      const { click, where, host } = await show(columns)
      for (const [text, called] of [
        [ICONS.prev, () => expect(player.step).toHaveBeenLastCalledWith(host, -1)],
        [ICONS.pause, () => expect(player.togglePause).toHaveBeenCalledTimes(1)],
        [ICONS.next, () => expect(player.step).toHaveBeenLastCalledWith(host, 1)],
        [ICONS.stop, () => expect(player.stopPlaying).toHaveBeenCalledTimes(1)],
        ['repeat all', () => expect(player.setRepeat).toHaveBeenCalledTimes(1)],
        ['shuffle off', () => expect(player.toggleShuffle).toHaveBeenCalledTimes(1)],
      ] as const) {
        const at = where(text)
        await click(at.x, at.y)
        called()
      }
    })

    test(`at ${columns} columns: a click on the volume bar sets the volume there`, async () => {
      const { click, lines } = await show(columns)
      const b = bar(lines())
      await click(b.left + 1, b.y)
      expect(player.setVolume).toHaveBeenLastCalledWith(expect.anything(), DEFAULT_CONFIG.volume, 0)
      await click(b.right - 1, b.y)
      expect(player.setVolume).toHaveBeenLastCalledWith(expect.anything(), DEFAULT_CONFIG.volume, 100)
    })
  }

  test('narrow: the controls and the volume bar keep to one line; repeat and shuffle the next', async () => {
    for (const columns of [60, 40]) {
      const { lines } = await show(columns)
      const at = lineOf(lines(), new RegExp(`${ICONS.prev} +${ICONS.pause} +${ICONS.next} +${ICONS.stop} +\\|.*vol 60%.*\\|`, 'u'))
      expect(at, `${columns} columns`).toBeGreaterThan(0)
      expect(lines()[at + 1]).toMatch(/repeat all\s+shuffle off/)
      cleanup()
    }
  })

  test('the wheel over the volume bar does nothing', async () => {
    const { wheel, lines } = await show(100)
    const b = bar(lines())
    await wheel(b.left + 3, b.y, 'up')
    expect(player.setVolume).not.toHaveBeenCalled()
  })

  test('paused, the middle control shows play', async () => {
    const { lines } = await show(100, { ...PLAYING, isPaused: true })
    expect(lines().some(l => l.includes(`${ICONS.prev}  ${ICONS.play}  ${ICONS.next}  ${ICONS.stop}`))).toBe(true)
  })

  test('stopped, the middle control shows play: it plays the queue', async () => {
    const { lines } = await show(100, { ...PLAYING, playing: '', isPaused: false, elapsed: -1 })
    expect(lines().some(l => l.includes(`${ICONS.prev}  ${ICONS.play}  ${ICONS.next}  ${ICONS.stop}`))).toBe(true)
  })
})

describe('mouse seek', () => {
  const near = (v: number) => expect.closeTo(v, 5)

  test('a click on the braille waveform seeks to that column; on the times, nothing', async () => {
    const { media, pending } = fakeMedia()
    const { lines, click, where, host } = await show(100, PLAYING, '', '', { media })
    await vi.waitFor(() => expect(pending.has(SONG3)).toBe(true))
    pending.get(SONG3)!.resolve(flat(128))
    await vi.waitFor(() => expect(lines().filter(l => BRAILLE.test(l))).toHaveLength(4))
    const times = where('2:41')
    await click(times.x + 16, times.y + 2)
    expect(player.seek).toHaveBeenCalledWith(host, near((16.5 / 33) * 245))
    await click(times.x + 16, times.y)
    expect(player.seek).toHaveBeenCalledTimes(1)
  })

  test('a click on the pixel waveform seeks the same way', async () => {
    const screen = fakeScreen()
    const { lines, click, where, host } = await show(100, PLAYING, '', '', { media: pictureMedia(), graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(lines().some(l => l.includes(sgr(201)))).toBe(true))
    const times = where('2:41')
    await click(times.x, times.y + 4)
    expect(player.seek).toHaveBeenCalledWith(host, near((0.5 / 33) * 245))
  })

  test('narrow: a click on the bar seeks there; on its times, nothing', async () => {
    const { click, where, host } = await show(60)
    const at = where('2:41 ')
    // the bar starts after "2:41 "; 60 - 4 - 4 - 2 = 50 cells
    await click(at.x + 5, at.y)
    expect(player.seek).toHaveBeenCalledWith(host, near((0.5 / 50) * 245))
    await click(at.x + 1, at.y)
    await click(at.x + 57, at.y)
    expect(player.seek).toHaveBeenCalledTimes(1)
  })

  test('b and f jump 10 seconds back and ahead from where mpv is', async () => {
    const { press, host } = await show(100)
    await press('f')
    expect(player.seek).toHaveBeenLastCalledWith(host, 10, true)
    await press('b')
    expect(player.seek).toHaveBeenLastCalledWith(host, -10, true)
  })

  test('a live stream has no bar, and nothing seeks', async () => {
    const { click, where } = await show(60, { ...PLAYING, elapsed: -1 })
    const at = where('♪ live')
    await click(at.x, at.y)
    await click(at.x + 10, at.y)
    expect(player.seek).not.toHaveBeenCalled()
  })
})

describe('the key list', () => {
  test('? shows every key and what the mouse does in place of the list and pane; Esc, ? or q closes it', async () => {
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 56 })
    for (const close of [ESC, '?', 'q']) {
      await press('?')
      const all = lines().join('\n')
      // the list and pane give way to it
      expect(all).not.toContain('2. Song two')
      for (const text of ['Keys', 'stop (the queue stays)', 'resume the queue', 'filter the list', 'quit; the music keeps playing', 'Mouse', 'double-click', 'seek there', 'Shift-drag']) {
        expect(all).toContain(text)
      }
      await press(close)
      expect(lines().join('\n')).toContain('2. Song two')
    }
    // q closed the list; it did not quit
    expect(player.stopPlaying).not.toHaveBeenCalled()
  })

  test('every description starts in the same column, the icons row too', async () => {
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 56 })
    await press('?')
    const starts = ['move', 'pause or resume', 'scroll the list', 'previous, pause or play, next, stop', 'seek there'].map(text => {
      const line = lines().find(l => l.includes(text)) ?? ''
      return columnOf(line, line.indexOf(text))
    })
    expect(new Set(starts).size).toBe(1)
  })

  test("? lists the keys of the tab showing, and both tabs' shared keys", async () => {
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 56 })
    await press('?')
    let all = lines().join('\n')
    for (const text of ['Queue tab', 'move the picked songs', 'remove the picked songs', 'switch tabs', 'pick rows', 'Ctrl-click']) expect(all).toContain(text)
    expect(all).not.toContain('Files tab')
    await press(ESC, '\x1b[Z', '?')
    all = lines().join('\n')
    for (const text of ['Files tab', 'add to queue', 'play next', 'go up', 'switch tabs']) expect(all).toContain(text)
    expect(all).not.toContain('remove the picked songs')
  })

  test('the hints follow the tab', async () => {
    const { press, lines } = await show(100)
    expect(lines().join('\n')).toMatch(/u\/d move.*Del remove/)
    await press('\x1b[Z')
    expect(lines().join('\n')).toMatch(/a add.*A play next/)
  })

  test('keys that act in the list do nothing while it shows', async () => {
    const { press } = await show(100)
    await press('?', 'x', ' ', 'n')
    expect(player.stopPlaying).not.toHaveBeenCalled()
    expect(player.togglePause).not.toHaveBeenCalled()
    expect(player.step).not.toHaveBeenCalled()
  })

  test('on a short screen it scrolls with j and k', async () => {
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 16 })
    await press('?')
    expect(lines().join('\n')).not.toContain('Shift-drag')
    await press(...Array(40).fill('j'))
    expect(lines().join('\n')).toContain('Shift-drag')
    expect(lines().join('\n')).not.toContain('Keys')
    await press(...Array(40).fill('k'))
    expect(lines().join('\n')).toContain('Keys')
  })
})

describe('audit fixes', () => {
  // OSC 52 sets the clipboard: a tag, a title or a file name could carry it.
  const CLIPBOARD = '\x1b]52;c;cHduZWQ=\x07'

  test('titles, tags and messages reach the screen without their escape sequences', async () => {
    vi.mocked(player.mpv).mockImplementation(async (_h, command) =>
      command[1] === 'metadata' ? { data: { ARTIST: `Band${CLIPBOARD}` } } : command[1] === 'duration' ? { data: 245 } : undefined,
    )
    const state: Partial<PlayerKeys> = {
      ...PLAYING,
      playing: `Song${CLIPBOARD}`,
      queue: { ...(PLAYING.queue as PlayerKeys['queue']), items: [`Intro${CLIPBOARD}`, 'Song two', 'Song three', 'Other'] },
    }
    const { lines, say } = await show(100, state)
    say(`yt-dlp: ERROR${CLIPBOARD}`)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Band]52;c;'))
    await vi.waitFor(() => expect(lines().join('\n')).toContain('yt-dlp: ERROR]52;c;'))
    const all = lines().join('\n')
    expect(all).toContain('Song]52;c;cHduZWQ=')
    expect(all).toContain('Intro]52;c;')
    expect(all).not.toContain('\x1b]')
    expect(all).not.toContain('\x07')
  })

  test('Backspace in the filter takes off a whole emoji', async () => {
    const { press, lines } = await show(100)
    await press('/', 'a', '🎵', '\x7f')
    expect(lines().join('\n')).toContain('/ filter: a_')
  })

  test('the hints say that o goes to a location, not that it plays', async () => {
    const { press, lines } = await show(100)
    await press('o')
    const all = lines().join('\n')
    expect(all).toContain('Enter goes there')
    expect(all).not.toContain('Enter plays it')
  })
})

describe('the Playlists tab', () => {
  const status = (all: string[]) => all[lineOf(all, /^─+$/) + 1] ?? ''
  const DEL = '\x1b[3~'
  const HISTORY = nodePath.join(STATE, 'history.jsonl')
  const REMEMBER = nodePath.join(STATE, 'tui-playlists.json')
  afterEach(() => {
    nodeFs.rmSync(HISTORY, { force: true })
    nodeFs.rmSync(REMEMBER, { force: true })
  })
  const m3u = (...songs: [string, string][]) => `#EXTM3U\n${songs.map(([p, t]) => `#EXTINF:-1,${t}\n${p}`).join('\n')}\n`
  const FAV = '★ Favourites'

  // A data folder holding `files` (name → .m3u text), and a poll timer turned by hand.
  function library(files: Record<string, string> = {}) {
    const data = nodeFs.mkdtempSync(nodePath.join(TMP, 'data-'))
    const dir = nodePath.join(data, 'stream-radio', 'playlists')
    nodeFs.mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) nodeFs.writeFileSync(nodePath.join(dir, `${name}.m3u`), text)
    const timers = new Set<{ ms: number; fn: () => void }>()
    const every: Host['every'] = (ms, fn) => {
      const t = { ms, fn }
      timers.add(t)
      return { cancel: () => void timers.delete(t) }
    }
    const file = (name: string) => nodePath.join(dir, `${name}.m3u`)
    return { data, dir, file, every, timers, tick: () => [...timers].forEach(t => t.fn()) }
  }
  const FILES = {
    [FAV]: m3u(['/m/a.mp3', 'Fav A'], ['/m/b.mp3', 'Fav B']),
    'Road trip': m3u(['/m/r1.mp3', 'Road one'], ['/m/r2.mp3', 'Road two'], ['/m/r3.mp3', 'Road three']),
    'Late night': m3u(['/m/l1.mp3', 'Late one']),
  }
  async function open(files: Record<string, string> = FILES) {
    const lib = library(files)
    const ui = await show(100, PLAYING, '', '', { library: lib })
    await ui.press('\t')
    await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
    return { ...ui, lib }
  }
  const rowsText = (all: string[]) => all.join('\n')

  test('the top level: Favourites with its count, Recently played, the lists, + New playlist…', async () => {
    const { lines } = await open()
    const all = lines()
    const order = ['★ Favourites', 'Recently played', 'Late night', 'Road trip', '+ New playlist…'].map(t => lineOf(all, new RegExp(t.replace(/[+…]/g, '.'))))
    expect(order.every((y, i) => y > 0 && (i === 0 || y > order[i - 1]))).toBe(true)
    expect(all[order[0]]).toMatch(/★ Favourites\s+· 2/)
    expect(all[order[3]]).toMatch(/Road trip\s+· 3/)
    expect(all[order[2]]).toMatch(/Late night\s+· 1/)
  })

  test('Enter opens a list, ../ first and its name as the heading; ←, U and ../ go back', async () => {
    const { press, lines } = await open()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    expect(lines().some(l => /^\s*Road trip/.test(l))).toBe(true)
    expect(lines().some(l => l.includes('../'))).toBe(true)
    await press('\x1b[D')
    await vi.waitFor(() => expect(rowsText(lines())).toContain('+ New playlist…'))
    await press(ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    await press('U')
    await vi.waitFor(() => expect(rowsText(lines())).toContain('+ New playlist…'))
    await press(ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    await press(HOME, ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('+ New playlist…'))
  })

  test('Enter on a song plays the list from it', async () => {
    const { press, lines, host, session, lib } = await open()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    // the cursor starts on the first song
    await press('j', ENTER)
    const entries = [{ path: '/m/r1.mp3', title: 'Road one' }, { path: '/m/r2.mp3', title: 'Road two' }, { path: '/m/r3.mp3', title: 'Road three' }]
    await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(host, session.config, entries, lib.file('Road trip'), 1))
  })

  test("the list's menu plays it from the start; Enter doesn't play a list", async () => {
    const { press, host, session, lib } = await open()
    await press('j', 'j', 'j', 'm')
    await press(ENTER)
    await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(host, session.config, expect.any(Array), lib.file('Road trip'), 0))
  })

  test('a and A add the picked songs to the queue; on a list, the whole list', async () => {
    const { press, lines, host, session } = await open()
    await press('a')
    await vi.waitFor(() => expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/m/a.mp3', title: 'Fav A' }, { path: '/m/b.mp3', title: 'Fav B' }], 'end'))
    vi.mocked(player.addToQueue).mockClear()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    await press('\x1b[1;2B', 'A')
    await vi.waitFor(() => expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/m/r1.mp3', title: 'Road one' }, { path: '/m/r2.mp3', title: 'Road two' }], 'next'))
  })

  test('Delete takes the picked songs out of the list file, not off the disk', async () => {
    const { press, lines, lib } = await open()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    await press('j', DEL)
    await vi.waitFor(() => expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).not.toContain('r2.mp3'))
    expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).toContain('r1.mp3')
    await vi.waitFor(() => expect(rowsText(lines())).not.toContain('Road two'))
  })

  describe('sort and move inside a playlist', () => {
    const ALT_UP = '\x1b[1;3A'
    const ALT_DOWN = '\x1b[1;3B'
    const order = (file: string) => [...nodeFs.readFileSync(file, 'utf8').matchAll(/^\/m\/(\w+)\.mp3$/gm)].map(m => m[1])
    const status = (all: string[]) => all[lineOf(all, /^─+$/) + 1] ?? ''
    // opens Road trip (r1, r2, r3), the cursor on its first song
    async function road(files: Record<string, string> = FILES) {
      const ui = await open(files)
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      return ui
    }
    const shown = (all: string[]) => ['Road one', 'Road two', 'Road three'].map(t => [t, lineOf(all, new RegExp(t))] as const).sort((a, b) => a[1] - b[1]).map(([t]) => t)

    test('u, d and Alt-arrows rewrite the file order; the cursor and pick follow', async () => {
      const { press, lines, lib } = await road()
      await press('j', 'u')
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r2', 'r1', 'r3']))
      expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).toContain('#EXTINF:-1,Road two\n/m/r2.mp3')
      await vi.waitFor(() => expect(shown(lines())).toEqual(['Road two', 'Road one', 'Road three']))
      await press('d', 'd')
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r1', 'r3', 'r2']))
      await press(ALT_UP)
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r1', 'r2', 'r3']))
      await press(ALT_DOWN)
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r1', 'r3', 'r2']))
    })

    test('the picked songs move together; a block at the end stays', async () => {
      const { press, lines, lib } = await road()
      await press('j', ' ')
      await press('\x1b[1;2B')
      await press('d')
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r1', 'r2', 'r3']))
      await press('u')
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r2', 'r3', 'r1']))
      expect(status(lines())).toContain('2 picked')
    })

    test('Favourites moves too', async () => {
      const { press, lines, lib } = await open()
      await press(ENTER)
      await vi.waitFor(() => expect(rowsText(lines())).toContain('Fav B'))
      await press('j', 'u')
      await vi.waitFor(() => expect(order(lib.file(FAV))).toEqual(['b', 'a']))
    })

    test('a move applies by song, to the file as it is under the lock, not to stale places', async () => {
      const { press, lines, lib } = await road()
      // another program put a song first after the list was read
      nodeFs.writeFileSync(lib.file('Road trip'), m3u(['/m/x.mp3', 'Extra'], ['/m/r1.mp3', 'Road one'], ['/m/r2.mp3', 'Road two'], ['/m/r3.mp3', 'Road three']))
      await press('j', 'u')
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['x', 'r2', 'r1', 'r3']))
      expect(rowsText(lines())).toContain('Road two')
    })

    test('S cycles the fields then custom order without touching the file; R reverses', async () => {
      const { press, lines, lib } = await road()
      const was = nodeFs.readFileSync(lib.file('Road trip'), 'utf8')
      expect(rowsText(lines())).toContain('sort: custom order')
      await press('S')
      expect(rowsText(lines())).toContain('sort: title')
      expect(shown(lines())).toEqual(['Road one', 'Road three', 'Road two'])
      await press('R')
      expect(shown(lines())).toEqual(['Road two', 'Road three', 'Road one'])
      expect(rowsText(lines())).toMatch(/sort: title ▾ ↑/)
      for (const label of ['artist', 'album artist', 'album', 'folder']) {
        await press('S')
        expect(rowsText(lines())).toContain(`sort: ${label}`)
      }
      await press('S')
      expect(rowsText(lines())).toContain('sort: custom order')
      expect(shown(lines())).toEqual(['Road one', 'Road two', 'Road three'])
      expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).toBe(was)
    })

    test('a sort by a tag puts songs without it last', async () => {
      const dir = nodeFs.mkdtempSync(nodePath.join(TMP, 'songs-'))
      const song = (n: string) => nodePath.join(dir, `${n}.mp3`)
      for (const n of ['a', 'b', 'c']) nodeFs.writeFileSync(song(n), '')
      const artists: Record<string, string> = { [song('a')]: 'Zed', [song('b')]: '', [song('c')]: 'Amy' }
      const tags = tagReader(async p => ({ title: '', artist: artists[p] ?? '', albumArtist: '', album: '' }))
      const lib = library({ Mix: m3u([song('a'), 'Song A'], [song('b'), 'Song B'], [song('c'), 'Song C']) })
      const ui = await show(100, PLAYING, '', '', { library: lib, tags })
      await ui.press('\t')
      await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
      await ui.press('j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Song C'))
      await ui.press('S', 'S')
      await vi.waitFor(() => {
        const all = ui.lines()
        expect(rowsText(all)).toContain('sort: artist')
        expect(lineOf(all, /Song C/)).toBeLessThan(lineOf(all, /Song A/))
        expect(lineOf(all, /Song A/)).toBeLessThan(lineOf(all, /Song B/))
      })
    })

    test('moving while sorted is refused, says so, and changes nothing', async () => {
      const { press, lines, lib } = await road()
      const was = nodeFs.readFileSync(lib.file('Road trip'), 'utf8')
      await press('S', 'S')
      await press('u', 'd', ALT_UP)
      expect(status(lines())).toContain('sorted by artist — S to custom order to move')
      expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).toBe(was)
    })

    const saved = () => JSON.parse(nodeFs.readFileSync(REMEMBER, 'utf8')).sorts
    test('the sort is remembered per playlist and survives a restart', async () => {
      const first = await road()
      await first.press('S', 'R')
      await vi.waitFor(() => expect(saved()).toEqual({ 'Road trip': { field: 'title', isReversed: true } }))
      cleanup()
      // a new run, on the same state folder and lists
      const ui = await show(100, PLAYING, '', '', { library: { data: first.lib.data, every: first.lib.every } })
      await ui.press('\t')
      await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      expect(rowsText(ui.lines())).toContain('sort: title')
      expect(shown(ui.lines())).toEqual(['Road two', 'Road three', 'Road one'])
    })

    test('a rename carries the sort over', async () => {
      const { press, lines, lib } = await road()
      await press('S', 'R')
      await vi.waitFor(() => expect(saved()).toEqual({ 'Road trip': { field: 'title', isReversed: true } }))
      await press('\x1b[D', 'm', 'j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/to: Road trip/))
      await press('\x7f', '\x7f', '\x7f', '\x7f', 'X', ENTER)
      await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Road X'))).toBe(true))
      await vi.waitFor(() => expect(saved()).toEqual({ 'Road X': { field: 'title', isReversed: true } }))
    })

    test('a delete drops the sort', async () => {
      const { press, lib } = await road()
      await press('S')
      await vi.waitFor(() => expect(saved()).toEqual({ 'Road trip': { field: 'title', isReversed: false } }))
      await press('\x1b[D', 'm', 'j', 'j', 'j', 'j', ENTER, ENTER)
      await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Road trip'))).toBe(false))
      await vi.waitFor(() => expect(saved()).toEqual({}))
    })

    test('a playlist named like an Object property keeps its own sort', async () => {
      const lib = library({ constructor: m3u(['/m/r1.mp3', 'Road one'], ['/m/r2.mp3', 'Road two']), toString: m3u(['/m/p1.mp3', 'P one']) })
      const ui = await show(100, PLAYING, '', '', { library: lib })
      await ui.press('\t')
      await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
      // Favourites, Recently played, constructor, toString
      await ui.press('j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      expect(rowsText(ui.lines())).toContain('sort: custom order')
      await ui.press('S')
      expect(rowsText(ui.lines())).toContain('sort: title')
      expect(JSON.parse(nodeFs.readFileSync(REMEMBER, 'utf8')).sorts).toEqual({ constructor: { field: 'title', isReversed: false } })
      await ui.press('\x1b[D', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('P one'))
      expect(rowsText(ui.lines())).toContain('sort: custom order')
    })

    test('a move that changes nothing leaves the file alone', async () => {
      const { press, lib } = await road()
      const mtime = () => nodeFs.statSync(lib.file('Road trip')).mtimeMs
      const old = new Date(Date.now() - 60_000)
      nodeFs.utimesSync(lib.file('Road trip'), old, old)
      const was = mtime()
      // the top song up; the last song down
      await press('u', 'j', 'j', 'd')
      await new Promise(r => setTimeout(r, 100))
      expect(mtime()).toBe(was)
      expect(order(lib.file('Road trip'))).toEqual(['r1', 'r2', 'r3'])
    })

    test("the list menu's Play on a tag-sorted list reads the tags first", async () => {
      const dir = nodeFs.mkdtempSync(nodePath.join(TMP, 'songs-'))
      const song = (n: string) => nodePath.join(dir, `${n}.mp3`)
      for (const n of ['a', 'b', 'c']) nodeFs.writeFileSync(song(n), '')
      const artists: Record<string, string> = { [song('a')]: 'Zed', [song('b')]: 'Mid', [song('c')]: 'Amy' }
      const tags = tagReader(async p => ({ title: '', artist: artists[p] ?? '', albumArtist: '', album: '' }))
      const lib = library({ Mix: m3u([song('a'), 'Song A'], [song('b'), 'Song B'], [song('c'), 'Song C']) })
      nodeFs.writeFileSync(REMEMBER, JSON.stringify({ sorts: { Mix: { field: 'artist', isReversed: false } } }))
      const { press, host, session } = await show(100, PLAYING, '', '', { library: lib, tags })
      await press('\t')
      await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Mix'))).toBe(true))
      // the list was never opened: no tags have been asked for
      await press('j', 'j', 'm', ENTER)
      const entries = [{ path: song('c'), title: 'Song C' }, { path: song('b'), title: 'Song B' }, { path: song('a'), title: 'Song A' }]
      await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(host, session.config, entries, lib.file('Mix'), 0))
    })

    test('Enter on a song of a sorted list plays in the shown order from that song', async () => {
      const { press, host, session, lib } = await road()
      await press('S', 'R')
      // shown: two, three, one; the cursor is on the first row
      await press('j', ENTER)
      const entries = [{ path: '/m/r2.mp3', title: 'Road two' }, { path: '/m/r3.mp3', title: 'Road three' }, { path: '/m/r1.mp3', title: 'Road one' }]
      await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(host, session.config, entries, lib.file('Road trip'), 1))
    })

    test('a drag moves the song to where it is let go, in the file', async () => {
      const { drag, where, lines, lib } = await road()
      await drag(where('Road one'), where('Road three'))
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r2', 'r1', 'r3']))
      await vi.waitFor(() => expect(shown(lines())).toEqual(['Road two', 'Road one', 'Road three']))
    })

    test('a drag onto the second copy of a song listed twice drops above that copy', async () => {
      const twice = m3u(['/m/r1.mp3', 'Road one'], ['/m/r2.mp3', 'Road two'], ['/m/r1.mp3', 'Road one again'], ['/m/r3.mp3', 'Road three'])
      const { drag, where, lib } = await road({ ...FILES, 'Road trip': twice })
      await drag(where('Road three'), where('Road one again'))
      await vi.waitFor(() => expect(order(lib.file('Road trip'))).toEqual(['r1', 'r2', 'r3', 'r1']))
    })

    test('a drag while sorted changes nothing and says why', async () => {
      const { press, drag, where, lines, lib } = await road()
      const was = nodeFs.readFileSync(lib.file('Road trip'), 'utf8')
      await press('S')
      await drag(where('Road one'), where('Road two'))
      expect(nodeFs.readFileSync(lib.file('Road trip'), 'utf8')).toBe(was)
      expect(status(lines())).toContain('sorted by title — S to custom order to move')
    })

    test('Recently played ignores S, R, u and d', async () => {
      const now = Math.floor(Date.now() / 1000)
      const text = [{ at: now - 3600, path: '/m/old.mp3', title: 'Old song' }, { at: now - 180, path: '/m/new.mp3', title: 'New song' }].map(j => JSON.stringify(j)).join('\n') + '\n'
      nodeFs.writeFileSync(HISTORY, text)
      const { press, lines } = await open()
      await press('j', ENTER)
      await vi.waitFor(() => expect(rowsText(lines())).toContain('New song'))
      await press('S', 'R', 'j', 'u', 'd', ALT_UP)
      expect(rowsText(lines())).not.toContain('sort:')
      expect(nodeFs.readFileSync(HISTORY, 'utf8')).toBe(text)
      const all = lines()
      expect(lineOf(all, /New song/)).toBeLessThan(lineOf(all, /Old song/))
    })
  })

  describe('song rows like the Queue', () => {
    const songsIn = () => {
      const dir = nodeFs.mkdtempSync(nodePath.join(TMP, 'songs-'))
      const song = (n: string) => nodePath.join(dir, `${n}.mp3`)
      for (const n of ['a', 'b']) nodeFs.writeFileSync(song(n), '')
      return { song }
    }
    async function mix(tags: ReturnType<typeof tagReader>, extra: (song: (n: string) => string) => Record<string, string> = () => ({})) {
      const { song } = songsIn()
      const lib = library({ Mix: m3u([song('a'), 'Listed A'], [song('b'), 'Listed B'], ['https://www.youtube.com/watch?v=abc', 'Tube title']), ...extra(song) })
      const ui = await show(100, PLAYING, '', '', { library: lib, tags })
      await ui.press('\t')
      await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
      await ui.press('j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Tube title'))
      return { ...ui, song }
    }
    const tagged = (m: Record<string, { title: string; artist: string }>) => tagReader(async p => ({ title: m[nodePath.basename(p)]?.title ?? '', artist: m[nodePath.basename(p)]?.artist ?? '', albumArtist: '', album: '' }))

    test('a tagged song shows its tag title and artist, an untagged one its list title and folder, a YouTube one its site', async () => {
      const { lines, song } = await mix(tagged({ 'a.mp3': { title: 'Tag A', artist: 'Tag Band' } }))
      const dir = nodePath.dirname(song('a'))
      await vi.waitFor(() => expect(lines()[lineOf(lines(), /Tag A/)]).toMatch(new RegExp(`Tag A · Tag Band · ${dir}`)))
      expect(rowsText(lines())).not.toContain('Listed A')
      expect(lines()[lineOf(lines(), /Listed B/)]).toContain(`Listed B · ${dir}`)
      expect(lines()[lineOf(lines(), /Tube title/)]).toContain('Tube title · youtube.com')
    })

    test('tags that arrive later redraw the row', async () => {
      let release: () => void = () => undefined
      const gate = new Promise<void>(r => (release = r))
      const tags = tagReader(async () => {
        await gate
        return { title: 'Late Title', artist: 'Late Artist', albumArtist: '', album: '' }
      })
      const { lines } = await mix(tags)
      expect(rowsText(lines())).toContain('Listed A')
      release()
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/Late Title · Late Artist/))
    })

    test('the filter matches the artist', async () => {
      const { press, lines } = await mix(tagged({ 'a.mp3': { title: 'Tag A', artist: 'Zebra Band' } }))
      await vi.waitFor(() => expect(rowsText(lines())).toContain('Zebra Band'))
      await press('/', 'z', 'e', 'b')
      await vi.waitFor(() => {
        expect(rowsText(lines())).toContain('Tag A')
        expect(rowsText(lines())).not.toContain('Listed B')
      })
    })

    test('a Recently played row shows its artist and when it played', async () => {
      const { song } = songsIn()
      const now = Math.floor(Date.now() / 1000)
      nodeFs.writeFileSync(HISTORY, JSON.stringify({ at: now - 180, path: song('a'), title: 'Played A' }) + '\n')
      const lib = library({})
      const ui = await show(200, PLAYING, '', '', { library: lib, tags: tagged({ 'a.mp3': { title: '', artist: 'Hist Band' } }) })
      await ui.press('\t')
      await vi.waitFor(() => expect(ui.lines().join('\n')).toContain('+ New playlist…'))
      await ui.press('j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toMatch(/Played A · Hist Band · .* · 3 min ago/))
    })
  })

  test("Recently played: when each played, dimmed after the title; Delete doesn't edit it", async () => {
    const now = Math.floor(Date.now() / 1000)
    nodeFs.writeFileSync(HISTORY, [{ at: now - 3600 * 30, path: '/m/old.mp3', title: 'Old song' }, { at: now - 180, path: '/m/new.mp3', title: 'New song' }].map(j => JSON.stringify(j)).join('\n') + '\n')
    const was = nodeFs.readFileSync(HISTORY, 'utf8')
    const { press, lines } = await open()
    await press('j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('New song'))
    const all = lines()
    expect(lineOf(all, /New song/)).toBeLessThan(lineOf(all, /Old song/))
    expect(all[lineOf(all, /New song/)]).toMatch(/New song · \/m · 3 min ago/)
    await press(DEL)
    await vi.waitFor(() => expect(status(lines())).toContain("Recently played can't be edited; Clear it from its menu."))
    expect(nodeFs.readFileSync(HISTORY, 'utf8')).toBe(was)
  })

  test('/ filters the open list; Enter plays the list from the first match', async () => {
    const { press, lines, host, session, lib } = await open()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    await press('/', 't', 'h', 'r')
    await vi.waitFor(() => expect(rowsText(lines())).not.toContain('Road two'))
    expect(rowsText(lines())).toContain('Road three')
    await press(ENTER)
    await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(host, session.config, expect.any(Array), lib.file('Road trip'), 2))
  })

  test('+ New playlist… asks a name and makes the list; a bad name says why', async () => {
    const { press, lines, lib } = await open()
    await press(END, ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toMatch(/name/i))
    await press(...'Gym'.split(''), ENTER)
    await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Gym'))).toBe(true))
    await vi.waitFor(() => expect(rowsText(lines())).toMatch(/Gym\s+· 0/))
    await press(END, ENTER, 'f', 'a', 'v', ENTER)
    await vi.waitFor(() => expect(status(lines())).toContain('"fav" is a reserved name.'))
    expect(nodeFs.existsSync(lib.file('fav'))).toBe(false)
  })

  test("Rename, from a list's menu, edits its name in the prompt", async () => {
    const { press, lines, lib } = await open()
    await press('j', 'j', 'j', 'm')
    const all = rowsText(lines())
    for (const item of ['Play', 'Add to queue', 'Play next', 'Rename', 'Delete playlist']) expect(all).toContain(item)
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toMatch(/to: Road trip/))
    await press('\x7f', '\x7f', '\x7f', '\x7f', 'X', ENTER)
    await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Road X'))).toBe(true))
    expect(nodeFs.existsSync(lib.file('Road trip'))).toBe(false)
  })

  test("Favourites' menu has no Rename or Delete; Recently played's has Clear", async () => {
    const { press, lines } = await open()
    await press('m')
    expect(rowsText(lines())).toContain('Add to queue')
    expect(rowsText(lines())).not.toContain('Rename')
    expect(rowsText(lines())).not.toContain('Delete playlist')
    await press(ESC, 'j', 'm')
    expect(rowsText(lines())).toContain('Clear')
    expect(rowsText(lines())).not.toContain('Rename')
  })

  test('Delete playlist asks first', async () => {
    const { press, lines, lib } = await open()
    await press('j', 'j', 'j', 'm', 'j', 'j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Delete "Road trip"'))
    expect(nodeFs.existsSync(lib.file('Road trip'))).toBe(true)
    // Keep it
    await press('j', ENTER)
    expect(nodeFs.existsSync(lib.file('Road trip'))).toBe(true)
    await press('m', 'j', 'j', 'j', 'j', ENTER, ENTER)
    await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Road trip'))).toBe(false))
    await vi.waitFor(() => expect(rowsText(lines())).not.toMatch(/Road trip\s+·/))
    expect(status(lines())).toContain('Deleted "Road trip".')
  })

  test('Clear on Recently played asks first', async () => {
    nodeFs.writeFileSync(HISTORY, JSON.stringify({ at: 100, path: '/m/a.mp3', title: 'A' }) + '\n')
    const { press, lines } = await open()
    await press('j', 'm', 'j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Clear Recently played'))
    expect(nodeFs.readFileSync(HISTORY, 'utf8')).not.toBe('')
    await press(ENTER)
    await vi.waitFor(() => expect(nodeFs.readFileSync(HISTORY, 'utf8')).toBe(''))
  })

  test('a list changed on disk shows within one 2 s poll', async () => {
    const { press, lines, lib } = await open()
    // the tab's poll, and the favourites' (the whole time)
    expect([...lib.timers].map(t => t.ms)).toEqual([2000, 2000])
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    const file = lib.file('Road trip')
    const was = nodeFs.statSync(file).mtimeMs
    nodeFs.writeFileSync(file, m3u(['/m/r9.mp3', 'Road nine']))
    nodeFs.utimesSync(file, new Date(was + 5000), new Date(was + 5000))
    lib.tick()
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road nine'))
    expect(rowsText(lines())).not.toContain('Road two')
  })

  test('an open list is checked again when the song changes', async () => {
    const { press, lines, lib, vars } = await open()
    await press('j', 'j', 'j', ENTER)
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road two'))
    const file = lib.file('Road trip')
    const was = nodeFs.statSync(file).mtimeMs
    nodeFs.writeFileSync(file, m3u(['/m/r8.mp3', 'Road eight']))
    nodeFs.utimesSync(file, new Date(was + 5000), new Date(was + 5000))
    await vars.change('playing', () => 'Other')
    await vi.waitFor(() => expect(rowsText(lines())).toContain('Road eight'))
  })

  describe('fix round 1', () => {
    const ZEBRA = { ...FILES, Zebra: m3u(['/m/z1.mp3', 'Zed one']) }
    // a list sorting above the cursor's, seen by the next poll
    const addAbove = async (ui: Awaited<ReturnType<typeof open>>) => {
      nodeFs.writeFileSync(ui.lib.file('Aardvark'), m3u())
      ui.lib.tick()
      await vi.waitFor(() => expect(rowsText(ui.lines())).toMatch(/Aardvark\s+·/))
    }

    test('Delete playlist deletes the list it named, though a poll moved the rows under the confirm', async () => {
      const ui = await open(ZEBRA)
      await ui.press('j', 'j', 'j', 'j', 'm', 'j', 'j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Delete "Zebra"'))
      await addAbove(ui)
      await ui.press(ENTER)
      await vi.waitFor(() => expect(nodeFs.existsSync(ui.lib.file('Zebra'))).toBe(false))
      expect(nodeFs.existsSync(ui.lib.file('Road trip'))).toBe(true)
    })

    test("the menu's Play plays the list it was opened on", async () => {
      const ui = await open(ZEBRA)
      await ui.press('j', 'j', 'j', 'j', 'm')
      await addAbove(ui)
      await ui.press(ENTER)
      await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(ui.host, ui.session.config, [{ path: '/m/z1.mp3', title: 'Zed one' }], ui.lib.file('Zebra'), 0))
    })

    // a song sorting above Road two, written in the open list and seen by the next poll
    const songAbove = async (ui: Awaited<ReturnType<typeof open>>) => {
      const file = ui.lib.file('Road trip')
      const was = nodeFs.statSync(file).mtimeMs
      nodeFs.writeFileSync(file, m3u(['/m/r0.mp3', 'Road zero'], ['/m/r1.mp3', 'Road one'], ['/m/r2.mp3', 'Road two'], ['/m/r3.mp3', 'Road three']))
      nodeFs.utimesSync(file, new Date(was + 5000), new Date(was + 5000))
      ui.lib.tick()
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road zero'))
    }

    test("a song's menu removes the song it was opened on, though a poll moved the rows", async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      await ui.press('j', 'm')
      await songAbove(ui)
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(nodeFs.readFileSync(ui.lib.file('Road trip'), 'utf8')).not.toContain('r2.mp3'))
      const text = nodeFs.readFileSync(ui.lib.file('Road trip'), 'utf8')
      expect(text).toContain('r0.mp3')
      expect(text).toContain('r1.mp3')
    })

    test("a song's menu plays the list as it was, from the song it was opened on", async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      await ui.press('j', 'm')
      await songAbove(ui)
      await ui.press(ENTER)
      const entries = [{ path: '/m/r1.mp3', title: 'Road one' }, { path: '/m/r2.mp3', title: 'Road two' }, { path: '/m/r3.mp3', title: 'Road three' }]
      await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(ui.host, ui.session.config, entries, ui.lib.file('Road trip'), 1))
    })

    test("a song's menu adds the songs it was opened on", async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      await ui.press('j', 'm')
      await songAbove(ui)
      await ui.press('j', 'j', ENTER)
      await vi.waitFor(() => expect(player.addToQueue).toHaveBeenCalledWith(ui.host, ui.session.config, [{ path: '/m/r2.mp3', title: 'Road two' }], 'next'))
    })

    test("a tab switch leaves filter mode; neither tab's filter writes the other's", async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      await ui.press('/', 't')
      const q = ui.where(' Queue ')
      await ui.click(q.x + 2, q.y)
      await ui.press('z', 'z')
      expect(await ui.vars.read('filter')).toBe('')
      expect(rowsText(ui.lines())).not.toContain('/ filter:')
      // and back: the Queue's filter typed, then a click on Playlists
      await ui.press('/', 'z')
      expect(await ui.vars.read('filter')).toBe('z')
      const p = ui.where(' Playlists ')
      await ui.click(p.x + 2, p.y)
      await ui.press('z')
      expect(await ui.vars.read('filter')).toBe('z')
      expect(rowsText(ui.lines())).toContain('/ filter: t')
      expect(rowsText(ui.lines())).not.toContain('/ filter: tz')
    })

    test('Enter in the filter plays from the first match of the text typed, before a redraw', async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      for (const k of ['/', 't', 'h', 'r', ENTER]) ui.ui.stdin.write(k)
      await vi.waitFor(() => expect(player.playEntries).toHaveBeenCalledWith(ui.host, ui.session.config, expect.any(Array), ui.lib.file('Road trip'), 2))
    })

    test('an open list deleted elsewhere goes back to the top level, saying so', async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      nodeFs.rmSync(ui.lib.file('Road trip'))
      ui.lib.tick()
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('+ New playlist…'))
      expect(status(ui.lines())).toContain('That playlist is gone.')
    })

    test('an open Favourites with no file yet is not gone', async () => {
      const ui = await open({ 'Road trip': FILES['Road trip'] })
      await ui.press(ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toMatch(/★ Favourites · 0 songs/))
      ui.lib.tick()
      await ui.settled()
      expect(rowsText(ui.lines())).toMatch(/★ Favourites · 0 songs/)
      expect(status(ui.lines())).not.toContain('gone')
    })
  })

  test('the poll runs only while the tab shows', async () => {
    const { press, lib } = await open()
    // the favourites' poll stays
    expect(lib.timers.size).toBe(2)
    await press('\t')
    await vi.waitFor(() => expect(lib.timers.size).toBe(1))
  })

  describe('favourite and Add to playlist', () => {
    const favText = (lib: ReturnType<typeof library>) => (nodeFs.existsSync(lib.file(FAV)) ? nodeFs.readFileSync(lib.file(FAV), 'utf8') : '')
    const openRoadTrip = async () => {
      const ui = await open()
      await ui.press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Road two'))
      return ui
    }
    const QUEUE_JSON = nodePath.join(STATE, 'queue.json')
    afterEach(() => nodeFs.rmSync(QUEUE_JSON, { force: true }))

    test('* on a song toggles it in Favourites, says so, and marks its row ★', async () => {
      const { press, lines, lib } = await openRoadTrip()
      await press('*')
      await vi.waitFor(() => expect(favText(lib)).toContain('/m/r1.mp3'))
      await vi.waitFor(() => expect(status(lines())).toContain('Added to ★ Favourites.'))
      await vi.waitFor(() => expect(lines()[lineOf(lines(), /Road one/)]).toContain('★'))
      expect(lines()[lineOf(lines(), /Road two/)]).not.toContain('★')
      await press('*')
      await vi.waitFor(() => expect(favText(lib)).not.toContain('/m/r1.mp3'))
      await vi.waitFor(() => expect(status(lines())).toContain('Removed from ★ Favourites.'))
      await vi.waitFor(() => expect(lines()[lineOf(lines(), /Road one/)]).not.toContain('★'))
    })

    test('at the top level * and P say to pick songs inside a playlist', async () => {
      const { press, lines, lib } = await open()
      const was = favText(lib)
      await press('j', 'j', 'j', '*')
      await vi.waitFor(() => expect(status(lines())).toContain('Pick songs inside a playlist.'))
      await press('j', 'P')
      // time for a checklist to open, were it to
      await new Promise(r => setTimeout(r, 100))
      expect(rowsText(lines())).not.toContain('Add to playlist')
      expect(status(lines())).toContain('Pick songs inside a playlist.')
      expect(favText(lib)).toBe(was)
    })

    test('P opens the checklist; Enter toggles a row and it stays open, the marks updated; Esc closes', async () => {
      const { press, lines, lib } = await openRoadTrip()
      await press('\x1b[1;2B', 'P')
      await vi.waitFor(() => expect(rowsText(lines())).toContain('Add to playlist'))
      const row = (t: string) => lines()[lineOf(lines(), new RegExp(`[✓– ] ${t}`))] ?? ''
      expect(row('Road trip')).toContain('✓ Road trip')
      expect(row('Late night')).not.toMatch(/[✓–] Late night/)
      expect(rowsText(lines())).toContain('+ New playlist…')
      // Late night: blank, so both songs go in
      await press('j', ENTER)
      await vi.waitFor(() => expect(nodeFs.readFileSync(lib.file('Late night'), 'utf8')).toContain('/m/r2.mp3'))
      expect(nodeFs.readFileSync(lib.file('Late night'), 'utf8')).toContain('/m/r1.mp3')
      await vi.waitFor(() => expect(row('Late night')).toContain('✓ Late night'))
      expect(rowsText(lines())).toContain('Add to playlist')
      // and out again: ✓ takes them all out
      await press(ENTER)
      await vi.waitFor(() => expect(nodeFs.readFileSync(lib.file('Late night'), 'utf8')).not.toContain('/m/r1.mp3'))
      expect(nodeFs.readFileSync(lib.file('Late night'), 'utf8')).toContain('/m/l1.mp3')
      await press(ESC)
      expect(rowsText(lines())).not.toContain('Add to playlist')
    })

    test('a song in some of a list shows –, and Enter adds the rest', async () => {
      const { press, lines, lib } = await openRoadTrip()
      nodeFs.writeFileSync(lib.file(FAV), m3u(['/m/r1.mp3', 'Road one']))
      await press('\x1b[1;2B', 'P')
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/– ★ Favourites/))
      await press(ENTER)
      await vi.waitFor(() => expect(favText(lib)).toContain('/m/r2.mp3'))
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/✓ ★ Favourites/))
    })

    test('+ New playlist… in the checklist asks a name and makes the list with the songs', async () => {
      const { press, lines, lib } = await openRoadTrip()
      await press('P')
      await vi.waitFor(() => expect(rowsText(lines())).toContain('Add to playlist'))
      await press('j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/New playlist name/))
      await press('Gym', ENTER)
      await vi.waitFor(() => expect(nodeFs.existsSync(lib.file('Gym'))).toBe(true))
      expect(nodeFs.readFileSync(lib.file('Gym'), 'utf8')).toContain('/m/r1.mp3')
      // back in the checklist, the new list ticked
      await vi.waitFor(() => expect(rowsText(lines())).toMatch(/✓ Gym/))
    })

    test("a song's menu has Favourite (Unfavourite once it is one) and Add to playlist…", async () => {
      nodeFs.rmSync(HISTORY, { force: true })
      const { press, lines, lib } = await openRoadTrip()
      await press('m')
      expect(rowsText(lines())).toContain('Favourite')
      expect(rowsText(lines())).toContain('Add to playlist…')
      const items = lines().join('\n')
      expect(items).not.toContain('Unfavourite')
      // Favourite is the fifth item: Play from here, Add to queue, Play next, Remove, Favourite
      await press('j', 'j', 'j', 'j', ENTER)
      await vi.waitFor(() => expect(favText(lib)).toContain('/m/r1.mp3'))
      await vi.waitFor(() => expect(lines()[lineOf(lines(), /Road one/)]).toContain('★'))
      await press('m')
      expect(rowsText(lines())).toContain('Unfavourite')
    })

    test('Recently played songs can be favourited', async () => {
      nodeFs.writeFileSync(HISTORY, JSON.stringify({ at: Math.floor(Date.now() / 1000) - 60, path: '/m/h.mp3', title: 'Heard' }) + '\n')
      const { press, lines, lib } = await open()
      await press('j', ENTER)
      await vi.waitFor(() => expect(rowsText(lines())).toContain('Heard'))
      await press('*')
      await vi.waitFor(() => expect(favText(lib)).toContain('/m/h.mp3'))
    })

    test('★ shows in now playing when the song playing is a favourite; a click on it toggles', async () => {
      const lib = library({ [FAV]: m3u([`${ALBUM}/Disc 1/03.mp3`, 'Song three']) })
      const ui = await show(100, PLAYING, '', '', { library: lib })
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('▶ ★ Song three'))
      // and on its row in the Queue
      expect(ui.lines()[lineOf(ui.lines(), /3\. Song three/)]).toContain('★')
      nodeFs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 1, entries: PLAYING.queue!.paths.map((p, i) => ({ id: `1.${i}`, path: p, title: PLAYING.queue!.items[i] })), arrangement: { kind: 'none' }, root: ALBUM, source: '' }))
      nodeFs.writeFileSync(nodePath.join(STATE, 'queue-place.json'), JSON.stringify({ rev: 1, current: '1.2', seconds: 0 }))
      onTestFinished(() => nodeFs.rmSync(nodePath.join(STATE, 'queue-place.json'), { force: true }))
      const star = ui.where('★ Song three')
      await ui.click(star.x, star.y)
      await vi.waitFor(() => expect(favText(lib)).not.toContain('03.mp3'))
      await vi.waitFor(() => expect(rowsText(ui.lines())).not.toContain('▶ ★ Song three'))
    })

    test('* on a chapter row acts on the whole video; with an empty list, on the song playing', async () => {
      const VIDEO = 'https://www.youtube.com/watch?v=abc123'
      nodeFs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 1, entries: [{ id: '1.0', path: VIDEO, title: 'Long mix' }], arrangement: { kind: 'none' }, root: '', source: '' }))
      const lib = library()
      const chapters = { ...PLAYING, playing: 'Long mix', lastUrl: VIDEO, queue: { kind: 'chapters' as const, items: ['Part one', 'Part two'], paths: [], root: '', current: 0 } }
      const ui = await show(100, chapters, '', '', { library: lib })
      await ui.press('j', '*')
      await vi.waitFor(() => expect(favText(lib)).toContain(VIDEO))
      expect(favText(lib)).not.toContain('Part two')
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('▶ ★ Long mix'))
      // nothing in the queue's list: the song playing
      await ui.vars.change('queue', () => ({ kind: 'none', items: [], paths: [], root: '', current: -1 }))
      await ui.settled()
      await ui.press('*')
      await vi.waitFor(() => expect(favText(lib)).not.toContain(VIDEO))
    })

    test('* on a picked folder in Files favourites every song in it, through its subfolders', async () => {
      const music = nodeFs.mkdtempSync(nodePath.join(TMP, 'music-'))
      nodeFs.mkdirSync(nodePath.join(music, 'Album', 'Disc 1'), { recursive: true })
      for (const f of ['Album/b.mp3', 'Album/Disc 1/a.mp3', 'Album/Disc 1/c.mp3', 'loose.mp3']) nodeFs.writeFileSync(nodePath.join(music, f), '')
      const lib = library()
      const ui = await show(100, PLAYING, '', '', { library: lib })
      await ui.press('o', music, ENTER)
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Album/'))
      await ui.press(HOME, 'j', '\x1b[1;2B', '\x1b[1;2A')
      await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('1 picked'))
      await ui.press('*')
      await vi.waitFor(() => expect(favText(lib)).toContain(`${music}/Album/Disc 1/c.mp3`))
      const text = favText(lib)
      expect(text).toContain(`${music}/Album/b.mp3`)
      expect(text).toContain(`${music}/Album/Disc 1/a.mp3`)
      expect(text).not.toContain('loose.mp3')
      // the Files menu has the items too
      await ui.press('m')
      expect(rowsText(ui.lines())).toContain('Add to playlist…')
      expect(rowsText(ui.lines())).toMatch(/Favourite/)
    })

    test("the Queue's menu has Favourite and Add to playlist…, acting on the songs it opened on", async () => {
      const lib = library()
      const ui = await show(100, PLAYING, '', '', { library: lib })
      await ui.press(HOME, 'm')
      expect(rowsText(ui.lines())).toContain('Add to playlist…')
      const fav = lineOf(ui.lines(), / Favourite /)
      expect(fav).toBeGreaterThan(0)
      const at = ui.where('Favourite')
      await ui.click(at.x, at.y)
      await vi.waitFor(() => expect(favText(lib)).toContain(`${ALBUM}/Disc 1/01.mp3`))
    })

    describe('fix round 1', () => {
      test('the checklist shows a window of rows that follows the choice, + New playlist… reachable', async () => {
        const many = Object.fromEntries([...Array(40).keys()].map(i => [`List ${String(i + 1).padStart(2, '0')}`, m3u()]))
        const lib = library(many)
        const ui = await show(100, PLAYING, '', '', { library: lib, rows: 20 })
        await ui.press('P')
        await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Add to playlist'))
        expect(rowsText(ui.lines())).toContain('List 01')
        expect(rowsText(ui.lines())).not.toContain('List 40')
        expect(ui.lines().length).toBeLessThanOrEqual(20)
        for (let i = 0; i < 40; i++) ui.ui.stdin.write('j')
        await ui.settled()
        expect(rowsText(ui.lines())).toContain('List 40')
        expect(rowsText(ui.lines())).not.toContain('List 01')
        await ui.press('j')
        expect(rowsText(ui.lines())).toContain('+ New playlist…')
        expect(ui.lines().length).toBeLessThanOrEqual(20)
        // and Enter on it is + New playlist…
        await ui.press(ENTER)
        await vi.waitFor(() => expect(rowsText(ui.lines())).toMatch(/New playlist name/))
      })

      test("a folder over the cap: the cap's note shows, as Add to queue says it", async () => {
        const lib = library()
        const ui = await show(100, PLAYING, '', '', { library: lib })
        const note = 'Added the first 10000 songs.'
        vi.mocked(player.expandEntries).mockResolvedValueOnce({ songs: [{ path: '/m/x.mp3' }], note })
        const music = nodeFs.mkdtempSync(nodePath.join(TMP, 'music-'))
        nodeFs.mkdirSync(nodePath.join(music, 'Big'))
        await ui.press('o', music, ENTER)
        await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Big/'))
        await ui.press(HOME, 'j', '*')
        await vi.waitFor(() => expect(status(ui.lines())).toContain(`Added to ★ Favourites. ${note}`))
        expect(favText(lib)).toContain('/m/x.mp3')
        vi.mocked(player.expandEntries).mockResolvedValueOnce({ songs: [{ path: '/m/x.mp3' }], note })
        await ui.press('P')
        await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('Add to playlist'))
        expect(status(ui.lines())).toContain(note)
      })

      test('a list changed elsewhere while the checklist is open shows its new mark at the next poll', async () => {
        const { press, lines, lib } = await openRoadTrip()
        await press('P')
        await vi.waitFor(() => expect(rowsText(lines())).toContain('Add to playlist'))
        const row = (t: string) => lines()[lineOf(lines(), new RegExp(`[✓– ] ${t}`))] ?? ''
        expect(row('Road trip')).toContain('✓ Road trip')
        // let the first look record the files as they are
        await new Promise(r => setTimeout(r, 100))
        const file = lib.file('Road trip')
        nodeFs.writeFileSync(file, m3u(['/m/r3.mp3', 'Road three']))
        const later = new Date(Date.now() + 5000)
        nodeFs.utimesSync(file, later, later)
        lib.tick()
        await vi.waitFor(() => expect(rowsText(lines())).not.toMatch(/[✓–] Road trip/))
      })

      test('a list deleted elsewhere while the checklist is open is not made again', async () => {
        const { press, lines, lib } = await openRoadTrip()
        await press('P')
        await vi.waitFor(() => expect(rowsText(lines())).toContain('Add to playlist'))
        nodeFs.rmSync(lib.file('Late night'))
        await press('j', ENTER)
        await vi.waitFor(() => expect(status(lines())).toContain('That playlist is gone.'))
        expect(nodeFs.existsSync(lib.file('Late night'))).toBe(false)
        await vi.waitFor(() => expect(rowsText(lines())).not.toContain('Late night'))
        expect(rowsText(lines())).toContain('Add to playlist')
      })

      test('now playing shows a dim ☆ when the song is not a favourite; a click on it favourites it', async () => {
        const lib = library()
        const ui = await show(100, PLAYING, '', '', { library: lib })
        expect(ui.lines().some(l => stripAnsi(l).includes('▶ ☆ Song three'))).toBe(true)
        nodeFs.writeFileSync(QUEUE_JSON, JSON.stringify({ version: 1, rev: 1, entries: PLAYING.queue!.paths.map((p, i) => ({ id: `1.${i}`, path: p, title: PLAYING.queue!.items[i] })), arrangement: { kind: 'none' }, root: ALBUM, source: '' }))
        nodeFs.writeFileSync(nodePath.join(STATE, 'queue-place.json'), JSON.stringify({ rev: 1, current: '1.2', seconds: 0 }))
        onTestFinished(() => nodeFs.rmSync(nodePath.join(STATE, 'queue-place.json'), { force: true }))
        const star = ui.where('☆')
        await ui.click(star.x, star.y)
        await vi.waitFor(() => expect(favText(lib)).toContain('03.mp3'))
        await vi.waitFor(() => expect(rowsText(ui.lines())).toContain('▶ ★ Song three'))
      })
    })
  })
})

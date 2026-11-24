import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host, PlayerKeys } from '../../../plugins/stream-radio/core/host'
import * as player from '../../../plugins/stream-radio/core/player'
import { moveBy, moveTo } from '../../../plugins/stream-radio/core/queue'
import { DEFAULT_CONFIG } from '../src/config'
import { memoryStore } from '../src/host-node'
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
    seek: vi.fn(async () => ''),
    start: vi.fn(),
    locate: vi.fn(async (_h: Host, args: string) => ({ kind: 'play', url: args })),
    mpv: vi.fn(defaultMpv),
    reorderQueue: vi.fn(async () => ''),
    removeFromQueue: vi.fn(async () => ''),
    addToQueue: vi.fn(async () => ''),
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
const ESC = '\x1b'

// A session over a real store: the App draws what is in it and calls the
// (mocked) core actions with its host.
type Extra = { media?: Media; graphics?: Graphics; rows?: number; tags?: TagReader; fs?: Partial<Host['fs']> }
async function show(columns: number, state: Partial<PlayerKeys> = PLAYING, status = '', home = '', extra: Extra = {}) {
  const { media, graphics, rows, tags, fs } = extra
  const listeners = new Set<() => void>()
  let seq = status ? 1 : 0
  const vars = memoryStore(() => listeners.forEach(fn => fn()))
  for (const [k, v] of Object.entries(state)) await vars.change(k as keyof PlayerKeys, () => v as never)
  const host = { program: 'tui', vars, home: async () => home, fs, dataDir: async () => '/state' } as unknown as Host
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
  await tick()
  const lines = () => (ui.lastFrame() ?? '').split('\n')
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      ui.stdin.write(k)
      await tick()
    }
  }
  // The mouse: cells are 0-based from the top left, as the app is drawn.
  const click = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'left', x, y })
    onMouse({ kind: 'release', button: 'left', x, y })
    await tick()
  }
  const dblclick = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'left', x, y })
    onMouse({ kind: 'press', button: 'left', x, y })
    await tick()
  }
  const rightClick = async (x: number, y: number) => {
    onMouse({ kind: 'press', button: 'right', x, y })
    onMouse({ kind: 'release', button: 'right', x, y })
    await tick()
  }
  const modClick = async (x: number, y: number, mod: 'shift' | 'alt' | 'ctrl') => {
    const mods = { shift: mod === 'shift', alt: mod === 'alt', ctrl: mod === 'ctrl' }
    onMouse({ kind: 'press', button: 'left', x, y, mods })
    onMouse({ kind: 'release', button: 'left', x, y, mods })
    await tick()
  }
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    onMouse({ kind: 'press', button: 'left', ...from })
    await tick()
    onMouse({ kind: 'drag', button: 'left', x: to.x, y: Math.round((from.y + to.y) / 2) })
    onMouse({ kind: 'drag', button: 'left', ...to })
    await tick()
    onMouse({ kind: 'release', button: 'left', ...to })
    await tick()
  }
  const wheel = async (x: number, y: number, dir: 'up' | 'down') => {
    onMouse({ kind: 'wheel', button: 'none', dir, x, y })
    await tick()
  }
  // Where `text` first shows: its line, and the column of its first character.
  const where = (text: string) => {
    const y = lines().findIndex(l => l.includes(text))
    expect(y, `"${text}" on screen`).toBeGreaterThanOrEqual(0)
    const line = stripAnsi(lines()[y])
    return { x: columnOf(line, line.indexOf(text)), y }
  }
  return { ui, session, host, vars, lines, press, say, click, dblclick, rightClick, modClick, drag, wheel, where }
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
    const heading = lineOf(all, /Playlist/)
    expect(all[heading]).toMatch(/Playlist.*▶ Song three/)
    expect(all.join('\n')).toMatch(/2:41 ━+─* 4:05/)
    expect(all.join('\n')).toContain('vol 60%')
    expect(all.join('\n')).toContain('repeat all')
    expect(all.join('\n')).toContain('shuffle off')
    expect(lineOf(all, /space pause.*n\/p next\/prev.*\/ filter/)).toBeGreaterThan(heading)
    expect(lineOf(all, /\? all keys.*o open url\/path.*l resume last.*x stop.*q quit/)).toBeGreaterThan(heading)
    expect(all.every(l => [...l].length <= 100)).toBe(true)
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

  test('a playlist under the home folder is headed with ~', async () => {
    const { lines } = await show(100, PLAYING, '', '/m')
    expect(lines().join('\n')).toContain('Playlist · ~/Album')
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
    // A playlist's next file: the title changes while mpv is still opening it,
    // so its duration is unavailable then; a second later it is known.
    let isLoaded = false
    vi.mocked(player.mpv).mockImplementation(async (_h, command) =>
      command[1] === 'duration' ? (isLoaded ? { data: 245 } : undefined) : undefined,
    )
    const { lines, vars } = await show(100)
    expect(lines().join('\n')).toContain('♪ live')
    isLoaded = true
    await vars.change('elapsed', () => 162)
    await tick()
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
    const { lines, vars } = await show(100, PLAYING, '', '', { media })
    await vi.waitFor(() => expect(pending.has(SONG3)).toBe(true))
    await vars.change('queue', q => ({ ...q, current: 1 }))
    await vars.change('playing', () => 'Song two')
    await vi.waitFor(() => expect(pending.has(`${ALBUM}/Disc 1/02.mp3`)).toBe(true))
    expect(pending.get(SONG3)!.signal.aborted).toBe(true)
    pending.get(SONG3)!.resolve(flat(255))
    await tick()
    expect(lines().some(l => BRAILLE.test(l))).toBe(false)
  })

  test("the artist and album show under the title", async () => {
    const { lines } = await show(100)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('The Band · The Album'))
  })

  test('the controls and the volume bar share a line; repeat and shuffle the next', async () => {
    const { lines } = await show(100)
    const at = lineOf(lines(), new RegExp(`${ICONS.prev} +${ICONS.pause} +${ICONS.next} +\\|.*vol 60%.*\\|`, 'u'))
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
    const title = all.findIndex(l => l.includes('▶ Song three'))
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
    const { lines, vars } = await show(100, PLAYING, '', '', { media, graphics: screen.graphics, rows: 40 })
    await vi.waitFor(() => expect(later).toHaveLength(1))
    later[0]({ width: 800, height: 450, rgba: new Uint8Array(800 * 450 * 4) })
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(9)))
    screen.clear()
    await vars.change('queue', q => ({ ...q, current: 1 }))
    await vars.change('playing', () => 'Song two')
    await vi.waitFor(() => expect(later).toHaveLength(2))
    await tick()
    // still drawn, nothing deleted, the title still under the art
    expect(lines().some(l => l.includes(sgr(9)))).toBe(true)
    expect(screen.sent()).not.toContain(deleted(1))
    expect(lines().findIndex(l => l.includes('▶ Song two'))).toBe(lines().findIndex(l => l.includes(sgr(9))) + 1)
  })

  test('no art: a big ♪ drawn in pixels, square, at the top', async () => {
    const screen = fakeScreen()
    const { lines } = await show(100, PLAYING, '', '', { media: pictureMedia(false), graphics: screen.graphics, rows: 40 })
    // 33 columns of 8×16 cells: a square is 33 wide, 17 rows tall (264 px of 272)
    await vi.waitFor(() => expect(screen.sent()).toContain(placed(17)))
    expect(screen.sent()).not.toContain(placed(18))
    expect(lines().some(l => l.includes(sgr(1) + P.repeat(33)))).toBe(true)
    expect(lines().findIndex(l => l.includes('▶ Song three'))).toBe(lines().findIndex(l => l.includes(sgr(17))) + 1)
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
    const { ui, lines } = await show(100)
    for (const k of ['o', '/', 'n', 'o', ENTER]) ui.stdin.write(k)
    await tick()
    // no files in this host: the whole path typed is the one that isn't there
    expect(lines().join('\n')).toContain('No such folder: /no')
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
    expect(player.resume).not.toHaveBeenCalled()
    expect(lines().join('\n')).toContain('Already playing Song three.')
  })

  test('l after a stop picks the last URL up again', async () => {
    const { press, host } = await show(100, { ...PLAYING, playing: '', elapsed: -1 })
    await press('l')
    expect(player.resume).toHaveBeenCalledWith(host, expect.anything(), ALBUM, expect.anything())
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
    expect(await vars.read('volume')).toBe(84)
    expect(vi.mocked(player.setVolume).mock.calls.map(c => c[2])).toEqual([67, 75, 84])
  })

  test('Enter on a song plays it', async () => {
    const { press, host } = await show(100)
    await press(UP, ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, 1)
  })

  test('/ filters as you type; Enter plays the first match', async () => {
    const { press, host, lines } = await show(100)
    await press('/', 'o', 't', 'h')
    expect(lines().join('\n')).toContain('/ filter: oth')
    expect(lines().join('\n')).not.toContain('Intro')
    await press(ENTER)
    expect(player.pick).toHaveBeenCalledWith(host, 3)
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
    expect(player.pick).toHaveBeenCalledWith(host, 1)
  })

  test('a double-click plays it', async () => {
    const { dblclick, where, host } = await show(100)
    const at = where('Song two')
    await dblclick(at.x, at.y)
    expect(player.pick).toHaveBeenCalledWith(host, 1)
  })

  test('the wheel scrolls the list, not the selection; a click then lands where it points; a key brings the view back', async () => {
    const { wheel, click, where, press, lines, host } = await show(100, LONG)
    expect(firstShown(lines())).toBe(1)
    const list = where('Track 2')
    await wheel(list.x, list.y, 'down')
    expect(firstShown(lines())).toBe(4)
    // the selection stayed on the first track
    await press(ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, 0)
    // the row now under the pointer
    const under = Number(/(\d+)\. Track/.exec(lines()[list.y])![1])
    await click(list.x, list.y)
    expect(firstShown(lines())).toBe(4)
    await press(ENTER)
    expect(player.pick).toHaveBeenLastCalledWith(host, under - 1)
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
})

describe('tabs', () => {
  // Tests draw without colour, so which tab shows is read from the heading
  // under the tab row.
  const INV = /^\s*Playlist/
  const INV_FILES = /^\s*Files/
  const tabHeading = (all: string[]) => all[lineOf(all, /Files\s+Playlist/) + 1] ?? ''
  const EMPTY: Partial<PlayerKeys> = { queue: { kind: 'none', items: [], paths: [], root: '', current: -1 } }

  test('starts on Playlist with a queue, on Files without', async () => {
    const a = await show(100)
    expect(tabHeading(a.lines())).toMatch(INV)
    expect(a.lines().join('\n')).toContain('3. Song three')
    cleanup()
    const b = await show(100, EMPTY)
    expect(tabHeading(b.lines())).toMatch(INV_FILES)
  })

  test('Tab and Shift-Tab switch; each tab keeps its own list', async () => {
    const { press, lines } = await show(100)
    await press('\t')
    expect(tabHeading(lines())).toMatch(INV_FILES)
    expect(lines().join('\n')).not.toContain('Song three ·')
    expect(lines().join('\n')).not.toMatch(/\d+\. Song two/)
    await press('\x1b[Z')
    expect(tabHeading(lines())).toMatch(INV)
    expect(lines().join('\n')).toContain('2. Song two')
  })

  test('a click on a tab name switches', async () => {
    const { click, where, lines } = await show(100)
    const at = where(' Files ')
    await click(at.x + 2, at.y)
    expect(tabHeading(lines())).toMatch(INV_FILES)
    const back = where(' Playlist ')
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

  test('the playlist is flat: every song, no folders, shut or not', async () => {
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
  const heading = (all: string[]) => all[lineOf(all, /Files\s+Playlist/) + 1] ?? ''

  test('with nothing remembered it opens ~/Music: ../ first, folders, then playable files', async () => {
    const { lines } = await showFiles()
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · ~/Music'))
    const all = lines().join('\n')
    expect(all).toMatch(/\.\.\/[\s\S]*📁 Album\/[\s\S]*loose\.mp3/)
    expect(all).not.toContain('cover.jpg')
  })

  test('opens at the remembered folder', async () => {
    const { lines } = await showFiles({ '/state/tui-files.json': JSON.stringify({ folder: '/other' }) })
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · /other'))
    expect(lines().join('\n')).toContain('x.mp3')
  })

  test('a click on ../ goes up, and the folder is remembered', async () => {
    const saved: Record<string, string> = {}
    const { lines, click, where } = await showFiles(saved)
    await vi.waitFor(() => expect(heading(lines())).toContain('~/Music'))
    await click(where('../').x, where('../').y)
    await vi.waitFor(() => expect(heading(lines())).toMatch(/Files · ~(?!\/)/))
    expect(JSON.parse(saved['/state/tui-files.json'])).toEqual({ folder: '/h' })
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
    expect(lines().join('\n')).toContain('o go to: _')
    await press('/other', ENTER)
    await vi.waitFor(() => expect(heading(lines())).toContain('Files · /other'))
    await press('o', '/nope', ENTER)
    await vi.waitFor(() => expect(lines().join('\n')).toContain('No such folder: /nope'))
    expect(heading(lines())).toContain('Files · /other')
  })

  test('o from the Playlist goes to Files', async () => {
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
    expect(player.start).not.toHaveBeenCalled()
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
    const { lines, dblclick, where, host, session } = await sp()
    await vi.waitFor(() => expect(lines().join('\n')).toContain('Album/'))
    await dblclick(where('Album/').x, where('Album/').y)
    expect(player.addToQueue).toHaveBeenCalledWith(host, session.config, [{ path: '/h/Music/Album' }], 'end')
    await tick()
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

  test('the Playlist menu removes a song', async () => {
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
    expect(player.start).not.toHaveBeenCalled()
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
    expect(player.start).not.toHaveBeenCalled()
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

describe('playlist editing', () => {
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
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, [2, 0, 4, 1, 3])
    expect(lines().join('\n')).toContain('sort: title')
    await press('R')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, [3, 1, 4, 0, 2])
  })

  test('a song in the queue twice: only the picked copy moves', async () => {
    const twice = { ...FIVE, queue: { ...FIVE.queue!, items: ['a', 'b', 'a', 'c', 'd'], paths: ['/m/a', '/m/b', '/m/a', '/m/c', '/m/d'] } }
    const { press, host } = await show(100, twice)
    await press('j', 'j', 'u')
    expect(player.reorderQueue).toHaveBeenLastCalledWith(host, [0, 2, 1, 3, 4])
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
    test(`at ${columns} columns: previous, pause and next; repeat and shuffle`, async () => {
      const { click, where, host } = await show(columns)
      for (const [text, called] of [
        [ICONS.prev, () => expect(player.step).toHaveBeenLastCalledWith(host, -1)],
        [ICONS.pause, () => expect(player.togglePause).toHaveBeenCalledTimes(1)],
        [ICONS.next, () => expect(player.step).toHaveBeenLastCalledWith(host, 1)],
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
      const at = lineOf(lines(), new RegExp(`${ICONS.prev} +${ICONS.pause} +${ICONS.next} +\\|.*vol 60%.*\\|`, 'u'))
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
    expect(lines().some(l => l.includes(`${ICONS.prev}  ${ICONS.play}  ${ICONS.next}`))).toBe(true)
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
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 50 })
    for (const close of [ESC, '?', 'q']) {
      await press('?')
      const all = lines().join('\n')
      expect(all).not.toContain('Playlist')
      for (const text of ['Keys', 'stop the player', 'resume the last URL', 'filter the list', 'quit; the music keeps playing', 'Mouse', 'double-click', 'seek there', 'Shift-drag']) {
        expect(all).toContain(text)
      }
      await press(close)
      expect(lines().join('\n')).toContain('Playlist')
    }
    // q closed the list; it did not quit
    expect(player.stopPlaying).not.toHaveBeenCalled()
  })

  test('every description starts in the same column, the icons row too', async () => {
    const { press, lines } = await show(100, PLAYING, '', '', { rows: 50 })
    await press('?')
    const starts = ['move', 'pause or resume', 'scroll the list', 'previous, pause or play, next', 'seek there'].map(text => {
      const line = lines().find(l => l.includes(text)) ?? ''
      return columnOf(line, line.indexOf(text))
    })
    expect(new Set(starts).size).toBe(1)
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
    await press(...Array(30).fill('j'))
    expect(lines().join('\n')).toContain('Shift-drag')
    expect(lines().join('\n')).not.toContain('Keys')
    await press(...Array(30).fill('k'))
    expect(lines().join('\n')).toContain('Keys')
  })
})

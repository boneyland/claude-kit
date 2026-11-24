import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import type { Host, PlayerKeys } from '../../../plugins/stream-radio/core/host'
import * as player from '../../../plugins/stream-radio/core/player'
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
type Extra = { media?: Media; graphics?: Graphics; rows?: number }
async function show(columns: number, state: Partial<PlayerKeys> = PLAYING, status = '', home = '', extra: Extra = {}) {
  const { media, graphics, rows } = extra
  const listeners = new Set<() => void>()
  let seq = status ? 1 : 0
  const vars = memoryStore(() => listeners.forEach(fn => fn()))
  for (const [k, v] of Object.entries(state)) await vars.change(k as keyof PlayerKeys, () => v as never)
  const host = { program: 'tui', vars, home: async () => home } as unknown as Host
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
  const ui = render(<App session={session} subscribe={subscribe} media={media} graphics={graphics} mouse={mouse} />)
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
  return { ui, session, host, vars, lines, press, say, click, dblclick, wheel, where }
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
  const firstShown = (all: string[]) => Number(/(\d+)\. Track/.exec(all[lineOf(all, /Playlist/) + 1])?.[1])

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

  test("a click on a folder's arrow shuts it; elsewhere on its row it only selects; a double-click shuts it", async () => {
    const { click, dblclick, where, vars, press } = await show(100)
    // a double-click on the arrow toggles it once, not twice
    await dblclick(where('▾').x, where('▾').y)
    expect(await vars.read('openFolders')).toEqual([])
    await vars.change('openFolders', () => [`${ALBUM}/Disc 1`])
    await tick()
    let at = where('Disc 1/')
    await click(at.x + 3, at.y)
    expect(await vars.read('openFolders')).toEqual([`${ALBUM}/Disc 1`])
    // selected: Enter shuts it
    await press(ENTER)
    expect(await vars.read('openFolders')).toEqual([])
    await vars.change('openFolders', () => [`${ALBUM}/Disc 1`])
    await tick()
    // a click on another row first, or this one would make a double-click
    await click(where('Intro').x, where('Intro').y)
    at = where('▾')
    await click(at.x, at.y)
    expect(await vars.read('openFolders')).toEqual([])
    await vars.change('openFolders', () => [`${ALBUM}/Disc 1`])
    await tick()
    at = where('Disc 1/')
    await dblclick(at.x, at.y)
    expect(await vars.read('openFolders')).toEqual([])
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

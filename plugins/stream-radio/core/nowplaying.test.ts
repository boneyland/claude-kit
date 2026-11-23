import { expect, test } from 'claude-code/testing'

import { baseName, filterRows, fit, foldersOf, playlistRows, formatTime, holdTicks, LABEL_COLUMNS, marquee, parseArgs, repeatOf, resolveTarget, splitEvents, textWidth, titleColumns, trackTitle } from './nowplaying'

const MARQUEE_HOLD = holdTicks(600)

test('a song title beats the page title, any case', () => {
  expect(trackTitle('Lofi radio', { 'icy-title': 'Artist - Song' })).toBe('Artist - Song')
  expect(trackTitle('one.flac', { TITLE: 'One' })).toBe('One')
  expect(trackTitle(' lofi radio ', {})).toBe('lofi radio')
  expect(trackTitle(undefined, undefined)).toBe('')
})

test('whole watcher lines become events; the rest waits', () => {
  const { events, rest } = splitEvents('{"event":"property-change","name":"pause","data":true}\nnoise\n{"event":"end-file","reason":"eof"}\n{"event":"fil')
  expect(events).toEqual([
    { event: 'property-change', name: 'pause', data: true },
    { event: 'end-file', reason: 'eof' },
  ])
  expect(rest).toBe('{"event":"fil')
})

test('repeat from the loops', () => {
  expect(repeatOf('inf', 'inf')).toBe('one')
  expect(repeatOf('no', 'inf')).toBe('all')
  expect(repeatOf('no', 'no')).toBe('off')
  expect(repeatOf(false, 'force')).toBe('all')
})

test('time as m:ss, with hours from an hour on', () => {
  expect(formatTime(0)).toBe('0:00')
  expect(formatTime(222.9)).toBe('3:42')
  expect(formatTime(3599)).toBe('59:59')
  expect(formatTime(3600)).toBe('1:00:00')
  expect(formatTime(3725)).toBe('1:02:05')
})

test('arguments', () => {
  expect(parseArgs('stop', '')).toEqual({ kind: 'stop' })
  expect(parseArgs('pause', '')).toEqual({ kind: 'toggle' })
  expect(parseArgs(' last ', 'https://a.b/c')).toEqual({ kind: 'last' })
  expect(parseArgs('', 'https://a.b/c')).toEqual({ kind: 'play', url: 'https://a.b/c' })
  expect(parseArgs('--script=x', '').kind).toBe('error')
  expect(parseArgs('', '').kind).toBe('error')
})

test('a title that fits is shown as is and never scrolls', () => {
  expect(marquee('Lofi radio', 20, 0)).toBe('Lofi radio')
  expect(marquee('Lofi radio', 20, 57)).toBe('Lofi radio')
})

test('a long title rests at its start, then scrolls a step a tick and loops', () => {
  // 2 characters a redraw every 600ms.
  const text = 'abcdefghij'
  expect(marquee(text, 4, 0, 2, MARQUEE_HOLD)).toBe('abcd')
  expect(marquee(text, 4, MARQUEE_HOLD, 2, MARQUEE_HOLD)).toBe('abcd')
  expect(marquee(text, 4, MARQUEE_HOLD + 1, 2, MARQUEE_HOLD)).toBe('cdef')
  // Past the end, a gap, then the start again.
  expect(marquee(text, 4, MARQUEE_HOLD + 4, 2, MARQUEE_HOLD)).toBe('ij  ')
  // 17 characters round, 2 a tick: 9 ticks moving, then the rest.
  const round = Math.ceil((text.length + '   ·   '.length) / 2) + MARQUEE_HOLD
  expect(marquee(text, 4, round, 2, MARQUEE_HOLD)).toBe('abcd')
})

test('the step and the rest follow the scroll settings', () => {
  const text = 'abcdefghij'
  // 3 characters a redraw every 300ms: the rest is 8 redraws, still 2.4 s.
  expect(holdTicks(300)).toBe(8)
  expect(marquee(text, 4, 8, 3, holdTicks(300))).toBe('abcd')
  expect(marquee(text, 4, 9, 3, holdTicks(300))).toBe('defg')
  // A slow redraw still rests at least once.
  expect(holdTicks(5000)).toBe(1)
  // 0: no scrolling, cut with an ellipsis, whatever the tick.
  expect(marquee(text, 4, 0, 0)).toBe('abc…')
  expect(marquee(text, 4, 99, 0)).toBe('abc…')
  expect(fit('東京タワー', 6)).toBe('東京…')
})

test('wide characters count two cells and never overflow the window', () => {
  expect(textWidth('東京')).toBe(4)
  for (let tick = 0; tick < 40; tick++) expect(textWidth(marquee('東京タワー の 夜景 song', 7, tick))).toBe(7)
})

test('the title gets what the icon and time leave of 40 columns', () => {
  expect(LABEL_COLUMNS).toBe(40)
  expect(titleColumns('♪ ')).toBe(38)
  expect(titleColumns('1:02:05 ')).toBe(32)
  // The pause symbol is wide.
  expect(titleColumns('⏸ 3:42 ')).toBe(32)
})

test('a local file, folder or playlist resolves to an absolute path', () => {
  const where = { home: '/home/me', cwd: '/work/repo' }
  expect(resolveTarget('https://a.b/c', where)).toEqual({ kind: 'play', url: 'https://a.b/c' })
  expect(resolveTarget('~/Music', where)).toEqual({ kind: 'play', url: '/home/me/Music', isLocal: true })
  expect(resolveTarget('~', where)).toEqual({ kind: 'play', url: '/home/me', isLocal: true })
  expect(resolveTarget('/srv/mix.m3u', where)).toEqual({ kind: 'play', url: '/srv/mix.m3u', isLocal: true })
  expect(resolveTarget('./song.flac', where)).toEqual({ kind: 'play', url: '/work/repo/song.flac', isLocal: true })
  expect(resolveTarget('"~/My Music/a b.mp3"', where)).toEqual({ kind: 'play', url: '/home/me/My Music/a b.mp3', isLocal: true })
  expect(resolveTarget('file:///home/me/My%20Music', where)).toEqual({ kind: 'play', url: '/home/me/My Music', isLocal: true })
  expect(resolveTarget('ftp://a.b/c', where).kind).toBe('error')
  expect(resolveTarget('--script=x', where).kind).toBe('error')
  expect(resolveTarget('~/x', { home: '', cwd: '' }).kind).toBe('error')
  expect(baseName('/home/me/Music/01 Song.flac')).toBe('01 Song.flac')
})

const ROOT = '/m/Album'
const PATHS = ['/m/Album/01 Intro.flac', '/m/Album/Disc 2/01 A.flac', '/m/Album/Disc 2/02 B.flac', '/m/Album/Disc 2/Bonus/01 C.flac', '/m/Album/09 End.flac']
const NAMES = ['Intro', 'A', 'B', 'C', 'End']

test('the folders between the root and a path', () => {
  expect(foldersOf('/m/Album/Disc 2/Bonus/01 C.flac', ROOT)).toEqual(['/m/Album/Disc 2', '/m/Album/Disc 2/Bonus'])
  expect(foldersOf('/m/Album/01 Intro.flac', ROOT)).toEqual([])
  expect(foldersOf('https://a.b/c', ROOT)).toEqual([])
})

test('a shut folder is one row with its count; its songs stay hidden', () => {
  const rows = playlistRows(NAMES, PATHS, ROOT, new Set(), 0)
  expect(rows.map(r => (r.kind === 'folder' ? `[${r.name} ${r.count}${r.isOpen ? ' open' : ''}]` : `${r.depth}:${r.number}.${r.name}`))).toEqual([
    '0:1.Intro',
    '[Disc 2 3]',
    '0:2.End',
  ])
})

test('an open folder shows its songs indented, numbered within it', () => {
  const rows = playlistRows(NAMES, PATHS, ROOT, new Set(['/m/Album/Disc 2', '/m/Album/Disc 2/Bonus']), 3)
  expect(rows.map(r => (r.kind === 'folder' ? `${r.depth}:[${r.name} ${r.count}]` : `${r.depth}:${r.number}.${r.name}#${r.index}`))).toEqual([
    '0:1.Intro#0',
    '0:[Disc 2 3]',
    '1:1.A#1',
    '1:2.B#2',
    '1:[Bonus 1]',
    '2:1.C#3',
    '0:2.End#4',
  ])
  // The current song's folders know they hold it.
  const shut = playlistRows(NAMES, PATHS, ROOT, new Set(), 3)
  expect(shut.find(r => r.kind === 'folder')).toMatchObject({ name: 'Disc 2', hasCurrent: true, isOpen: false })
})

test('without a root the playlist is a plain list', () => {
  const rows = playlistRows(NAMES, PATHS, '', new Set(), 0)
  expect(rows.map(r => (r.kind === 'item' ? r.number : -1))).toEqual([1, 2, 3, 4, 5])
})

test('by default a title moves 4 characters a second', () => {
  const text = 'abcdefghijklmnop'
  // Resting 2.4 s at a second a redraw: 2 redraws, then 4 characters each.
  expect(marquee(text, 4, holdTicks(1000))).toBe('abcd')
  expect(marquee(text, 4, holdTicks(1000) + 1)).toBe('efgh')
})

test('the filter keeps entries whose name or folder holds every word', () => {
  const rows = filterRows(NAMES, PATHS, ROOT, 'disc  b')
  expect(rows).toEqual([
    { kind: 'item', index: 2, name: 'B', depth: 0, number: 3, where: 'Disc 2' },
    { kind: 'item', index: 3, name: 'C', depth: 0, number: 4, where: 'Disc 2/Bonus' },
  ])
  expect(filterRows(NAMES, PATHS, ROOT, 'END').map(r => r.kind === 'item' && r.index)).toEqual([4])
  expect(filterRows(['Nocturne', 'Arabesque'], [], '', 'noc')).toHaveLength(1)
})

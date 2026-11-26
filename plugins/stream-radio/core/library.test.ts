import { expect, test } from 'claude-code/testing'

import {
  addMissing,
  checkName,
  listText,
  markOf,
  moveSongs,
  parseHistory,
  parseList,
  placesOf,
  removeAt,
  removeSongs,
  songKey,
  songsOf,
  toggle,
  whenPlayed,
} from './library'

const song = (path: string, title?: string) => (title === undefined ? { path } : { path, title })
const listOf = (...paths: string[]) => parseList(paths.join('\n') + '\n', '/m')

test('same song across url forms', () => {
  const ids = [
    'https://youtu.be/abc',
    'https://www.youtube.com/watch?v=abc&list=L&t=30',
    'https://music.youtube.com/watch?v=abc',
  ].map(u => songKey(u, '/h'))
  expect(ids).toEqual(['yt:abc', 'yt:abc', 'yt:abc'])
  const local = ['~/M/a.mp3', 'file:///h/M/a.mp3', '/h/M/a.mp3', '/h/M//a.mp3/'].map(p => songKey(p, '/h'))
  expect(new Set(local)).toEqual(new Set(['/h/M/a.mp3']))
  expect(songKey('https://example.com/s.mp3', '/h')).toBe('https://example.com/s.mp3')
})

test('round-trips foreign lines', () => {
  const text = '﻿#EXTM3U\r\n#EXTVLCOPT:x\r\n\r\n#EXTINF:12,A\r\na.mp3\r\n# note\r\nb.mp3\r\n'
  const f = parseList(text, '/m')
  expect(songsOf(f)).toEqual([song('/m/a.mp3', 'A'), song('/m/b.mp3')])
  const out = listText(toggle(f, [song('/m/c.mp3')], ''))
  expect(out).toContain('#EXTVLCOPT:x')
  expect(out).toContain('# note')
  expect(out.startsWith('#EXTM3U\n')).toBe(true)
  expect(out).not.toContain('\r')
  expect(out.endsWith('/m/c.mp3\n')).toBe(true)
  expect(out.endsWith('#EXTINF:-1,\n/m/c.mp3\n')).toBe(false)
  // songs read from the file are written back as they were
  expect(out).toContain('#EXTINF:12,A\na.mp3\n')
})

test('a rewrite keeps relative paths, empty titles and durations as written', () => {
  const text = '#EXTM3U\n#EXTINF:123,\nmusic/a.mp3\n#EXTINF:45,B\n../b.mp3\n'
  const f = parseList(text, '/lib')
  expect(songsOf(f)).toEqual([song('/lib/music/a.mp3'), song('/b.mp3', 'B')])
  expect(listText(f)).toBe(text)
  expect(listText(toggle(f, [song('/x/c.mp3')], ''))).toBe(text + '/x/c.mp3\n')
})

test('listText adds the header and titles only titled songs', () => {
  const f = { lines: [{ kind: 'song' as const, song: song('/a', 'T') }, { kind: 'song' as const, song: song('/b') }] }
  expect(listText(f)).toBe('#EXTM3U\n#EXTINF:-1,T\n/a\n/b\n')
  expect(listText({ lines: [] })).toBe('#EXTM3U\n')
})

test('toggle adds missing then removes all', () => {
  const a = song('/m/a.mp3')
  const b = song('/m/b.mp3')
  const f = listOf('/m/a.mp3')
  expect(markOf(f, [a, b], '')).toBe('some')
  const g = toggle(f, [a, b], '')
  expect(songsOf(g).map(s => s.path)).toEqual(['/m/a.mp3', '/m/b.mp3'])
  expect(markOf(g, [a, b], '')).toBe('all')
  expect(songsOf(toggle(g, [a, b], ''))).toEqual([])
  expect(markOf(g, [song('/m/z.mp3')], '')).toBe('none')
})

test('never twice', () => {
  const b = song('/m/b.mp3')
  expect(songsOf(toggle({ lines: [] }, [b, b], '')).map(s => s.path)).toEqual(['/m/b.mp3'])
})

test('add and remove report counts and recognise other url forms', () => {
  const f = listOf('https://youtu.be/abc')
  const same = song('https://www.youtube.com/watch?v=abc&list=L')
  expect(addMissing(f, [same, song('/m/x.mp3')], '/h').added).toBe(1)
  expect(removeSongs(f, [same, song('/m/x.mp3')], '/h').removed).toBe(1)
  expect(songsOf(removeSongs(f, [same], '/h').file)).toEqual([])
})

test('moveSongs keeps comments with their song', () => {
  const f = parseList('#EXTM3U\n# one\n/m/a\n# two\n/m/b\n/m/c\n# tail\n', '/m')
  const out = listText(moveSongs(f, [2, 0, 1]))
  expect(out).toBe('#EXTM3U\n/m/c\n# one\n/m/a\n# two\n/m/b\n# tail\n')
})

test('checkName', () => {
  expect(checkName('Road trip', [])).toBe('')
  for (const bad of ['', 'a/b', '.x', 'FAV', 'History', '★ favourites', 'a\u0007'])
    expect(checkName(bad, [])).not.toBe('')
  expect(checkName('road TRIP', ['Road trip'])).not.toBe('')
  expect(checkName('Other', ['Road trip'])).toBe('')
})

test('history skips broken lines', () => {
  const text = '{"at":1,"path":"/a","title":"A"}\nnot json\n{"at":2,"path":"/b","title":"B","artist":"X","duration":9}\n{"at":"x"}\n'
  expect(parseHistory(text)).toEqual([
    { at: 2, path: '/b', title: 'B', artist: 'X', duration: 9 },
    { at: 1, path: '/a', title: 'A' },
  ])
  expect(parseHistory('')).toEqual([])
})

test('whenPlayed boundaries', () => {
  const s = (d: Date) => Math.floor(d.getTime() / 1000)
  const now = s(new Date(2026, 10, 26, 15, 0, 0)) // Thu 26 Nov 2026
  expect(whenPlayed(now - 30, now)).toBe('just now')
  expect(whenPlayed(now - 300, now)).toBe('5 min ago')
  expect(whenPlayed(now - 3 * 3600, now)).toBe('3 h ago')
  expect(whenPlayed(s(new Date(2026, 10, 25, 21, 4)), now)).toBe('yesterday 21:04')
  expect(whenPlayed(s(new Date(2026, 10, 23, 9, 5)), now)).toBe('Mon 09:05')
  expect(whenPlayed(s(new Date(2026, 10, 16, 9, 5)), now)).toBe('2026-11-16')
  // under 7×24 h ago but 7 calendar days back: dated, not a weekday that reads as today
  expect(whenPlayed(s(new Date(2026, 10, 19, 23, 0)), s(new Date(2026, 10, 26, 8, 0)))).toBe('2026-11-19')
})

test('only youtube hosts key by video id', () => {
  const a = songKey('https://example.com/watch?v=1', '/h')
  const b = songKey('https://radio.example.org/s?v=1', '/h')
  expect(a).not.toBe(b)
  expect([a, b]).not.toContain('yt:1')
  expect(songKey('https://m.youtube.com/watch?v=1', '/h')).toBe('yt:1')
})

test('parseList: indented comments, stray EXTINF and header case', () => {
  const f = parseList('  # note\n#EXTINF:-1,Lonely\n#EXTINF:-1,B\n/m/b\n#EXTINF:-1,End\n', '/m')
  expect(songsOf(f)).toEqual([song('/m/b', 'B')])
  expect(f.lines.filter(l => l.kind === 'other').map(l => (l as { text: string }).text)).toEqual([
    '  # note',
    '#EXTINF:-1,Lonely',
    '#EXTINF:-1,End',
  ])
  const g = parseList('\n#extm3u\n/m/a\n', '/m')
  expect(listText(g)).toBe('\n#extm3u\n/m/a\n')
  expect(listText(moveSongs(g, [0]))).toBe('\n#extm3u\n/m/a\n')
})

test('moveSongs never loses or duplicates songs', () => {
  const f = listOf('/m/a', '/m/b', '/m/c')
  const paths = (o: number[]) => songsOf(moveSongs(f, o)).map(s => s.path.slice(3))
  expect(paths([2, 2, 9, -1, 0])).toEqual(['c', 'a', 'b'])
  expect(paths([])).toEqual(['a', 'b', 'c'])
})

test('checkName refuses leading and trailing spaces', () => {
  expect(checkName('Rock ', [])).toMatch(/space/)
  expect(checkName(' Rock', [])).toMatch(/space/)
  expect(checkName('Rock', [])).toBe('')
})

test('checkName refuses names over 200 bytes', () => {
  expect(checkName('a'.repeat(200), [])).toBe('')
  expect(checkName('a'.repeat(201), [])).toBe('That name is too long.')
  expect(checkName('★'.repeat(67), [])).toBe('That name is too long.')
})

test('lines between #EXTINF and its song stay between them on a rewrite', () => {
  const text = '#EXTM3U\n#EXTINF:5,A\n#EXTVLCOPT:x\na.mp3\n#EXTINF:1,orphan\n# note\n#EXTINF:2,B\nb.mp3\n'
  const f = parseList(text, '/m')
  expect(songsOf(f)).toEqual([song('/m/a.mp3', 'A'), song('/m/b.mp3', 'B')])
  expect(listText(f)).toBe(text)
  expect(listText(toggle(f, [song('/c.mp3')], ''))).toBe(text + '/c.mp3\n')
  // a move takes them with the song
  expect(listText(moveSongs(f, [1, 0]))).toBe('#EXTM3U\n#EXTINF:1,orphan\n# note\n#EXTINF:2,B\nb.mp3\n#EXTINF:5,A\n#EXTVLCOPT:x\na.mp3\n')
})

test('placesOf and removeAt act on one copy of a song listed twice', () => {
  const f = parseList('#EXTM3U\n/a.mp3\n/b.mp3\n/a.mp3\n', '/')
  expect(placesOf(f, [{ index: 2, song: song('/a.mp3') }], '')).toEqual([2])
  expect(listText(removeAt(f, placesOf(f, [{ index: 2, song: song('/a.mp3') }], '')).file)).toBe('#EXTM3U\n/a.mp3\n/b.mp3\n')
  // the file changed since: found by song instead, never the same row twice
  expect(placesOf(f, [{ index: 1, song: song('/a.mp3') }, { index: 9, song: song('/a.mp3') }], '')).toEqual([0, 2])
  expect(placesOf(f, [{ index: 0, song: song('/gone.mp3') }], '')).toEqual([])
})

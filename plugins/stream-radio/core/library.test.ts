import { expect, test } from 'claude-code/testing'

import {
  addMissing,
  checkName,
  listText,
  markOf,
  moveSongs,
  parseHistory,
  parseList,
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
  expect(out).toContain('#EXTINF:-1,A\n/m/a.mp3\n')
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
})

import { expect, test } from 'claude-code/testing'

import { completeLines, fit, formatTime, holdTicks, LABEL_COLUMNS, marquee, parseArgs, parseNowPlaying, textWidth, titleColumns } from './nowplaying'

const MARQUEE_HOLD = holdTicks(600)

test('a song title beats the page title', () => {
  const text = 'NP\tlofi radio\tArtist - Song\t\tno\t41.7\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'Artist - Song', isPaused: false, seconds: 41, chapter: null })
})

test('falls back to the media title; takes the last line; reads pause', () => {
  const text = 'NP\told\t\t\tno\t3\rNP\tlofi radio - beats\t\t\tyes\t\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'lofi radio - beats', isPaused: true, seconds: null, chapter: null })
})

test('a cut-off line does not claim to be unpaused', () => {
  expect(parseNowPlaying('NP\tlofi\t\t\t')?.isPaused).toBeNull()
  expect(parseNowPlaying('NP\tlofi\t\t\tyes\t7\r')?.isPaused).toBe(true)
})

test('reads the chapter title from a whole line', () => {
  expect(parseNowPlaying('NP\tAlbum\t\t\tno\t12\t02. Second Song\tEND')?.chapter).toBe('02. Second Song')
  expect(parseNowPlaying('NP\tAlbum\t\t\tno\t12\t\tEND')?.chapter).toBe('')
  // cut off inside the chapter: unknown, not "no chapter"
  expect(parseNowPlaying('NP\tAlbum\t\t\tno\t12\t02. Sec')?.chapter).toBeNull()
})

test('only complete lines are read', () => {
  expect(completeLines('NP\ta\t\t\tno\t1\tEND\nNP\ta\t')).toEqual({
    complete: 'NP\ta\t\t\tno\t1\tEND',
    rest: '\nNP\ta\t',
  })
  // mpv leaves a line unended until the next update: END alone completes it
  expect(completeLines('NP\ta\t\t\tno\t0\tEND')).toEqual({ complete: 'NP\ta\t\t\tno\t0\tEND', rest: '' })
  expect(completeLines('NP\ta')).toEqual({ complete: '', rest: 'NP\ta' })
})

test('ignores other output', () => {
  expect(parseNowPlaying('(+) Audio --aid=1\n')).toBeUndefined()
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

test('a long title rests at its start, then scrolls two characters a tick and loops', () => {
  const text = 'abcdefghij'
  expect(marquee(text, 4, 0)).toBe('abcd')
  expect(marquee(text, 4, MARQUEE_HOLD)).toBe('abcd')
  expect(marquee(text, 4, MARQUEE_HOLD + 1)).toBe('cdef')
  // Past the end, a gap, then the start again.
  expect(marquee(text, 4, MARQUEE_HOLD + 4)).toBe('ij  ')
  // 17 characters round, 2 a tick: 9 ticks moving, then the rest.
  const round = Math.ceil((text.length + '   ·   '.length) / 2) + MARQUEE_HOLD
  expect(marquee(text, 4, round)).toBe('abcd')
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

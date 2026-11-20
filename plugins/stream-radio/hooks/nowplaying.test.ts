import { expect, test } from 'claude-code/testing'

import { parseArgs, parseNowPlaying } from './nowplaying'

test('a song title beats the page title', () => {
  const text = 'NP\tlofi radio\tArtist - Song\t\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'Artist - Song', isSong: true })
})

test('falls back to the media title; takes the last line', () => {
  const text = 'NP\told\t\t\rNP\tlofi radio - beats\t\t\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'lofi radio - beats', isSong: false })
})

test('ignores other output', () => {
  expect(parseNowPlaying('(+) Audio --aid=1\n')).toBeUndefined()
})

test('arguments', () => {
  expect(parseArgs('stop', '')).toEqual({ kind: 'stop' })
  expect(parseArgs('', 'https://a.b/c')).toEqual({ kind: 'play', url: 'https://a.b/c' })
  expect(parseArgs('--script=x', '').kind).toBe('error')
  expect(parseArgs('', '').kind).toBe('error')
})

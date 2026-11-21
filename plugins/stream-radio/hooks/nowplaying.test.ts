import { expect, test } from 'claude-code/testing'

import { completeLines, parseArgs, parseNowPlaying } from './nowplaying'

test('a song title beats the page title', () => {
  const text = 'NP\tlofi radio\tArtist - Song\t\tno\t41.7\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'Artist - Song', isPaused: false, percent: 41 })
})

test('falls back to the media title; takes the last line; reads pause', () => {
  const text = 'NP\told\t\t\tno\t3\rNP\tlofi radio - beats\t\t\tyes\t\r'
  expect(parseNowPlaying(text)).toEqual({ title: 'lofi radio - beats', isPaused: true, percent: null })
})

test('a cut-off line does not claim to be unpaused', () => {
  expect(parseNowPlaying('NP\tlofi\t\t\t')?.isPaused).toBeNull()
  expect(parseNowPlaying('NP\tlofi\t\t\tyes\t7\r')?.isPaused).toBe(true)
})

test('only complete lines are read', () => {
  expect(completeLines('NP\ta\t\t\tno\t1\rNP\ta\t')).toEqual({
    complete: 'NP\ta\t\t\tno\t1\r',
    rest: 'NP\ta\t',
  })
  expect(completeLines('NP\ta')).toEqual({ complete: '', rest: 'NP\ta' })
})

test('ignores other output', () => {
  expect(parseNowPlaying('(+) Audio --aid=1\n')).toBeUndefined()
})

test('arguments', () => {
  expect(parseArgs('stop', '')).toEqual({ kind: 'stop' })
  expect(parseArgs('pause', '')).toEqual({ kind: 'toggle' })
  expect(parseArgs('', 'https://a.b/c')).toEqual({ kind: 'play', url: 'https://a.b/c' })
  expect(parseArgs('--script=x', '').kind).toBe('error')
  expect(parseArgs('', '').kind).toBe('error')
})

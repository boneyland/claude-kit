import { describe, expect, test } from 'vitest'
import type { Queue } from '@core/host'
import { filterFlat, flatRows } from '../src/queue/rows'
import type { Tags } from '../src/media/tags'

const q: Queue = {
  kind: 'playlist',
  items: ['01 Intro', 'Song two', 'Video'],
  paths: ['/h/Music/A/01 Intro.mp3', '/h/Music/A/02.mp3', 'https://www.youtube.com/watch?v=x'],
  root: '',
  current: 0,
}
const none = () => undefined

describe('flatRows', () => {
  test('with no tags: the queue item, its folder with ~, and a URL\'s host', () => {
    expect(flatRows(q, none, '/h')).toEqual([
      { index: 0, number: 1, title: '01 Intro', artist: '', where: '~/Music/A' },
      { index: 1, number: 2, title: 'Song two', artist: '', where: '~/Music/A' },
      { index: 2, number: 3, title: 'Video', artist: '', where: 'youtube.com' },
    ])
  })
  test('with tags: the tag title and artist', () => {
    const tags = (p: string): Tags | undefined =>
      p.endsWith('02.mp3') ? { title: 'Real Title', artist: 'Band', albumArtist: '', album: '' } : undefined
    expect(flatRows(q, tags, '/h')[1]).toMatchObject({ title: 'Real Title', artist: 'Band' })
  })
  test('empty tag title keeps the queue item', () => {
    const tags = () => ({ title: '', artist: 'Band', albumArtist: '', album: '' })
    expect(flatRows(q, tags, '/h')[0]).toMatchObject({ title: '01 Intro', artist: 'Band' })
  })
  test('chapters: no paths, no where', () => {
    const ch: Queue = { kind: 'chapters', items: ['One', 'Two'], paths: [], root: '', current: 1 }
    expect(flatRows(ch, none, '/h').map(r => r.where)).toEqual(['', ''])
  })
  test('filterFlat keeps rows with every word in title, artist or where', () => {
    const rows = flatRows(q, none, '/h')
    expect(filterFlat(rows, 'song').map(r => r.index)).toEqual([1])
    expect(filterFlat(rows, 'music a').map(r => r.index)).toEqual([0, 1])
    expect(filterFlat(rows, 'youtube').map(r => r.index)).toEqual([2])
    expect(filterFlat(rows, '')).toHaveLength(3)
  })
})

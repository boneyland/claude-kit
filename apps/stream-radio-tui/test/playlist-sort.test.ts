import { describe, expect, test } from 'vitest'
import { nextSortField, sortOrder, type SortRow } from '../src/playlist/sort'

const t = (title: string, artist = '', albumArtist = '', album = '') => ({ title, artist, albumArtist, album })
const rows: SortRow[] = [
  { path: '/m/B/10.mp3', title: 'beta', tags: t('beta', 'Zed') },
  { path: '/m/A/2.mp3', title: 'Alpha', tags: t('Alpha', '') },
  { path: '/m/A/10.mp3', title: 'gamma', tags: t('gamma', 'abba') },
  { path: 'https://youtube.com/watch?v=1', title: 'delta' },
]

describe('sortOrder', () => {
  test('by title, case-blind; reversed', () => {
    expect(sortOrder(rows, 'title', false)).toEqual([1, 0, 3, 2])
    expect(sortOrder(rows, 'title', true)).toEqual([2, 3, 0, 1])
  })
  test('by artist: untagged last, both ways round', () => {
    expect(sortOrder(rows, 'artist', false)).toEqual([2, 0, 1, 3])
    expect(sortOrder(rows, 'artist', true)).toEqual([0, 2, 1, 3])
  })
  test('by folder then file name, numbers as numbers', () => {
    expect(sortOrder(rows, 'folder', false)).toEqual([1, 2, 0, 3])
  })
  test('stable: equal keys keep their order', () => {
    const same: SortRow[] = [{ path: '/a', title: 'x' }, { path: '/b', title: 'x' }, { path: '/c', title: 'x' }]
    expect(sortOrder(same, 'title', false)).toEqual([0, 1, 2])
    expect(sortOrder(same, 'title', true)).toEqual([0, 1, 2])
  })
  test('the field cycles title → artist → album artist → album → folder → as queued (none) → title', () => {
    expect([undefined, 'title', 'artist', 'albumArtist', 'album', 'folder'].map(f => nextSortField(f as never))).toEqual([
      'title', 'artist', 'albumArtist', 'album', 'folder', undefined,
    ])
  })
})

import { expect, test } from 'vitest'
import { trackOf } from '../src/ui/hooks'

const queue = (kind: 'playlist' | 'chapters' | 'none', paths: string[], current = 0) => ({ kind, items: paths, paths, current, root: '' })

test("a playlist's current entry is the file", () => {
  expect(trackOf({ queue: queue('playlist', ['/m/a.mp3', '/m/b.mp3'], 1), lastUrl: '/m' })).toEqual({ file: '/m/b.mp3' })
})
test('a single URL with chapters is the URL', () => {
  expect(trackOf({ queue: queue('chapters', []), lastUrl: 'https://youtu.be/tRsQsTMvPNg' })).toEqual({ url: 'https://youtu.be/tRsQsTMvPNg' })
})
test('a single file is the file', () => {
  expect(trackOf({ queue: queue('none', []), lastUrl: '/m/one.flac' })).toEqual({ file: '/m/one.flac' })
})
test('nothing played is nothing', () => {
  expect(trackOf({ queue: queue('none', []), lastUrl: '' })).toEqual({})
})

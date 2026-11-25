import { expect, test } from 'claude-code/testing'

import {
  addEntries,
  arrangementOff,
  EMPTY_QUEUE,
  moveShown,
  nameOf,
  NO_PLACE,
  parsePlace,
  parseStored,
  played,
  removeIds,
  replaceEntry,
  replaceWith,
  shuffleOn,
  sortShown,
  type StoredQueue,
} from './stored'

const songs = (...names: string[]) => names.map(n => ({ path: `/m/${n}.mp3` }))
const names = (q: StoredQueue) => played(q).map(e => e.path.replace(/^\/m\/|\.mp3$/g, ''))
const queued = (q: StoredQueue) => q.entries.map(e => e.path.replace(/^\/m\/|\.mp3$/g, ''))
// a, b, c queued, with the given arrangement
const abc = (arrangement: StoredQueue['arrangement'] = { kind: 'none' }): StoredQueue => ({
  ...replaceWith(EMPTY_QUEUE, songs('a', 'b', 'c'), 'src', '/m'),
  arrangement,
})
const idOf = (q: StoredQueue, name: string) => q.entries.find(e => e.path === `/m/${name}.mp3`)!.id

test('garbage parses to the empty queue', () => {
  for (const text of ['', '{not json', '[1]', 'null', '{"version":1,"entries":"x"}', '{"version":2,"entries":[]}']) {
    expect(parseStored(text)).toEqual(EMPTY_QUEUE)
  }
  const q = abc({ kind: 'shuffle', order: [2, 0, 1] })
  expect(parseStored(JSON.stringify(q))).toEqual(q)
  const bad = abc({ kind: 'shuffle', order: [0, 0] })
  expect(parseStored(JSON.stringify(bad)).arrangement).toEqual({ kind: 'none' })
  const short = abc({ kind: 'sort', field: 'title', isReversed: false, order: [1, 0] })
  expect(parseStored(JSON.stringify(short)).arrangement).toEqual({ kind: 'none' })
  expect(parseStored('{"version":1,"entries":[{"id":1,"path":"x"}]}')).toEqual(EMPTY_QUEUE)
})

test('the place parses, and garbage is no place', () => {
  const place = { rev: 3, current: '3.1', seconds: 12.5 }
  expect(parsePlace(JSON.stringify(place))).toEqual(place)
  expect(parsePlace('')).toEqual(NO_PLACE)
  expect(parsePlace('{"rev":"x","current":4,"seconds":"s"}')).toEqual(NO_PLACE)
  expect(parsePlace('{"rev":2,"current":null,"seconds":-1}')).toEqual({ rev: 2, current: null, seconds: -1 })
})

test('a name is the title, else the file name, else the URL', () => {
  expect(nameOf({ id: '1.0', path: '/m/a.mp3', title: 'Song' })).toBe('Song')
  expect(nameOf({ id: '1.0', path: '/m/dir/a.mp3' })).toBe('a.mp3')
  expect(nameOf({ id: '1.0', path: 'https://x.test/live/' })).toBe('https://x.test/live/')
})

test('ids stay unique across edits', () => {
  const one = replaceWith(EMPTY_QUEUE, songs('a', 'b'), 'src', '/m')
  expect(one.rev).toBe(1)
  expect(one.entries.map(e => e.id)).toEqual(['1.0', '1.1'])
  expect(one.source).toBe('src')
  expect(one.root).toBe('/m')
  const two = addEntries(one, songs('c'), 'end', null)
  expect(two.rev).toBe(2)
  expect(two.entries.map(e => e.id)).toEqual(['1.0', '1.1', '2.0'])
})

test('add next goes after the current one, also when shuffled', () => {
  const q = abc({ kind: 'shuffle', order: [2, 0, 1] })
  const next = addEntries(q, songs('d'), 'next', idOf(q, 'c'))
  expect(names(next)).toEqual(['c', 'd', 'a', 'b'])
  expect(names(arrangementOff(next))).toEqual(['a', 'b', 'c', 'd'])
})

test('add next with no current one goes first', () => {
  expect(names(addEntries(abc(), songs('d'), 'next', null))).toEqual(['d', 'a', 'b', 'c'])
})

test('added while sorted go where added', () => {
  const q = abc({ kind: 'sort', field: 'title', isReversed: true, order: [2, 1, 0] })
  const added = addEntries(q, songs('e'), 'end', null)
  expect(names(added)).toEqual(['c', 'b', 'a', 'e'])
  expect(added.arrangement.kind).toBe('sort')
})

test('shuffle off returns to the queued order', () => {
  const q = abc()
  const shuffled = shuffleOn(q, idOf(q, 'b'), () => 0.5)
  expect(shuffled.rev).toBe(q.rev + 1)
  expect(names(shuffled)[0]).toBe('b')
  expect([...names(shuffled)].sort()).toEqual(['a', 'b', 'c'])
  expect(names(arrangementOff(shuffled))).toEqual(['a', 'b', 'c'])
})

test('shuffle with nothing playing is a plain shuffle', () => {
  const q = abc()
  const shuffled = shuffleOn(q, null, () => 0)
  expect([...names(shuffled)].sort()).toEqual(['a', 'b', 'c'])
  expect(shuffled.arrangement.kind).toBe('shuffle')
})

test('a hand move while shuffled bakes the shown order', () => {
  const q = abc({ kind: 'shuffle', order: [2, 0, 1] })
  expect(names(q)).toEqual(['c', 'a', 'b'])
  const moved = moveShown(q, [1, 0, 2])
  expect(queued(moved)).toEqual(['a', 'c', 'b'])
  expect(moved.arrangement).toEqual({ kind: 'none' })
  expect(moved.rev).toBe(q.rev + 1)
})

test('sort then shuffle replaces the sort; shuffle off goes to queued, not sorted', () => {
  const q = abc()
  const sorted = sortShown(q, 'title', true, [2, 1, 0])
  expect(names(sorted)).toEqual(['c', 'b', 'a'])
  expect(sorted.arrangement).toEqual({ kind: 'sort', field: 'title', isReversed: true, order: [2, 1, 0] })
  const shuffled = shuffleOn(sorted, idOf(sorted, 'a'), () => 0.5)
  expect(shuffled.arrangement.kind).toBe('shuffle')
  expect(names(shuffled)[0]).toBe('a')
  expect(names(arrangementOff(shuffled))).toEqual(['a', 'b', 'c'])
})

test('a sort over a shuffled shown order is stored over the entries', () => {
  const q = abc({ kind: 'shuffle', order: [2, 0, 1] }) // shown c, a, b
  const sorted = sortShown(q, 'title', false, [1, 2, 0]) // a, b, c
  expect(names(sorted)).toEqual(['a', 'b', 'c'])
  expect(queued(sorted)).toEqual(['a', 'b', 'c'])
})

test('remove keeps arrangement consistent', () => {
  const q = abc({ kind: 'sort', field: 'title', isReversed: true, order: [2, 1, 0] })
  const removed = removeIds(q, [idOf(q, 'b')])
  expect(removed.arrangement).toEqual({ kind: 'sort', field: 'title', isReversed: true, order: [1, 0] })
  expect(names(removed)).toEqual(['c', 'a'])
  expect(removed.rev).toBe(q.rev + 1)
  expect(names(removeIds(abc(), [idOf(abc(), 'a'), idOf(abc(), 'c')]))).toEqual(['b'])
})

test("replaceEntry splices mpv's songs in place of one entry", () => {
  const q = { ...replaceWith(EMPTY_QUEUE, songs('a', 'P', 'c'), '', ''), arrangement: { kind: 'none' } as const }
  const spliced = replaceEntry(q, idOf(q, 'P'), songs('x', 'y'))
  expect(names(spliced)).toEqual(['a', 'x', 'y', 'c'])
  expect(spliced.rev).toBe(q.rev + 1)
  expect(spliced.entries.slice(1, 3).map(e => e.id)).toEqual(['2.0', '2.1'])
  expect(new Set(spliced.entries.map(e => e.id)).size).toBe(4)
})

test('replaceEntry keeps the shown order stable under an arrangement', () => {
  const q = abc({ kind: 'sort', field: 'title', isReversed: true, order: [2, 1, 0] }) // c, b, a
  const spliced = replaceEntry(q, idOf(q, 'b'), songs('x', 'y'))
  expect(names(spliced)).toEqual(['c', 'x', 'y', 'a'])
  expect(spliced.arrangement.kind).toBe('sort')
  expect(replaceEntry(q, 'nope', songs('x'))).toBe(q)
})

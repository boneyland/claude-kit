// The play queue the app owns, as plain data and pure edits: what is stored in
// queue.json and queue-place.json, and every change to it. No I/O, no clock, no
// randomness of its own (a shuffle is handed its `random`); core/queue.ts has
// the index work for moving rows, this has the list itself.
import { baseName } from './nowplaying'

// One thing to add to the queue: a file or an http(s) URL (a folder is
// expanded to its songs before it gets here); title names a URL's entry.
export type QueueEntry = { path: string; title?: string }

// An entry in the stored queue. Its id never changes and is never reused, so
// the same song twice is two entries and the current one survives any reorder.
export type StoredEntry = { id: string; path: string; title?: string }

// What is shown and played instead of the queued order, if anything. order[i]:
// the index into entries shown at i.
export type Arrangement =
  | { kind: 'none' }
  | { kind: 'shuffle'; order: number[] }
  | { kind: 'sort'; field: string; isReversed: boolean; order: number[] }

export type StoredQueue = {
  version: 1
  rev: number // +1 on every edit of the list; the place never bumps it
  entries: StoredEntry[] // the queued order: as added and hand-arranged
  arrangement: Arrangement
  root: string // a folder played whole, for grouping; '' none
  source: string // what was played to make this queue, for the "Play last" label
}

// Where the player is in the queue, saved apart so the list stays still. rev is
// the list's rev it refers to; seconds -1 is a live stream.
export type Place = { rev: number; current: string | null; seconds: number }

export const EMPTY_QUEUE: StoredQueue = { version: 1, rev: 0, entries: [], arrangement: { kind: 'none' }, root: '', source: '' }
export const NO_PLACE: Place = { rev: 0, current: null, seconds: -1 }

const NONE: Arrangement = { kind: 'none' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// Every index below `count` exactly once.
function isPermutation(order: unknown, count: number): order is number[] {
  if (!Array.isArray(order) || order.length !== count) return false
  const seen = new Set<number>()
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= count || seen.has(i)) return false
    seen.add(i)
  }
  return true
}

function entryOf(v: unknown): StoredEntry | null {
  if (!isObject(v) || !isString(v.id) || !isString(v.path)) return null
  return isString(v.title) ? { id: v.id, path: v.path, title: v.title } : { id: v.id, path: v.path }
}

function arrangementOf(v: unknown, count: number): Arrangement {
  if (!isObject(v) || !isPermutation(v.order, count)) return NONE
  if (v.kind === 'shuffle') return { kind: 'shuffle', order: v.order }
  if (v.kind === 'sort' && isString(v.field) && typeof v.isReversed === 'boolean') {
    return { kind: 'sort', field: v.field, isReversed: v.isReversed, order: v.order }
  }
  return NONE
}

// Never throws: text that is not a queue is the empty queue, a field of the
// wrong shape is that field of the empty queue, and an order that is not a
// permutation of the entries is no arrangement. A broken file reads as empty.
export function parseStored(text: string): StoredQueue {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return EMPTY_QUEUE
  }
  if (!isObject(v) || v.version !== 1 || !Array.isArray(v.entries)) return EMPTY_QUEUE
  const entries = v.entries.map(entryOf)
  if (entries.some(e => e === null) || new Set(entries.map(e => e!.id)).size !== entries.length) return EMPTY_QUEUE
  return {
    version: 1,
    rev: isNumber(v.rev) && Number.isInteger(v.rev) && v.rev >= 0 ? v.rev : 0,
    entries: entries as StoredEntry[],
    arrangement: arrangementOf(v.arrangement, entries.length),
    root: isString(v.root) ? v.root : '',
    source: isString(v.source) ? v.source : '',
  }
}

export function parsePlace(text: string): Place {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return NO_PLACE
  }
  if (!isObject(v)) return NO_PLACE
  return {
    rev: isNumber(v.rev) && Number.isInteger(v.rev) && v.rev >= 0 ? v.rev : NO_PLACE.rev,
    current: isString(v.current) ? v.current : NO_PLACE.current,
    seconds: isNumber(v.seconds) ? v.seconds : NO_PLACE.seconds,
  }
}

// The indexes into entries in the order they are shown and played.
const shownIndexes = (q: StoredQueue): number[] =>
  q.arrangement.kind === 'none' ? q.entries.map((_, i) => i) : q.arrangement.order

// The entries in the order they are shown and played.
export const played = (q: StoredQueue): StoredEntry[] => shownIndexes(q).map(i => q.entries[i]!)

// What a row shows: the title, else the file name, else the URL.
export function nameOf(e: StoredEntry): string {
  if (e.title) return e.title
  return /^https?:\/\//i.test(e.path) ? e.path : baseName(e.path)
}

const fresh = (add: readonly QueueEntry[], rev: number): StoredEntry[] =>
  add.map((e, i) => ({ id: `${rev}.${i}`, path: e.path, ...(e.title === undefined ? {} : { title: e.title }) }))

// The same arrangement over a changed list; none stays none.
const withOrder = (a: Arrangement, order: number[]): Arrangement => (a.kind === 'none' ? a : { ...a, order })

// What is played to make a new queue: nothing of the old one stays.
export function replaceWith(q: StoredQueue, add: QueueEntry[], source: string, root: string): StoredQueue {
  const rev = q.rev + 1
  return { version: 1, rev, entries: fresh(add, rev), arrangement: NONE, root, source }
}

// Songs added at the end, or right after the current one (first, with none
// current). With an arrangement on they go there in the shown order too, not
// re-sorted or scattered; its order only grows. Off, they sit where they sit in
// the queued order.
export function addEntries(q: StoredQueue, add: QueueEntry[], where: 'end' | 'next', currentId: string | null): StoredQueue {
  const rev = q.rev + 1
  const current = where === 'next' && currentId !== null ? q.entries.findIndex(e => e.id === currentId) : -1
  const at = where === 'end' ? q.entries.length : current + 1 // index in entries
  const entries = [...q.entries.slice(0, at), ...fresh(add, rev), ...q.entries.slice(at)]
  const grown = add.map((_, i) => at + i)
  let arrangement = q.arrangement
  if (arrangement.kind !== 'none') {
    const shifted = arrangement.order.map(i => (i >= at ? i + add.length : i))
    const slot = where === 'end' ? shifted.length : current < 0 ? 0 : arrangement.order.indexOf(current) + 1
    arrangement = withOrder(arrangement, [...shifted.slice(0, slot), ...grown, ...shifted.slice(slot)])
  }
  return { ...q, rev, entries, arrangement }
}

// Entries out; the arrangement keeps its order of the rest.
export function removeIds(q: StoredQueue, ids: readonly string[]): StoredQueue {
  const gone = new Set(ids)
  const newIndex: number[] = []
  const entries: StoredEntry[] = []
  q.entries.forEach((e, i) => {
    newIndex[i] = gone.has(e.id) ? -1 : entries.length
    if (!gone.has(e.id)) entries.push(e)
  })
  const arrangement =
    q.arrangement.kind === 'none' ? q.arrangement : withOrder(q.arrangement, q.arrangement.order.map(i => newIndex[i]!).filter(i => i >= 0))
  return { ...q, rev: q.rev + 1, entries, arrangement }
}

// A hand move: `order` over the shown list becomes the queued order, and the
// arrangement is gone.
export function moveShown(q: StoredQueue, order: readonly number[]): StoredQueue {
  const shown = played(q)
  return { ...q, rev: q.rev + 1, entries: order.map(i => shown[i]!), arrangement: NONE }
}

// The current song first, the rest in random order (Fisher-Yates). Replaces
// any arrangement; with no current song, all of it is random.
export function shuffleOn(q: StoredQueue, currentId: string | null, random: () => number): StoredQueue {
  const first = currentId === null ? -1 : q.entries.findIndex(e => e.id === currentId)
  const rest = q.entries.map((_, i) => i).filter(i => i !== first)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  return { ...q, rev: q.rev + 1, arrangement: { kind: 'shuffle', order: first < 0 ? rest : [first, ...rest] } }
}

// Back to the queued order.
export function arrangementOff(q: StoredQueue): StoredQueue {
  return { ...q, rev: q.rev + 1, arrangement: NONE }
}

// A sort: `order` over the shown list, kept as an order over the entries. It
// replaces a shuffle or an earlier sort.
export function sortShown(q: StoredQueue, field: string, isReversed: boolean, order: readonly number[]): StoredQueue {
  const shown = shownIndexes(q)
  return { ...q, rev: q.rev + 1, arrangement: { kind: 'sort', field, isReversed, order: order.map(i => shown[i]!) } }
}

// mpv expanded one entry (a .cue, say) into songs: they take its place, with
// new ids. Under an arrangement they take its slot in the shown order, in
// sequence, so what is shown stays put. An id that is not there changes nothing.
export function replaceEntry(q: StoredQueue, id: string, withEntries: QueueEntry[]): StoredQueue {
  const at = q.entries.findIndex(e => e.id === id)
  if (at < 0) return q
  const rev = q.rev + 1
  const n = withEntries.length
  const entries = [...q.entries.slice(0, at), ...fresh(withEntries, rev), ...q.entries.slice(at + 1)]
  const grown = withEntries.map((_, i) => at + i)
  const arrangement =
    q.arrangement.kind === 'none'
      ? q.arrangement
      : withOrder(
          q.arrangement,
          q.arrangement.order.flatMap(i => (i === at ? grown : [i > at ? i + n - 1 : i])),
        )
  return { ...q, rev, entries, arrangement }
}

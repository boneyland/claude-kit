import { useMemo, useRef } from 'react'
import type { Host, Queue } from '@core/host'
import { clearQueue, removeFromQueue, reorderQueue, sortQueue, unsortQueue } from '@core/player'
import { moveBy, moveTo, type Moved } from '@core/queue'
import type { TuiConfig } from '../config'
import { useRefState, type View } from '../ui/hooks'
import { clamp, clear, current, remap, targets, type Held, type Selection } from '../ui/selection'
import type { TagBook } from '../ui/tagbook'
import type { Turns } from '../ui/turns'
import { filterFlat, flatRows, type FlatRow } from './rows'
import { nextSortField, sortOrder, type SortField } from './sort'

// The Playlist's rows as a key (see Held): each one's file or URL (a chapter's name), in order.
const keyOf = (queue: Queue, rows: readonly FlatRow[]) => rows.map(r => queue.paths[r.index] || queue.items[r.index]).join('\n')

// The Playlist's last sort, for R and the tab row; no field: as queued.
export type PlaylistSort = { field?: SortField; isReversed: boolean }

export type Playlist = {
  // the rows showing: all of the queue, or what the filter matches
  rows: FlatRow[]
  // the playing song's place in rows; -1 when it isn't showing
  playingRow: number
  // the cursor and picked rows, within rows; with none set, the cursor on the playing song
  sel(): Selection
  // `key`: the rows it is made against; the ones showing unless said
  setSel(sel: Selection | undefined, key?: string): void
  // the first row once the wheel or a click has placed it; undefined keeps
  // the view centred on the cursor, as the keys move it
  top: number | undefined
  setTop(top: number | undefined): void
  sort: PlaylistSort
  // whether the rows are queue entries (not a video's chapters) to edit
  isEditable(): boolean
  // The edits, each in its turn, from the queue as the store has it then:
  // the picked songs (or the cursor's) one place up or down, or above the
  // song at queue index `to` (the queue's length: to the end); the pick follows them.
  move(by: 1 | -1): void
  moveTo(to: number): void
  remove(): void
  // the whole queue (l brings it back), and stop: already confirmed
  clear(): void
  sortNext(): void
  sortReverse(): void
  // the filter is changing: the cursor follows the playing song, the view centres again
  refilter(): void
}

// The Playlist tab's rows, selection, scroll and sort, and its edits.
export function usePlaylist(h: Host, config: TuiConfig, view: View, book: TagBook, home: string, { act, inTurn }: Turns): Playlist {
  const [selRef, setSelState] = useRefState<Held | undefined>(undefined)
  const [sortRef, setSort] = useRefState<PlaylistSort>({ isReversed: false })
  const [topRef, setTop] = useRefState<number | undefined>(undefined)

  // Worked out again only when the queue, the filter or the tags change, not
  // at each second's redraw of the time.
  const q = view.queue
  const filter = view.filter.trim()
  const tagsSeen = book.version()
  const allRows = useMemo(() => flatRows(q, book.get, home), [q, book, home, tagsSeen])
  const rows = useMemo(() => (filter ? filterFlat(allRows, filter) : allRows), [allRows, filter])
  const key = useMemo(() => keyOf(q, rows), [q, rows])
  const playingRow = useMemo(() => rows.findIndex(r => r.index === q.current), [rows, q.current])

  const sel = (): Selection => {
    const at = Math.max(0, playingRow)
    return clamp(current(selRef.current, key) ?? { cursor: at, anchor: at, picked: [] }, rows.length)
  }
  const setSel = (next: Selection | undefined, forKey = key) => setSelState(next && { ...next, forKey })

  // The queue and the rows as the store has them now: an edit's turn may
  // come after an earlier edit changed them.
  const freshRows = async () => {
    const [queue, text] = await Promise.all([h.vars.read('queue'), h.vars.read('filter')])
    const all = flatRows(queue, book.get, home)
    return { queue, rows: text.trim() ? filterFlat(all, text.trim()) : all }
  }
  const moveRows = (make: (count: number, picked: number[]) => Moved) =>
    act(() =>
      inTurn(async () => {
        const { queue, rows } = await freshRows()
        const was = clamp(current(selRef.current, keyOf(queue, rows)) ?? sel(), rows.length)
        const from = targets(was).flatMap(at => (rows[at] ? [rows[at].index] : []))
        if (!from.length) return
        const moved = make(queue.items.length, from)
        if (moved.order.every((old, i) => old === i)) return
        // the rows shown after the move, by their new indexes
        const shownOld = new Set(rows.map(r => r.index))
        const shownNew = moved.order.flatMap((old, i) => (shownOld.has(old) ? [i] : []))
        // the rows as they will be once the move is in the store
        const nameOf = (i: number) => queue.paths[i] || queue.items[i]
        setSel(remap(was, moved.picked.map(n => shownNew.indexOf(n))), shownNew.map(i => nameOf(moved.order[i]!)).join('\n'))
        setTop(undefined)
        return reorderQueue(h, moved.order)
      }),
    )
  // Each sort asked; S pressed four times to reach `album` sorts once, by album.
  const sortSeq = useRef(0)
  // No field: back to the queued order.
  const sortBy = (field: SortField | undefined, isReversed: boolean) => {
    setSort(field ? { field, isReversed } : { isReversed: false })
    const seq = ++sortSeq.current
    act(() =>
      inTurn(async () => {
        if (seq !== sortSeq.current) return
        if (!field) {
          setSel(undefined)
          return unsortQueue(h)
        }
        const queue = await h.vars.read('queue')
        const sortRows = queue.items.map((item, i) => {
          const path = queue.paths[i] ?? ''
          const tags = book.get(path)
          return { path, title: tags?.title || item, tags }
        })
        const unread = field === 'title' || field === 'folder' ? 0 : sortRows.filter(r => r.path.startsWith('/') && !r.tags).length
        // the cursor follows the playing song again, not a place now holding another
        setSel(undefined)
        const reply = await sortQueue(h, field, isReversed, sortOrder(sortRows, field, isReversed))
        return reply || (unread ? `Sorted; ${unread} songs' tags weren't read yet, so they went last.` : '')
      }),
    )
  }
  const isEditable = () => view.queue.kind === 'playlist'

  return {
    rows,
    playingRow,
    sel,
    setSel,
    top: topRef.current,
    setTop,
    sort: sortRef.current,
    isEditable,
    move: by => isEditable() && moveRows((count, from) => moveBy(count, from, by)),
    moveTo: to => isEditable() && moveRows((count, from) => moveTo(count, from, to)),
    remove: () =>
      isEditable() &&
      act(() =>
        inTurn(async () => {
          const { queue, rows } = await freshRows()
          const forKey = keyOf(queue, rows)
          const was = clamp(current(selRef.current, forKey) ?? sel(), rows.length)
          const indexes = targets(was).flatMap(i => (rows[i] ? [rows[i].index] : []))
          if (!indexes.length) return
          setSel(clear(was), forKey)
          return removeFromQueue(h, config, indexes)
        }),
      ),
    clear: () => {
      setSel(undefined)
      setTop(undefined)
      setSort({ isReversed: false })
      act(() =>
        inTurn(() => clearQueue(h, config)),
      )
    },
    sortNext: () => isEditable() && sortBy(nextSortField(sortRef.current.field), false),
    sortReverse: () => isEditable() && sortBy(sortRef.current.field ?? 'title', !sortRef.current.isReversed),
    refilter: () => {
      setSel(undefined)
      setTop(undefined)
    },
  }
}

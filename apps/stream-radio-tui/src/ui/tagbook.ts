import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { Host } from '../../../../plugins/stream-radio/core/host'
import { tagReader, type TagReader, type Tags } from '../media/tags'

// How many files are stat'ed at once for their modification times.
const STATS_AT_ONCE = 32

export type TagBook = {
  // the tags of `path`, once read
  get(path: string): Tags | undefined
  // read the tags of these local files, if not yet read
  need(paths: readonly string[]): void
  // the file's modification time, as a listing found it: saves a stat
  know(path: string, mtimeMs: number): void
}

// One tag reader for the app; the screen redraws as tags arrive.
// `reader` stands in for music-metadata in tests.
export function useTagBook(h: Host, reader?: TagReader): TagBook {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const r = useMemo(() => reader ?? tagReader(), [reader])
  const mtimes = useRef(new Map<string, number>()).current
  // paths being stat'ed or waiting to be, and those that turned out not to be files
  const statting = useRef(new Set<string>()).current
  const notFiles = useRef(new Set<string>()).current
  const waiting = useRef<string[]>([]).current
  const running = useRef(0)
  // files stat'ed since the last hand-over to the reader
  const found = useRef<string[]>([]).current
  useEffect(() => () => r.stop(), [r])
  return useMemo(() => {
    const want = (paths: string[]) => r.want(paths.map(path => ({ path, mtimeMs: mtimes.get(path)! })), redraw)
    // Hands the files found to the reader together, once the stats in flight settle.
    const flush = () => {
      if (running.current > 0 || waiting.length) return
      if (found.length) want(found.splice(0))
    }
    // Stats the waiting paths, STATS_AT_ONCE at a time; each file found is read.
    const pump = () => {
      while (running.current < STATS_AT_ONCE && waiting.length) {
        const p = waiting.shift()!
        running.current++
        void Promise.resolve()
          .then(() => h.fs.stat(p))
          .then(
            s => (s.kind === 'file' ? mtimes.set(p, s.mtimeMs) : notFiles.add(p)),
            () => notFiles.add(p),
          )
          .then(() => {
            running.current--
            statting.delete(p)
            if (mtimes.has(p)) found.push(p)
            // a chunk's worth at a time, so a big queue starts reading before every stat is in
            if (found.length >= STATS_AT_ONCE) want(found.splice(0))
            pump()
            flush()
          })
      }
    }
    return {
      get: path => {
        const m = mtimes.get(path)
        return m === undefined ? undefined : r.get(path, m)
      },
      know: (path, mtimeMs) => void mtimes.set(path, mtimeMs),
      need: paths => {
        const local = paths.filter(p => p.startsWith('/') && !notFiles.has(p))
        const known = local.filter(p => mtimes.has(p))
        if (known.length) want(known)
        const unknown = local.filter(p => !mtimes.has(p) && !statting.has(p))
        unknown.forEach(p => statting.add(p))
        waiting.push(...unknown)
        pump()
      },
    }
  }, [h, r, mtimes, statting, notFiles, waiting, found])
}

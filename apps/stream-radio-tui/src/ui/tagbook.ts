import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { Host } from '../../../../plugins/stream-radio/core/host'
import { tagReader, type TagReader, type Tags } from '../media/tags'

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
  const statting = useRef(new Set<string>()).current
  useEffect(() => () => r.stop(), [r])
  return useMemo(() => {
    const want = (paths: string[]) => r.want(paths.map(path => ({ path, mtimeMs: mtimes.get(path)! })), redraw)
    return {
      get: path => {
        const m = mtimes.get(path)
        return m === undefined ? undefined : r.get(path, m)
      },
      know: (path, mtimeMs) => void mtimes.set(path, mtimeMs),
      need: paths => {
        const local = paths.filter(p => p.startsWith('/'))
        const known = local.filter(p => mtimes.has(p))
        if (known.length) want(known)
        const unknown = local.filter(p => !mtimes.has(p) && !statting.has(p))
        if (!unknown.length) return
        unknown.forEach(p => statting.add(p))
        void Promise.all(
          unknown.map(p =>
            Promise.resolve()
              .then(() => h.fs.stat(p))
              .then(
              s => (s.kind === 'file' ? (mtimes.set(p, s.mtimeMs), p) : undefined),
              () => undefined,
            ),
          ),
        ).then(found => {
          unknown.forEach(p => statting.delete(p))
          const files = found.filter((p): p is string => !!p)
          if (files.length) want(files)
        })
      },
    }
  }, [h, r, mtimes, statting])
}

import { useEffect, useRef } from 'react'
import type { Host } from '@core/host'
import { FAVOURITES, songKey, songsOf } from '@core/library'
import { listMtime, readPlaylist } from '@core/libraryFile'
import { useRefState } from '../ui/hooks'
import { POLL_MS } from './useLibrary'

// Which songs are favourites, for the ★ on rows and on what plays, in every tab.
export type Favourites = {
  // whether the song at `path` (a file or URL in any form) is in Favourites
  has(path: string): boolean
  // reads Favourites again now, as after a toggle from here
  refresh(): void
}

// Favourites' song keys, read again when ★ Favourites.m3u's mtime changes:
// checked every POLL_MS and at each song change (`playing`), the whole time
// the TUI runs. A check is one stat.
export function useFavourites(h: Host, playing: string): Favourites {
  const [keysRef, setKeys] = useRefState<ReadonlySet<string>>(new Set())
  const homeRef = useRef('')
  // the mtime the last read saw; undefined: read again
  const seen = useRef<number | undefined>(undefined)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const check = async () => {
    try {
      // no folder for the library (no home): nothing to read
      if (!(await Promise.resolve().then(() => h.libraryDir()).catch(() => ''))) return
      const mtime = await listMtime(h, FAVOURITES)
      if (mtime === seen.current) return
      const [file, home] = await Promise.all([readPlaylist(h, FAVOURITES), Promise.resolve().then(() => h.home()).catch(() => '')])
      if (!alive.current) return
      seen.current = mtime
      homeRef.current = home
      setKeys(new Set(songsOf(file).map(s => songKey(s.path, home))))
    } catch (error) {
      h.log?.(`stream-radio: could not read ${FAVOURITES}: ${error instanceof Error ? error.message : String(error)}`, 'debug')
    }
  }

  useEffect(() => {
    void check()
    const timer = h.every(POLL_MS, () => void check())
    return () => timer.cancel()
  }, [h])
  useEffect(() => void check(), [playing])

  return {
    has: path => !!path && keysRef.current.has(songKey(path, homeRef.current)),
    refresh: () => {
      seen.current = undefined
      void check()
    },
  }
}

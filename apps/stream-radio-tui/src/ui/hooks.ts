import { useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react'
import { useStdout } from 'ink'
import type { Host, PlayerKeys } from '../../../../plugins/stream-radio/core/host'
import { mpv } from '../../../../plugins/stream-radio/core/player'
import type { Session } from '../session'

const DRAWN = ['playing', 'isPaused', 'elapsed', 'chapter', 'lastUrl', 'queue', 'openFolders', 'filter', 'resumeAt', 'volume', 'repeat', 'isShuffled'] as const

// What the screen draws: the player's state and the session's last message,
// with its count (the same message said again is said anew).
export type View = Pick<PlayerKeys, (typeof DRAWN)[number]> & { status: string; statusSeq: number }

// The player's state, read again at every change; undefined until first read.
export function usePlayer(session: Session, subscribe: (fn: () => void) => () => void): View | undefined {
  const [view, setView] = useState<View>()
  useEffect(() => {
    let isLive = true
    const load = async () => {
      const values = await Promise.all(DRAWN.map(key => session.host.vars.read(key)))
      if (!isLive) return
      setView({ ...(Object.fromEntries(DRAWN.map((key, i) => [key, values[i]])) as Omit<View, 'status' | 'statusSeq'>),
        status: session.status(),
        statusSeq: session.statusSeq(),
      })
    }
    const off = subscribe(() => void load())
    void load()
    return () => {
      isLive = false
      off()
    }
  }, [session, subscribe])
  return view
}

// State that a key handler reads and writes at once: two keys in one stdin
// chunk, or before a redraw, must not both see the value from the last render.
export function useRefState<T>(initial: T): [MutableRefObject<T>, (next: T) => void] {
  const ref = useRef(initial)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  return [
    ref,
    (next: T) => {
      ref.current = next
      redraw()
    },
  ]
}

// The terminal's size, kept current as it is resized.
export function useSize(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = () => setSize(read())
    stdout.on('resize', onResize)
    return () => void stdout.off('resize', onResize)
  }, [stdout])
  return size
}

// A path under the home folder as `~/…`; any other path as it is.
export const tilde = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

// The person's home folder, from the host; '' until known or when unknown.
export function useHome(h: Host): string {
  const [home, setHome] = useState('')
  useEffect(() => {
    let isLive = true
    Promise.resolve()
      .then(() => h.home())
      .then(found => isLive && setHome(found))
      .catch(() => undefined)
    return () => {
      isLive = false
    }
  }, [h])
  return home
}

// The playing file's length in seconds, asked of mpv (the core keeps only
// whether there is one); 0 when unknown or live. A playlist's next title
// arrives while mpv is still opening the file and has no length yet, so it is
// asked again at each position tick until mpv knows it. A live stream has no
// position (elapsed -1), so it is never asked.
export function useDuration(h: Host, playing: string, elapsed: number): number {
  const [known, setKnown] = useState({ title: '', seconds: 0 })
  const duration = known.title === playing ? known.seconds : 0
  useEffect(() => {
    if (!playing || elapsed < 0 || duration > 0) return
    let isLive = true
    mpv(h, ['get_property', 'duration'])
      .then(reply => {
        if (isLive && typeof reply?.data === 'number' && reply.data > 0) setKnown({ title: playing, seconds: reply.data })
      })
      .catch(() => undefined)
    return () => {
      isLive = false
    }
  }, [h, playing, elapsed, duration])
  return duration
}

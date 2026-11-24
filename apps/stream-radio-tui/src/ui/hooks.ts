import { useEffect, useState } from 'react'
import { useStdout } from 'ink'
import type { Host, PlayerKeys } from '../../../../plugins/stream-radio/core/host'
import { mpv } from '../../../../plugins/stream-radio/core/player'
import type { Session } from '../session'

const DRAWN = ['playing', 'isPaused', 'elapsed', 'chapter', 'lastUrl', 'queue', 'openFolders', 'filter', 'resumeAt', 'volume', 'repeat', 'isShuffled'] as const

// What the screen draws: the player's state and the session's last message.
export type View = Pick<PlayerKeys, (typeof DRAWN)[number]> & { status: string }

// The player's state, read again at every change; undefined until first read.
export function usePlayer(session: Session, subscribe: (fn: () => void) => () => void): View | undefined {
  const [view, setView] = useState<View>()
  useEffect(() => {
    let isLive = true
    const load = async () => {
      const values = await Promise.all(DRAWN.map(key => session.host.vars.read(key)))
      if (!isLive) return
      setView({ ...(Object.fromEntries(DRAWN.map((key, i) => [key, values[i]])) as Omit<View, 'status'>), status: session.status() })
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

// The playing file's length in seconds, asked of mpv once per title (the core
// keeps only whether there is one); 0 when unknown or live.
export function useDuration(h: Host, playing: string, hasPosition: boolean): number {
  const [duration, setDuration] = useState(0)
  useEffect(() => {
    setDuration(0)
    if (!playing || !hasPosition) return
    let isLive = true
    mpv(h, ['get_property', 'duration'])
      .then(reply => isLive && setDuration(typeof reply?.data === 'number' ? reply.data : 0))
      .catch(() => undefined)
    return () => {
      isLive = false
    }
  }, [h, playing, hasPosition])
  return duration
}

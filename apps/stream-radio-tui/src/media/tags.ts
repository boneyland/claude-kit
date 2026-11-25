import { parseFile } from 'music-metadata'

// The tags the lists show and sort by; '' for any the file doesn't have.
export type Tags = { title: string; artist: string; albumArtist: string; album: string }

const EMPTY: Tags = { title: '', artist: '', albumArtist: '', album: '' }

// Reads a file's tags without its duration or cover art, which would cost a
// scan of the whole file or a large picture per song.
export async function readTags(path: string): Promise<Tags> {
  const { common } = await parseFile(path, { duration: false, skipCovers: true })
  return {
    title: common.title ?? '',
    artist: common.artist ?? '',
    albumArtist: common.albumartist ?? '',
    album: common.album ?? '',
  }
}

type Want = { path: string; mtimeMs: number }

export type TagReader = {
  // The cached tags of `path`, if they were read from this version of it.
  get(path: string, mtimeMs: number): Tags | undefined
  // Reads the tags of the paths not yet cached, the latest call's first.
  // `onTags` (the latest call's) hears that more tags arrived, at most once per 100 ms.
  want(paths: Want[], onTags: () => void): void
  stop(): void
}

// How many files' tags are kept: about 10 MB at most.
export const TAGS_KEPT = 20_000

// Songs not yet played have no tags from mpv, so the lists read them here,
// a few at a time so a folder of hundreds doesn't open hundreds of files.
// At most `most` files' tags are kept, the least recently used going first.
export function tagReader(read: (path: string) => Promise<Tags> = readTags, limit = 4, most = TAGS_KEPT): TagReader {
  // in order of use, the least recent first
  const cache = new Map<string, { mtimeMs: number; tags: Tags }>()
  const keep = (path: string, hit: { mtimeMs: number; tags: Tags }) => {
    cache.delete(path)
    cache.set(path, hit)
    while (cache.size > most) cache.delete(cache.keys().next().value!)
  }
  const reading = new Set<string>() // path\0mtime being read now
  let queue: Want[] = []
  let running = 0
  let isStopped = false
  let notify: () => void = () => {}
  let lastNotice = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = (w: Want) => `${w.path}\0${w.mtimeMs}`
  const isCached = (w: Want) => cache.get(w.path)?.mtimeMs === w.mtimeMs

  const announce = () => {
    if (isStopped || timer) return
    const wait = lastNotice + 100 - Date.now()
    if (wait <= 0) {
      lastNotice = Date.now()
      notify()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      if (isStopped) return
      lastNotice = Date.now()
      notify()
    }, wait)
  }

  const pump = () => {
    while (!isStopped && running < limit && queue.length) {
      const w = queue.shift()!
      if (isCached(w) || reading.has(key(w))) continue
      running++
      reading.add(key(w))
      read(w.path)
        .catch(() => EMPTY)
        .then(tags => {
          running--
          reading.delete(key(w))
          if (isStopped) return
          keep(w.path, { mtimeMs: w.mtimeMs, tags })
          announce()
          pump()
        })
    }
  }

  return {
    get(path, mtimeMs) {
      const hit = cache.get(path)
      if (hit?.mtimeMs !== mtimeMs) return undefined
      keep(path, hit)
      return hit.tags
    },
    want(paths, onTags) {
      if (isStopped) return
      notify = onTags
      const keys = new Set<string>()
      const fresh = paths.filter(w => {
        const k = key(w)
        if (keys.has(k) || isCached(w) || reading.has(k)) return false
        keys.add(k)
        return true
      })
      queue = [...fresh, ...queue.filter(w => !keys.has(key(w)))]
      pump()
    },
    stop() {
      isStopped = true
      queue = []
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

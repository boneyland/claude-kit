import fs from 'node:fs/promises'
import { artSources, loadArt, type Art, type ArtSource } from './art'
import { cacheDir, keepPruned } from './cache'
import { decodePeaks, type Wave } from './peaks'

// What the screen asks of the files and mpv: a fake in tests.
export type Media = {
  peaks(file: string, signal: AbortSignal): Promise<Wave | undefined>
  art(sources: ArtSource[], signal: AbortSignal): Promise<Art | undefined>
  sources(playing: { file?: string; url?: string }): Promise<ArtSource[]>
  isLocalFile(path: string): Promise<boolean>
}

// player: the mpv the config names, which decodes the art and waveforms too.
export function nodeMedia(env: Record<string, string | undefined>, player: string): Media {
  const cache = cacheDir(env)
  // out of the way, at start and every half hour: the cache keeps under CACHE_MAX_BYTES
  keepPruned(cache)
  return {
    peaks: (file, signal) => decodePeaks(file, { signal, player, cache }),
    art: (sources, signal) => loadArt(sources, { signal, player, cache }),
    sources: playing => artSources(playing),
    isLocalFile: async path => {
      try {
        return (await fs.stat(path)).isFile()
      } catch {
        return false
      }
    },
  }
}

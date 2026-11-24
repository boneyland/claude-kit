import fs from 'node:fs/promises'
import { artSources, loadArt, type Art, type ArtSource } from './art'
import { cacheDir } from './cache'
import { decodePeaks } from './peaks'

// What the screen asks of the files and mpv: a fake in tests.
export type Media = {
  peaks(file: string, signal: AbortSignal): Promise<Uint8Array | undefined>
  art(sources: ArtSource[], signal: AbortSignal): Promise<Art | undefined>
  sources(playing: { file?: string; url?: string }): Promise<ArtSource[]>
  isLocalFile(path: string): Promise<boolean>
}

export function nodeMedia(env: Record<string, string | undefined>): Media {
  const cache = cacheDir(env)
  return {
    peaks: (file, signal) => decodePeaks(file, { signal, cache }),
    art: (sources, signal) => loadArt(sources, { signal, cache }),
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

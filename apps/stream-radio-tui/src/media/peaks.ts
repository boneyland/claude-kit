import fs from 'node:fs/promises'
import { cacheKey, readCache, writeCache } from './cache'
import { runMpv, type Spawn } from './mpv-child'

export const SAMPLE_RATE = 8000
export const PEAKS_PER_SECOND = 50
// A file that takes longer than this to decode gets no waveform.
export const DECODE_TIMEOUT_MS = 300_000

const BUCKET = SAMPLE_RATE / PEAKS_PER_SECOND
const PAGE = 64 * 1024

// Folds s16le mono samples into one peak (0–255) per BUCKET samples as they
// stream in. Only the peaks are kept, never the samples.
export function peakFolder(): { add(chunk: Buffer): void; done(): Uint8Array } {
  const pages: Uint8Array[] = [new Uint8Array(PAGE)]
  let count = 0
  let carry: number | undefined // a byte left from a sample split across chunks
  let peak = 0
  let inBucket = 0
  const push = () => {
    if (count === pages.length * PAGE) pages.push(new Uint8Array(PAGE))
    pages[pages.length - 1][count % PAGE] = Math.min(255, Math.round((peak / 32768) * 255))
    count += 1
    peak = 0
    inBucket = 0
  }
  const sample = (s: number) => {
    const a = Math.abs(s)
    if (a > peak) peak = a
    inBucket += 1
    if (inBucket === BUCKET) push()
  }
  return {
    add(chunk) {
      let i = 0
      if (carry !== undefined && chunk.length > 0) {
        sample(Buffer.from([carry, chunk[0]]).readInt16LE(0))
        carry = undefined
        i = 1
      }
      for (; i + 1 < chunk.length; i += 2) sample(chunk.readInt16LE(i))
      if (i < chunk.length) carry = chunk[i]
    },
    done() {
      if (inBucket > 0) push()
      const out = new Uint8Array(count)
      pages.forEach((page, p) => out.set(page.subarray(0, Math.min(PAGE, count - p * PAGE)), p * PAGE))
      return out
    },
  }
}

// The song's peaks, from the cache or decoded by mpv; undefined when mpv
// can't decode it in time. An abort is passed on.
export async function decodePeaks(file: string, opts: { signal?: AbortSignal; spawn?: Spawn; cache?: string } = {}): Promise<Uint8Array | undefined> {
  const { signal, spawn, cache = '' } = opts
  const stat = await fs.stat(file)
  const name = `${cacheKey('peaks', file, stat.size, stat.mtimeMs)}.peaks`
  const cached = await readCache(cache, name)
  if (cached) return new Uint8Array(cached)
  const folder = peakFolder()
  // The encoder (--o=-) writes raw samples to fd 1 as fast as it decodes.
  // Not --ao=pcm with /dev/stdout: Node's pipe to a child is a socket, and
  // mpv can't open() a socket by that path.
  const args = ['--no-video', '--ytdl=no', '--o=-', '--of=s16le', '--oac=pcm_s16le', '--audio-format=s16', `--audio-samplerate=${SAMPLE_RATE}`, '--audio-channels=mono', '--really-quiet', '--', file]
  try {
    const { code } = await runMpv(args, { signal, spawn, timeoutMs: DECODE_TIMEOUT_MS, maxBytes: Infinity, onData: chunk => folder.add(chunk) })
    if (code !== 0) return undefined
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
  const peaks = folder.done()
  if (peaks.length === 0) return undefined
  await writeCache(cache, name, peaks)
  return peaks
}

// `n` values, each the loudest of its share of `peaks`.
export function resample(peaks: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n)
  const len = peaks.length
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * len) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * len) / n))
    let m = 0
    for (let j = from; j < to && j < len; j++) if (peaks[j] > m) m = peaks[j]
    out[i] = m
  }
  return out
}

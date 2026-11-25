import fs from 'node:fs/promises'
import { cacheKey, readCache, writeCache } from './cache'
import { runMpv, type Spawn } from './mpv-child'

export const SAMPLE_RATE = 8000
export const PEAKS_PER_SECOND = 50
// A file that takes longer than this to decode gets no waveform.
export const DECODE_TIMEOUT_MS = 300_000

const BUCKET = SAMPLE_RATE / PEAKS_PER_SECOND
// Both channels, interleaved; a peak is the louder of the two. Not mono:
// mpv's downmix adds the channels up (about 1.4× for a centred sound), which
// flattened loud songs against the ceiling.
const CHANNELS = 2
const PAGE = 64 * 1024

// A song's waveform, 0–255 of full scale per PEAKS_PER_SECOND step: its
// loudest sample (peak) and its average loudness (rms), drawn as Audacity
// does, the rms inside the peaks.
export type Wave = { peak: Uint8Array; rms: Uint8Array }

const level = (v: number) => Math.min(255, Math.round((v / 32768) * 255))

// Folds s16le samples into one peak and one RMS per `samplesPerPeak` samples
// as they stream in (interleaved channels count each). Only those are kept,
// never the samples.
export function peakFolder(samplesPerPeak = BUCKET): { add(chunk: Buffer): void; done(): Wave } {
  const pages: { peak: Uint8Array; rms: Uint8Array }[] = []
  let count = 0
  let carry: number | undefined // a byte left from a sample split across chunks
  let peak = 0
  let squares = 0
  let inBucket = 0
  const push = () => {
    if (count === pages.length * PAGE) pages.push({ peak: new Uint8Array(PAGE), rms: new Uint8Array(PAGE) })
    const page = pages[pages.length - 1]
    page.peak[count % PAGE] = level(peak)
    page.rms[count % PAGE] = level(Math.sqrt(squares / inBucket))
    count += 1
    peak = 0
    squares = 0
    inBucket = 0
  }
  const sample = (s: number) => {
    const a = Math.abs(s)
    if (a > peak) peak = a
    squares += s * s
    inBucket += 1
    if (inBucket === samplesPerPeak) push()
  }
  const join = (key: 'peak' | 'rms') => {
    const out = new Uint8Array(count)
    pages.forEach((page, p) => out.set(page[key].subarray(0, Math.min(PAGE, count - p * PAGE)), p * PAGE))
    return out
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
      return { peak: join('peak'), rms: join('rms') }
    },
  }
}

// The song's peaks, from the cache or decoded by mpv; undefined when mpv
// can't decode it in time. An abort is passed on.
export async function decodePeaks(file: string, opts: { signal?: AbortSignal; spawn?: Spawn; player?: string; cache?: string } = {}): Promise<Wave | undefined> {
  const { signal, spawn, player, cache = '' } = opts
  const stat = await fs.stat(file)
  // 'wave': peak then rms; the older peaks-only (and clipped mono) files differ
  const name = `${cacheKey('wave', file, stat.size, stat.mtimeMs)}.wave`
  const cached = await readCache(cache, name)
  if (cached && cached.length > 0 && cached.length % 2 === 0) {
    const n = cached.length / 2
    return { peak: new Uint8Array(cached.subarray(0, n)), rms: new Uint8Array(cached.subarray(n)) }
  }
  const folder = peakFolder(BUCKET * CHANNELS)
  // The encoder (--o=-) writes raw samples to fd 1 as fast as it decodes.
  // Not --ao=pcm with /dev/stdout: Node's pipe to a child is a socket, and
  // mpv can't open() a socket by that path.
  const args = ['--no-video', '--ytdl=no', '--o=-', '--of=s16le', '--oac=pcm_s16le', '--audio-format=s16', `--audio-samplerate=${SAMPLE_RATE}`, '--audio-channels=stereo', '--really-quiet', '--', file]
  try {
    const { code } = await runMpv(args, { signal, spawn, player, timeoutMs: DECODE_TIMEOUT_MS, maxBytes: Infinity, onData: chunk => folder.add(chunk) })
    if (code !== 0) return undefined
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
  const wave = folder.done()
  if (wave.peak.length === 0) return undefined
  await writeCache(cache, name, Buffer.concat([wave.peak, wave.rms]))
  return wave
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

// `n` values, each the RMS of its share of `rms` (the average loudness of
// the whole span, where resample keeps its loudest moment).
export function resampleRms(rms: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n)
  const len = rms.length
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * len) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * len) / n))
    let sum = 0
    let k = 0
    for (let j = from; j < to && j < len; j++, k++) sum += rms[j] * rms[j]
    out[i] = k ? Math.round(Math.sqrt(sum / k)) : 0
  }
  return out
}

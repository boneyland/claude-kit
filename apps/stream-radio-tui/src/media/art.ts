import fs from 'node:fs/promises'
import path from 'node:path'
import type { Cell } from '../gfx/probe'
import { cacheKey, readCache, writeCache } from './cache'
import { runMpv, type Spawn } from './mpv-child'

export type ArtSource = { kind: 'file'; path: string } | { kind: 'url'; url: string } | { kind: 'none' }
export type Art = { width: number; height: number; rgba: Uint8Array }

export const COVER_NAMES = ['cover', 'folder', 'front', 'album']
export const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
// Art is kept no bigger than this on its longest side; kitty scales it to the cells.
export const ART_MAX_PX = 600

// A YouTube video's id, or ''.
export function youtubeId(url: string): string {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url)
  return m ? m[1] : ''
}

// Where the playing thing's art may be, best first: a song's own art, then a
// cover image in its folder; a YouTube video's thumbnail (mqdefault: 16:9,
// always there, no black bars). Anything else has none.
export async function artSources(playing: { file?: string; url?: string }, readdir = fs.readdir): Promise<ArtSource[]> {
  if (playing.file) {
    const sources: ArtSource[] = [{ kind: 'file', path: playing.file }]
    const dir = path.dirname(playing.file)
    let names: string[] = []
    try {
      names = (await readdir(dir)) as unknown as string[]
    } catch {
      // an unreadable folder has no cover
    }
    const byLower = new Map(names.map(n => [n.toLowerCase(), n]))
    for (const name of COVER_NAMES)
      for (const ext of COVER_EXTS) {
        const found = byLower.get(name + ext)
        if (found) return [...sources, { kind: 'file', path: path.join(dir, found) }]
      }
    return sources
  }
  const id = playing.url ? youtubeId(playing.url) : ''
  return id ? [{ kind: 'url', url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }] : []
}

// The biggest cols × rows box that keeps the picture's shape on screen.
export function fitArt(img: { width: number; height: number }, maxCols: number, maxRows: number, cell: Cell): { cols: number; rows: number } {
  const aspect = img.width / img.height
  const rowsAtFullWidth = (maxCols * cell.width) / aspect / cell.height
  if (rowsAtFullWidth <= maxRows) return { cols: Math.max(1, maxCols), rows: Math.max(1, Math.floor(rowsAtFullWidth)) }
  return { cols: Math.max(1, Math.min(maxCols, Math.floor((maxRows * cell.height * aspect) / cell.width))), rows: Math.max(1, maxRows) }
}

// The picture trimmed to the exact shape of a cols × rows box of cells,
// evenly from both ends. fitArt rounds the box to whole cells, so this is
// under a cell's worth; without it kitty fits each strip inside its row and
// leaves hairline seams between them.
export function cropToCells(art: Art, cols: number, rows: number, cell: Cell): Art {
  const box = (cols * cell.width) / (rows * cell.height)
  let { width, height } = art
  if (art.width / art.height > box) width = Math.max(1, Math.round(art.height * box))
  else height = Math.max(1, Math.round(art.width / box))
  if (width === art.width && height === art.height) return art
  const x0 = Math.floor((art.width - width) / 2)
  const y0 = Math.floor((art.height - height) / 2)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * art.width + x0) * 4
    rgba.set(art.rgba.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, rgba }
}

// The picture as `rows` strips, top to bottom, one per row of cells.
export function cutRows(art: Art, rows: number): Art[] {
  const line = art.width * 4
  return [...Array(rows).keys()].map(i => {
    const from = Math.floor((i * art.height) / rows)
    const to = Math.floor(((i + 1) * art.height) / rows)
    return { width: art.width, height: to - from, rgba: art.rgba.subarray(from * line, to * line) }
  })
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const PROBE_MS = 15_000

// One source's picture, at most ART_MAX_PX on its longest side; undefined
// when it has none or mpv can't read it.
async function loadOne(source: ArtSource, signal: AbortSignal | undefined, spawn: Spawn | undefined): Promise<Art | undefined> {
  if (source.kind === 'none') return undefined
  const target = source.kind === 'file' ? source.path : source.url
  const common = ['--audio=no', '--frames=1', '--ytdl=no']
  const probe = await runMpv([...common, '--vo=null', '--term-playing-msg=SIZE ${width} ${height}', '--', target], { signal, spawn, timeoutMs: PROBE_MS, maxBytes: 64_000 })
  const size = /^SIZE (\d+) (\d+)$/m.exec(probe.stdout.toString())
  if (probe.code !== 0 || !size) return undefined
  const [w, h] = [Number(size[1]), Number(size[2])]
  if (!(w > 0 && h > 0)) return undefined
  const scale = Math.min(1, ART_MAX_PX / Math.max(w, h))
  const [width, height] = [even(w * scale), even(h * scale)]
  const bytes = width * height * 4
  const raw = await runMpv([...common, `--vf=scale=w=${width}:h=${height},format=rgba`, '--o=-', '--of=rawvideo', '--ovc=rawvideo', '--really-quiet', '--', target], { signal, spawn, timeoutMs: PROBE_MS, maxBytes: bytes })
  if (raw.code !== 0 || raw.stdout.length !== bytes) return undefined
  return { width, height, rgba: new Uint8Array(raw.stdout) }
}

// The first source that has a picture, from the cache or through mpv. A
// failure moves on to the next source; an abort is passed on.
export async function loadArt(sources: ArtSource[], opts: { signal?: AbortSignal; spawn?: Spawn; cache?: string } = {}): Promise<Art | undefined> {
  const { signal, spawn, cache = '' } = opts
  for (const source of sources) {
    if (source.kind === 'none') continue
    let name = ''
    try {
      if (source.kind === 'file') {
        const stat = await fs.stat(source.path)
        name = `${cacheKey('art', source.path, stat.size, stat.mtimeMs)}.art`
      } else name = `${cacheKey('art', source.url)}.art`
      const cached = await readCache(cache, name)
      if (cached && cached.length >= 8) {
        const width = cached.readUInt32LE(0)
        const height = cached.readUInt32LE(4)
        if (cached.length === 8 + width * height * 4) return { width, height, rgba: new Uint8Array(cached.subarray(8)) }
      }
      const art = await loadOne(source, signal, spawn)
      if (!art) continue
      const header = Buffer.alloc(8)
      header.writeUInt32LE(art.width, 0)
      header.writeUInt32LE(art.height, 4)
      await writeCache(cache, name, Buffer.concat([header, art.rgba]))
      return art
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  return undefined
}

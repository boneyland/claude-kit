import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// ${XDG_CACHE_HOME or HOME/.cache}/stream-radio; '' when neither is known.
export function cacheDir(env: Record<string, string | undefined>): string {
  const base = env.XDG_CACHE_HOME || (env.HOME ? `${env.HOME}/.cache` : '')
  return base ? `${base}/stream-radio` : ''
}

export const cacheKey = (...parts: (string | number)[]): string => createHash('sha1').update(parts.join('\0')).digest('hex')

// A hit counts as a use: its time is moved on, so pruneCache keeps it longer.
export async function readCache(dir: string, name: string): Promise<Buffer | undefined> {
  if (!dir) return undefined
  try {
    const file = path.join(dir, name)
    const data = await fs.readFile(file)
    const now = new Date()
    await fs.utimes(file, now, now).catch(() => undefined)
    return data
  } catch {
    return undefined
  }
}

// What the cache may hold before the least recently used files go.
export const CACHE_MAX_BYTES = 200 * 1024 * 1024

// Deletes the least recently used files until the rest fit in `maxBytes`.
// Never throws: a cache that can't be pruned only stays as it is.
export async function pruneCache(dir: string, maxBytes = CACHE_MAX_BYTES): Promise<void> {
  if (!dir) return
  try {
    const names = await fs.readdir(dir)
    const files = []
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name)).catch(() => undefined)
      if (stat?.isFile()) files.push({ name, size: stat.size, used: stat.mtimeMs })
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= maxBytes) break
      await fs.rm(path.join(dir, f.name), { force: true }).catch(() => undefined)
      total -= f.size
    }
  } catch {
    // no folder yet, or not readable
  }
}

// How often a running TUI prunes again: a long session fills the cache too.
export const PRUNE_EVERY_MS = 30 * 60 * 1000

// pruneCache now and every `everyMs` after, until the returned stop is
// called. The timer never keeps the process alive.
export function keepPruned(dir: string, everyMs = PRUNE_EVERY_MS, maxBytes = CACHE_MAX_BYTES): () => void {
  void pruneCache(dir, maxBytes)
  const timer = setInterval(() => void pruneCache(dir, maxBytes), everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

// Never throws: a cache that can't be written only means no cache. Written
// whole, then renamed, so a reader never sees half a file.
export async function writeCache(dir: string, name: string, data: Uint8Array): Promise<void> {
  if (!dir) return
  const temp = path.join(dir, `.${name}.${randomBytes(4).toString('hex')}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(temp, data)
    await fs.rename(temp, path.join(dir, name))
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

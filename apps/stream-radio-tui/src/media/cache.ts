import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// ${XDG_CACHE_HOME or HOME/.cache}/stream-radio; '' when neither is known.
export function cacheDir(env: Record<string, string | undefined>): string {
  const base = env.XDG_CACHE_HOME || (env.HOME ? `${env.HOME}/.cache` : '')
  return base ? `${base}/stream-radio` : ''
}

export const cacheKey = (...parts: (string | number)[]): string => createHash('sha1').update(parts.join('\0')).digest('hex')

export async function readCache(dir: string, name: string): Promise<Buffer | undefined> {
  if (!dir) return undefined
  try {
    return await fs.readFile(path.join(dir, name))
  } catch {
    return undefined
  }
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

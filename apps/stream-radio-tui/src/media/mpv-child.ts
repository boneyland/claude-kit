import { spawn as nodeSpawn } from 'node:child_process'

export type Spawn = typeof nodeSpawn

type Options = {
  signal?: AbortSignal
  timeoutMs: number
  // stdout kept past this kills mpv (Infinity when it is passed on instead)
  maxBytes: number
  // stdout passed on as it comes, not kept
  onData?: (chunk: Buffer) => void
  spawn?: Spawn
}

// A short-lived mpv of the TUI's own (decoding art or audio; not the player).
// It never runs past its timeout, its byte cap or an abort: any of those kills
// it and its process group at once. The person's mpv config is skipped, so a
// script or profile there can't change the output.
export function runMpv(args: string[], opts: Options): Promise<{ code: number | null; stdout: Buffer }> {
  const { signal, timeoutMs, maxBytes, onData, spawn = nodeSpawn } = opts
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('mpv: aborted'))
    const child = spawn('mpv', ['--no-config', ...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const kept: Buffer[] = []
    let size = 0
    let failure: Error | undefined
    const kill = (why: string) => {
      if (failure) return
      failure = new Error(`mpv: ${why}`)
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs)
    const onAbort = () => kill('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return
      if (onData) return onData(chunk)
      size += chunk.length
      if (size > maxBytes) return kill(`more than ${maxBytes} bytes`)
      kept.push(chunk)
    })
    const done = (code: number | null, error?: Error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (failure || error) reject(failure ?? error)
      else resolve({ code, stdout: Buffer.concat(kept) })
    }
    child.on('error', error => done(null, error))
    child.on('close', code => done(code))
  })
}

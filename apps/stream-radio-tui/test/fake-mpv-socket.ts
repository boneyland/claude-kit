import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stand-in for mpv's IPC socket: answers get_property pid with 4242, a
// property named in `props` with its value, and other commands with success, and pushes scripted events once a client observes.
export type Fake = {
  path: string
  // writes these JSON objects, one a line, to every client
  push(...events: unknown[]): void
  // commands received, parsed
  received: unknown[]
  // commands answered with an error, as an older mpv would; none by default
  refuse?: (command: unknown[]) => boolean
  // sees each command answered with success first, to act on it (change `props`)
  onCommand?: (command: unknown[]) => void
  // ms to wait before acting on and answering a command, as a busy mpv (or the
  // mod's process per command) takes; none by default
  delay?: (command: unknown[]) => number
  // ends every connection
  closeClients(): void
  close(): Promise<void>
}

// `inDir`: put mpv.sock there (only the socket is removed on close); else a new temp folder.
export async function fakeMpv(inDir?: string, props: Record<string, unknown> = {}): Promise<Fake> {
  const dir = inDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fake-'))
  const sock = path.join(dir, 'mpv.sock')
  const clients = new Set<net.Socket>()
  const received: unknown[] = []
  const server = net.createServer(c => {
    clients.add(c)
    c.on('close', () => clients.delete(c))
    c.on('error', () => undefined)
    let buf = ''
    c.on('data', d => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines.filter(Boolean)) {
        const msg = JSON.parse(l) as { command: unknown[]; request_id?: number }
        received.push(msg)
        const wait = fake.delay?.(msg.command) ?? 0
        if (wait > 0) setTimeout(() => answer(msg), wait)
        else answer(msg)
      }
    })
    const answer = (msg: { command: unknown[]; request_id?: number }) => {
      if (c.destroyed) return
      // an unrelated event first, to show the reply is matched by request_id
      c.write(JSON.stringify({ event: 'idle' }) + '\n')
      const isRefused = msg.command[0] === 'bad' || !!fake.refuse?.(msg.command)
      if (!isRefused) fake.onCommand?.(msg.command)
      const isGet = msg.command[0] === 'get_property'
      const isPid = isGet && msg.command[1] === 'pid'
      const isProp = isGet && typeof msg.command[1] === 'string' && msg.command[1] in props
      const reply = isPid
        ? { data: 4242, request_id: msg.request_id, error: 'success' }
        : isProp
          ? { data: props[msg.command[1] as string], request_id: msg.request_id, error: 'success' }
        : isRefused
          ? { request_id: msg.request_id, error: 'invalid parameter' }
          : { data: null, request_id: msg.request_id, error: 'success' }
      c.write(JSON.stringify(reply) + '\n')
    }
  })
  await new Promise<void>(res => server.listen(sock, res))
  const fake: Fake = {
    path: sock,
    received,
    push: (...events) => {
      for (const c of clients) for (const e of events) c.write(JSON.stringify(e) + '\n')
    },
    closeClients: () => clients.forEach(c => c.destroy()),
    close: async () => {
      clients.forEach(c => c.destroy())
      await new Promise<void>(res => server.close(() => res()))
      if (inDir) fs.rmSync(sock, { force: true })
      else fs.rmSync(dir, { recursive: true, force: true })
    },
  }
  return fake
}

// Makes `fake` act as mpv on what it is sent, over `props`: properties set,
// lists loaded (append or insert-at), entries moved and removed, and the list
// cleared but for the playing entry (which keeps its mark).
export function actAsMpv(fake: Fake, props: Record<string, unknown>) {
  fake.onCommand = c => {
    const list = props.playlist as { filename: string; current?: boolean }[]
    if (c[0] === 'set_property') props[c[1] as string] = c[2]
    if (c[0] === 'loadlist') {
      const songs = fs.readFileSync(c[1] as string, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(filename => ({ filename }))
      list.splice(c[2] === 'insert-at' ? (c[3] as number) : list.length, 0, ...songs)
    }
    if (c[0] === 'playlist-remove') list.splice(c[1] as number, 1)
    if (c[0] === 'playlist-clear') list.splice(0, list.length, ...list.filter(e => e.current))
    if (c[0] === 'playlist-move') {
      const [j, i] = [c[1] as number, c[2] as number]
      const [moved] = list.splice(j, 1)
      list.splice(j < i ? i - 1 : i, 0, moved!)
    }
  }
}

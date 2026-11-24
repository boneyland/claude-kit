import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stand-in for mpv's IPC socket: answers get_property pid with 4242 and other
// commands with success, and pushes scripted events once a client observes.
export type Fake = {
  path: string
  // writes these JSON objects, one a line, to every client
  push(...events: unknown[]): void
  // commands received, parsed
  received: unknown[]
  // ends every connection
  closeClients(): void
  close(): Promise<void>
}

export async function fakeMpv(): Promise<Fake> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fake-'))
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
        // an unrelated event first, to show the reply is matched by request_id
        c.write(JSON.stringify({ event: 'idle' }) + '\n')
        const isPid = msg.command[0] === 'get_property' && msg.command[1] === 'pid'
        const reply = isPid
          ? { data: 4242, request_id: msg.request_id, error: 'success' }
          : msg.command[0] === 'bad'
            ? { request_id: msg.request_id, error: 'invalid parameter' }
            : { data: null, request_id: msg.request_id, error: 'success' }
        c.write(JSON.stringify(reply) + '\n')
      }
    })
  })
  await new Promise<void>(res => server.listen(sock, res))
  return {
    path: sock,
    received,
    push: (...events) => {
      for (const c of clients) for (const e of events) c.write(JSON.stringify(e) + '\n')
    },
    closeClients: () => clients.forEach(c => c.destroy()),
    close: async () => {
      clients.forEach(c => c.destroy())
      await new Promise<void>(res => server.close(() => res()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

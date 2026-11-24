import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Spawn } from '../src/media/mpv-child'

// A child process that writes `chunks` to stdout then exits with `code`;
// `code` undefined never exits. Records its args and whether it was killed.
export type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; args: string[]; isKilled: boolean; kill(signal?: string): boolean }

export function fakeSpawn(script: (args: string[]) => { chunks?: (Buffer | string)[]; code?: number }) {
  const children: FakeChild[] = []
  const spawn = ((_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      args,
      isKilled: false,
      kill() {
        child.isKilled = true
        setImmediate(() => child.emit('close', null, 'SIGKILL'))
        return true
      },
    }) as FakeChild
    children.push(child)
    const { chunks = [], code } = script(args)
    setImmediate(() => {
      for (const c of chunks) child.stdout.write(typeof c === 'string' ? Buffer.from(c) : c)
      if (code !== undefined) {
        child.stdout.end()
        setImmediate(() => child.emit('close', code, null))
      }
    })
    return child
  }) as unknown as Spawn
  return { spawn, children }
}

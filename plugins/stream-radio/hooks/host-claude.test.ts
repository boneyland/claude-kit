import { expect, test } from 'claude-code/testing'

import { hostOf } from './host-claude'

// A test's `$` is the kit's engine, not a plugin's: the adapter is driven with a
// stub of the few `$` calls it forwards. The atom-backed state store is covered
// by the mod's own tests, which run the player through it.
// The test runtime has timers; the mod's typings don't declare them.
const later = (globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown }).setTimeout
const quiet = { titleChanged: () => undefined, watching: () => undefined }
type Chunk = { stream: 'stdout' | 'stderr'; text: string }

function stub(reply: { exitCode: number; stdout: string }, chunks: Chunk[] = []) {
  const ran: string[][] = []
  const spawned: string[][] = []
  const $ = {
    plugin: { root: '/plug' },
    process: {
      run: async (argv: readonly string[]) => (ran.push([...argv]), { ...reply, stderr: '' }),
      spawn: ({ argv }: { argv: readonly string[] }) => {
        spawned.push([...argv])
        return (async function* () {
          for (const c of chunks) yield c
        })()
      },
    },
  }
  return { h: hostOf($ as never, {} as never, quiet), ran, spawned }
}

test('ipc runs mpv-ipc.py with the command, as the mod always has', async () => {
  const { h, ran } = stub({ exitCode: 0, stdout: '4242' })
  expect(await h.ipc('/tmp/s.sock', ['get_property', 'pid'])).toEqual({ data: 4242 })
  expect(ran[0]).toEqual(['python3', '-I', '/plug/hooks/mpv-ipc.py', '/tmp/s.sock', '["get_property","pid"]'])
})

test('ipc is undefined when nothing listens', async () => {
  const { h } = stub({ exitCode: 1, stdout: '' })
  expect(await h.ipc('/tmp/none.sock', ['get_property', 'pid'])).toBeUndefined()
})

test('watch yields the watcher stdout and skips stderr', async () => {
  const { h, spawned } = stub({ exitCode: 0, stdout: '' }, [
    { stream: 'stdout', text: '{"event":"start-file"}\n' },
    { stream: 'stderr', text: 'noise' },
    { stream: 'stdout', text: '{"event":"file-loaded"}\n' },
  ])
  const chunks: string[] = []
  for await (const text of h.watch('/tmp/s.sock', ['pause'])) chunks.push(text)
  expect(chunks.join('')).toBe('{"event":"start-file"}\n{"event":"file-loaded"}\n')
  expect(spawned[0]).toEqual(['python3', '-I', '/plug/hooks/mpv-ipc.py', '/tmp/s.sock', '--watch', '["pause"]'])
})

test('return() ends the watch at once, while it waits on a quiet player', async () => {
  let returned = false
  const quietStream = {
    next: () => new Promise<never>(() => undefined), // a paused player: no next chunk, ever
    return: async () => ((returned = true), { done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this
    },
  }
  const $ = { plugin: { root: '/plug' }, process: { spawn: () => quietStream } }
  const watch = hostOf($ as never, {} as never, quiet).watch('/tmp/s.sock', ['pause'])
  void watch.next()
  const done = await Promise.race([watch.return(undefined).then(() => 'returned'), new Promise(r => later(() => r('stuck'), 200))])
  expect(done).toBe('returned')
  expect(returned).toBe(true)
})

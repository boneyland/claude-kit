import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, INTENT, PLACE, QUEUE_JSON } from './fake-mpv'

const URL = 'https://example.com/live'
const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const

// The shared player, playing a live stream until the test ends it.
function engine(on: On, clock: { now: () => number }, saved?: Record<string, unknown>) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  return fakeMpv(on, { title: 'Lofi radio', now: () => clock.now(), saved })
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never
type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const footer = async ($: Api) => {
  const ui = await $.ui.mount(FOOTER)
  const label = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}

test('a stream that drops starts again after a wait', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(world.launches.length).toBe(1)

  world.end()
  await clock.advance(10)
  expect(await footer($)).toBe('♪ reconnecting in 2 s…')
  await clock.advance(2000)
  expect(world.launches.length).toBe(2)
  expect(await footer($)).toBe('♪ Lofi radio')

  world.end('quit')
  await clock.advance(20_000)
  expect(world.launches.length).toBe(2)
})

test('three drops in a row and it gives up', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  for (const wait of [2000, 5000, 15_000]) {
    world.end()
    await clock.advance(wait + 10)
  }
  expect(world.launches.length).toBe(4)
  world.end()
  await clock.advance(30_000)
  expect(world.launches.length).toBe(4)
  expect(world.toasts.at(-1)).toBe('stream stopped; gave up after 3 tries')
})

test('a minute of steady playing starts the tries over', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end()
  await clock.advance(2010)
  world.end()
  await clock.advance(5010)
  expect(world.launches.length).toBe(3)
  // Playing steadily for a minute, then a drop: the first, short wait again.
  await clock.advance(61_000)
  world.end()
  await clock.advance(2010)
  expect(world.launches.length).toBe(4)
  world.end('quit')
  await clock.advance(10)
})

test('stopping while it waits, or a playlist finishing with repeat off, does not reconnect', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock, { repeat: 'off' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end('eof')
  await clock.advance(20_000)
  expect(world.launches.length).toBe(1)

  await $.command.run({ command: 'stream', args: 'repeat all' } as never)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.end()
  await clock.advance(10)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(20_000)
  expect(world.launches.length).toBe(2)
  expect(await footer($)).toBe('▶ Play radio')
})

test('a drop after the queue was emptied does not leave reconnecting… up', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  // another program empties the queue (its player would follow; this one drops)
  const q = JSON.parse(world.files[QUEUE_JSON]!)
  world.files[QUEUE_JSON] = JSON.stringify({ ...q, rev: q.rev + 1, entries: [] })
  world.end()
  await clock.advance(10)
  expect(await footer($)).toBe('♪ reconnecting in 2 s…')
  await clock.advance(2010)
  expect(world.launches.length).toBe(1)
  expect((await footer($)) ?? '').not.toContain('reconnecting')
})

test("a player another session replaced leaves that session's place alone", async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, clock)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  // another session starts something new: its intent first, its queue's place,
  // then it ends the old player
  world.files[INTENT] = JSON.stringify({ id: 'other', url: 'https://example.com/new', client: '', isStopped: false, attempt: 0, playedAt: 0 })
  const theirs = JSON.stringify({ rev: 9, current: '9.0', seconds: 0 })
  world.files[PLACE] = theirs
  world.end('quit')
  await clock.advance(10)
  expect(world.files[PLACE]).toBe(theirs)
})

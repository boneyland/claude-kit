import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, INTENT, LOCK, SOCK, type FakeOptions } from './fake-mpv'

// One mpv shared by every session: these tests play one session against a
// player that others start, pause, stop or reconnect, through the same socket
// and data folder.

const URL = 'https://example.com/live'
const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

function session(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.end', () => ({ sessionId: 'test' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
}

type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const footer = async ($: Api) => {
  const ui = await $.ui.mount(FOOTER)
  const label = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}
const stopped = (url: string) => JSON.stringify({ id: 'x', url, client: '', isStopped: true, attempt: 0, playedAt: 1 })

test('a start launches one detached player on the shared socket; another start replaces it', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on, { title: 'Lofi radio' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(world.launches).toHaveLength(1)
  expect(world.launches[0]).toContain(`--input-ipc-server=${SOCK}`)
  expect(world.sent).toContainEqual(['set_property', 'user-data/stream-radio/url', URL])
  expect(await footer($)).toBe('♪ Lofi radio')

  await $.command.run({ command: 'stream', args: 'https://example.com/other' } as never)
  await clock.advance(10)
  expect(world.sent).toContainEqual(['quit'])
  expect(world.launches).toHaveLength(2)
  expect(world.isRunning).toBe(true)
  expect(world.watching()).toBe(1)
  // Replaced, not dropped: no reconnect of the first.
  await clock.advance(20_000)
  expect(world.launches).toHaveLength(2)

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a session started later follows the playing player; its pause pauses it', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on)
  // Started by another session, playing for a minute and a half.
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')
  expect(world.launches).toHaveLength(1)

  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'pause' } as never))).toContain('Toggled pause')
  expect(world.sent).toContainEqual(['set_property', 'pause', true])
  await clock.advance(10)
  expect(await footer($)).toBe('⏸ Lofi radio')

  // Resumed from elsewhere: the footer follows the player.
  world.set('pause', false)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')

  world.end('quit')
  await clock.advance(10)
})

test('stopped from another session: the footer goes idle and nothing reconnects', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on, { title: 'Lofi radio' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')

  // Another session's stop: marked stopped, then the player quits.
  world.files[INTENT] = stopped(URL)
  world.end('quit')
  await clock.advance(10)
  expect(await footer($)).toBe('▶ Play radio')
  await clock.advance(30_000)
  expect(world.launches).toHaveLength(1)
})

test('stop here marks the player stopped for every session and quits it', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on)
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
  expect(world.sent).toContainEqual(['quit'])
  expect(world.isRunning).toBe(false)
  expect(JSON.parse(world.files[INTENT]!)).toMatchObject({ url: URL, isStopped: true })
  expect(await footer($)).toBe('▶ Play radio')
})

test('the session ending leaves the player playing; the next session follows it', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on, { title: 'Lofi radio' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)

  expect(world.watching()).toBe(1)
  await $.session.end({ reason: 'other' } as never)
  await clock.advance(10)
  expect(world.isRunning).toBe(true)
  expect(world.sent).not.toContainEqual(['quit'])
  // Its watcher is gone, though the quiet player sent it nothing to end on.
  expect(world.watching()).toBe(0)

  // A new session (or this one reloaded) attaches instead of starting another.
  await $.session.start(start)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')
  expect(world.launches).toHaveLength(1)

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('an idle session finds a player another session started', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on)
  await $.session.start(start)
  await clock.advance(10)
  expect(await footer($)).toBe(undefined)

  world.play(URL, { title: 'Claude FM' })
  await clock.advance(3000)
  expect(await footer($)).toBe('♪ Claude FM')
  expect(world.launches).toHaveLength(1)

  world.end('quit')
  await clock.advance(10)
})

test('a drop reconnects from one session only: the one holding the lock', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on, { now: () => clock.now() })
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)

  // Another session took the lock first: this one leaves the reconnect to it.
  world.files[LOCK] = 'other'
  world.end()
  await clock.advance(20_000)
  expect(world.launches).toHaveLength(1)
  expect(await footer($)).toBe('▶ Play radio')

  // That session's new player is found.
  world.play(URL, { title: 'Lofi radio' })
  await clock.advance(3000)
  expect(await footer($)).toBe('♪ Lofi radio')
  delete world.files[LOCK]

  // Dropped again, with the lock free: this session reconnects, and lets go of it.
  world.end()
  await clock.advance(10)
  expect(await footer($)).toBe('♪ reconnecting in 2 s…')
  expect(world.files[LOCK]).toBeTruthy()
  await clock.advance(2000)
  expect(world.launches).toHaveLength(3)
  expect(world.urls[2]).toBe(URL)
  await clock.advance(10)
  expect(world.files[LOCK]).toBe(undefined)

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('volume and repeat set elsewhere show here', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on)
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)

  world.set('volume', 30)
  world.set('loop-file', 'inf')
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Volume 30%' })).toBeTruthy()
  expect((await pane.find({ type: 'Button', key: 'repeat' }))?.props.label).toBe('🔂 Repeat: one (r)')
  await pane.unmount()

  world.end('quit')
  await clock.advance(10)
})

test('a file loaded before the watcher began still counts as played: the reconnect lets go of the lock', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  session(on)
  const world = fakeMpv(on, { title: 'one.flac', loadsBeforeWatch: true, now: () => clock.now() })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(JSON.parse(world.files[INTENT]!).playedAt).toBeGreaterThan(0)

  world.end()
  await clock.advance(2010)
  expect(world.launches).toHaveLength(2)
  await clock.advance(10)
  expect(world.files[LOCK]).toBe(undefined)
  expect(JSON.parse(world.files[INTENT]!)).toMatchObject({ attempt: 1 })

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a session whose watcher ends while the player plays on does not reconnect', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const world = fakeMpv(on)
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)
  // The watcher dies (killed), the player answers still.
  world.end()
  world.isRunning = true
  await clock.advance(10)
  expect(world.files[LOCK]).toBe(undefined)
  // Followed again at the next look.
  await clock.advance(3000)
  expect(await footer($)).toBe('♪ Lofi radio')
  expect(world.launches).toHaveLength(1)

  world.end('quit')
  await clock.advance(10)
})

test('a start that cannot find the player goes back to following the one still playing', async ($, on) => {
  const clock = mock.clock(on)
  session(on)
  const options: FakeOptions = {}
  const world = fakeMpv(on, options)
  world.play(URL, { title: 'Lofi radio' })
  await $.session.start(start)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')

  const launched = world.launches.length
  options.noPlayer = true
  await $.command.run({ command: 'stream', args: 'https://example.com/other' } as never)
  await clock.advance(10)
  expect(world.isRunning).toBe(true)
  await clock.advance(3000)
  expect(await footer($)).toBe('♪ Lofi radio')
  expect(world.launches).toHaveLength(launched)

  world.end('quit')
  await clock.advance(10)
})

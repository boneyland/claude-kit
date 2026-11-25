import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const VIDEOS = ['a', 'b', 'c'].map(v => ({ url: `https://www.youtube.com/watch?v=${v}`, title: v.toUpperCase() }))
const LISTING = JSON.stringify({ title: 'Mix', entries: VIDEOS })
const LIST = 'https://www.youtube.com/playlist?list=PL1'

type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const footer = async ($: Api) => {
  const ui = await $.ui.mount(FOOTER)
  const label = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}

// The shared player, with a yt-dlp whose listing comes when the test says.
function engine(on: On, more: Parameters<typeof fakeMpv>[1] = {}) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  const listings: ((stdout: string) => void)[] = []
  const world = fakeMpv(on, {
    title: 'Lofi radio',
    ...more,
    run: argv => (argv[0] === 'yt-dlp' ? new Promise(resolve => listings.push(stdout => resolve({ exitCode: 0, stdout }))) : undefined),
  })
  // answers the listing waiting longest
  const answer = (stdout = LISTING) => listings.shift()?.(stdout)
  return Object.assign(world, { answer })
}
const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

test('a video link in a playlist shows loading… while it is listed, then starts at that video', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://www.youtube.com/watch?v=b&list=PL1' } as never)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ loading…')
  expect(world.launches).toHaveLength(0)
  world.answer()
  await clock.advance(10)
  expect(world.launches.at(-1)).toContain('--playlist-start=1')
  expect(world.urls.at(-1)).toBe('https://www.youtube.com/watch?v=b')
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a play that comes to nothing takes loading… down again', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { exists: () => true, stat: () => ({ kind: 'dir' }), list: () => [] })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: '/m/empty' } as never)
  await clock.advance(10)
  expect(world.toasts).toContain('Nothing to play in /m/empty.')
  expect(await footer($)).toBe(undefined)

  // while something plays, its title comes back
  await $.command.run({ command: 'stream', args: 'https://example.com/live' } as never)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')
  await $.command.run({ command: 'stream', args: '/m/empty' } as never)
  await clock.advance(10)
  expect(await footer($)).toBe('♪ Lofi radio')
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test("the panel's field does not wait for a listing", async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  const pane = await $.ui.mount(PANE)
  let isDone = false
  const typed = pane.input({ key: 'url', text: LIST }).then(() => (isDone = true))
  await clock.advance(10)
  expect(isDone).toBe(true)
  expect(await footer($)).toBe('♪ loading…')
  world.answer()
  await typed
  await clock.advance(10)
  expect(world.launches).toHaveLength(1)
  await pane.unmount()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('Play default (d) does not wait for a listing', { options: { defaultUrl: LIST } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  const pane = await $.ui.mount(PANE)
  let isDone = false
  const pressed = pane.press({ key: 'play-default' }).then(() => (isDone = true))
  await clock.advance(10)
  expect(isDone).toBe(true)
  world.answer()
  await pressed
  await clock.advance(10)
  expect(world.launches).toHaveLength(1)
  await pane.unmount()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('/stream last on an empty queue does not wait for the default to be listed', { options: { defaultUrl: LIST } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  let reply: unknown
  const ran = $.command.run({ command: 'stream', args: 'last' } as never).then(r => (reply = r))
  await clock.advance(10)
  expect(JSON.stringify(reply)).toContain(`Starting ${LIST}.`)
  world.answer()
  await ran
  await clock.advance(10)
  expect(world.launches).toHaveLength(1)
  expect(world.urls.at(-1)).toBe(VIDEOS[0]!.url)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

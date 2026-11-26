// What the review of the app-owned queue (PR #18) found, each held here.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, INTENT, QUEUE_JSON, QUEUE_M3U } from './fake-mpv'

const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const
const VIDEOS = ['a', 'b', 'c'].map(v => ({ url: `https://www.youtube.com/watch?v=${v}`, title: v.toUpperCase() }))
const LISTING = JSON.stringify({ title: 'Mix', entries: VIDEOS })
const LIST = 'https://www.youtube.com/playlist?list=PL1'
const LIVE = 'https://example.com/live'

type Api = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const footer = async ($: Api) => {
  const ui = await $.ui.mount(FOOTER)
  const label = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string | undefined
  await ui.unmount()
  return label
}

function engine(on: On, more: Parameters<typeof fakeMpv>[1] = {}) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  return fakeMpv(on, { title: 'Lofi radio', ...more })
}
const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

test('/stream on a folder that cannot be listed says why, not only Starting', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, {
    exists: () => true,
    stat: () => ({ kind: 'dir' }),
    list: () => {
      throw new Error('EACCES: permission denied')
    },
  })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: '/m/locked' } as never)
  await clock.advance(10)
  expect(world.toasts.some(t => t.startsWith('stream-radio failed:'))).toBe(true)
  expect(world.launches).toHaveLength(0)
})

test('a reconnect while a playlist is listed does not drop the play asked for', async ($, on) => {
  const clock = mock.clock(on)
  const listings: ((stdout: string) => void)[] = []
  const world = engine(on, {
    now: () => clock.now(),
    run: argv => (argv[0] === 'yt-dlp' ? new Promise(resolve => listings.push(stdout => resolve({ exitCode: 0, stdout }))) : undefined),
  })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: LIVE } as never)
  await clock.advance(10)
  expect(world.launches).toHaveLength(1)

  await $.command.run({ command: 'stream', args: LIST } as never)
  await clock.advance(10)
  // the stream drops while yt-dlp lists, and this session starts it again
  world.end()
  await clock.advance(2010)
  expect(world.launches).toHaveLength(2)

  listings.shift()?.(LISTING)
  await clock.advance(10)
  expect(world.launches).toHaveLength(3)
  expect(world.urls.at(-1)).toBe(VIDEOS[0]!.url)
  expect(JSON.parse(world.files[QUEUE_JSON]!).source).toBe(LIST)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a queue file that cannot be written leaves nothing connecting, and says so', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, {
    run: argv => (argv[0] === 'mv' && argv[3] === QUEUE_M3U ? Promise.resolve({ exitCode: 1, stdout: '' }) : undefined),
  })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: LIVE } as never)
  await clock.advance(10)
  expect(world.launches).toHaveLength(0)
  expect(world.toasts.some(t => t.includes('could not write the queue file'))).toBe(true)
  // idle again: Play, not connecting…
  expect(await footer($)).toBe('▶ Play radio')
  // no session reconnects to it
  expect(JSON.parse(world.files[INTENT]!).isStopped).toBe(true)
})

test("an upgrade keeps the place inside a saved YouTube playlist", async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, {
    loadsBeforeWatch: true,
    run: argv => (argv[0] === 'yt-dlp' ? Promise.resolve({ exitCode: 0, stdout: LISTING }) : undefined),
    // mpv named the video otherwise than the listing does
    saved: { last: { url: LIST, resumeAt: { url: LIST, index: 2, seconds: 80, title: 'C', path: 'https://youtube.com/watch?v=c' } }, knownDefault: { mod: '' } },
  })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'last' } as never)
  await clock.advance(10)
  await clock.advance(10)
  expect(JSON.parse(world.files[QUEUE_JSON]!).entries.map((e: { path: string }) => e.path)).toEqual(VIDEOS.map(v => v.url))
  expect(world.launches[0]).toContain('--playlist-start=2')
  expect(world.sent).toContainEqual(['seek', 80, 'absolute'])
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

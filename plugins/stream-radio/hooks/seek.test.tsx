import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

// A five-minute video 42 seconds in (the watcher reports only that it has an
// end; asked, mpv gives the length); with no position, a live stream.
function engine(on: On, props: Record<string, unknown> = { 'time-pos': 42, duration: true }) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  return fakeMpv(on, {
    title: 'A talk',
    props,
    onCommand: c => (c[0] === 'get_property' && c[1] === 'duration' && props.duration ? { data: 300 } : undefined),
  })
}

const say = async ($: Parameters<Parameters<typeof test>[1]>[0], args: string) =>
  JSON.stringify(await $.command.run({ command: 'stream', args } as never))

test('/stream seek jumps to a time, or back and ahead from where it is', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/talk' } as never)
  await clock.advance(10)

  expect(await say($, 'seek 1:30')).toContain('At 1:30.')
  expect(world.sent).toContainEqual(['seek', 90, 'absolute'])
  expect(await say($, 'seek +10')).toContain('At 1:40.')
  expect(world.sent).toContainEqual(['seek', 100, 'absolute'])
  expect(await say($, 'seek -5:00')).toContain('At 0:00.')
  expect(world.sent).toContainEqual(['seek', 0, 'absolute'])
  // a second short of the end, so the song isn't skipped
  expect(await say($, 'seek 9:00')).toContain('At 4:59.')
  expect(await say($, 'seek soon')).toContain('Usage: /stream seek')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('/stream seek says why when there is nothing to seek in', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, {})
  await $.session.start(start)
  expect(await say($, 'seek 1:00')).toContain('Nothing is playing.')
  await $.command.run({ command: 'stream', args: 'https://example.com/live' } as never)
  await clock.advance(10)
  expect(await say($, 'seek +10')).toContain('Nothing to seek in.')

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('the panel jumps back and ahead 10 seconds', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/talk' } as never)
  await clock.advance(10)

  const pane = await $.ui.mount(PANE)
  // b and f press them while the panel has the keyboard
  const back = await pane.find({ type: 'Button', key: 'seek-back' })
  const ahead = await pane.find({ type: 'Button', key: 'seek-ahead' })
  expect([back?.props.label, back?.props.hotkey]).toEqual(['⏪ 10s (b)', 'b'])
  expect([ahead?.props.label, ahead?.props.hotkey]).toEqual(['(f) 10s ⏩', 'f'])
  await pane.press({ key: 'seek-ahead' })
  expect(world.sent).toContainEqual(['seek', 52, 'absolute'])
  await pane.press({ key: 'seek-back' })
  expect(world.sent).toContainEqual(['seek', 42, 'absolute'])
  await pane.unmount()

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

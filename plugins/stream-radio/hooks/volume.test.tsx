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

function engine(on: On, store: Record<string, unknown>) {
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  const world = fakeMpv(on, { title: 'Lofi' })
  return Object.assign(world, { spawned: world.launches })
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never

test('the panel turns the playing volume up and down, and remembers it', { options: { volume: 60 } }, async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  const world = engine(on, store)
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/live' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--volume=60')

  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Volume 60%' })).toBeTruthy()
  await pane.press({ key: 'vol-up' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['set_property', 'volume', 65])
  const again = await $.ui.mount(PANE)
  expect(await again.find({ type: 'Text', text: 'Volume 65%' })).toBeTruthy()
  await again.unmount()
  expect(store.volume).toEqual({ value: 65, configured: 60 })

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('/stream vol sets, steps and clamps the volume', { options: { volume: 60 } }, async ($, on) => {
  mock.clock(on)
  engine(on, {})
  await $.session.start(start)
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'vol 30' } as never))).toContain('Volume 30%')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'vol up' } as never))).toContain('Volume 35%')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'volume 150' } as never))).toContain('Volume 100%')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'vol' } as never))).toContain('Volume 100%')
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'vol loud' } as never))).toContain('Usage: /stream vol')
})

test('a new session starts at the saved volume, unless the setting changed', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { volume: { value: 35, configured: 60 } })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/live' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--volume=35')
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a changed Volume setting wins over the saved volume', { options: { volume: 80 } }, async ($, on) => {
  mock.clock(on)
  engine(on, { volume: { value: 35, configured: 60 } })
  await $.session.start(start)
  expect(JSON.stringify(await $.command.run({ command: 'stream', args: 'vol' } as never))).toContain('Volume 80%')
})

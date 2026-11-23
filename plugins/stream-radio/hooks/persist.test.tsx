import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

const URL = 'https://example.com/list'
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The engine with a store that outlives the session, over the shared player.
function engine(on: On, store: Record<string, unknown>) {
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  return fakeMpv(on, { title: 'Winter Wonderland', props: { 'time-pos': 95, duration: true } })
}

test('a new session offers to resume what an earlier one played', { options: { defaultUrl: URL } }, async ($, on) => {
  mock.clock(on)
  const store: Record<string, unknown> = {
    last: { url: URL, resumeAt: { url: URL, index: 2, seconds: 80, title: 'Winter Wonderland' }, knownDefault: URL },
  }
  engine(on, store)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'play-last' }))?.props.label).toBe('▶ Resume Winter Wonderland at 1:20')
  await pane.unmount()
})

test('playing saves the URL and where it got to; stopping saves at once', { options: { defaultUrl: URL } }, async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  const world = engine(on, store)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(store.last).toMatchObject({ url: URL, resumeAt: { url: URL, seconds: 95, title: 'Winter Wonderland' } })
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
  expect(store.last).toMatchObject({ url: URL })
})

test('a changed default stream forgets the saved one', { options: { defaultUrl: 'https://example.com/new' } }, async ($, on) => {
  mock.clock(on)
  const store: Record<string, unknown> = {
    last: { url: URL, resumeAt: { url: URL, index: 2, seconds: 80, title: 'Winter Wonderland' }, knownDefault: URL },
  }
  engine(on, store)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'play-last' })).toBe(undefined)
  await pane.unmount()
  expect(store.last).toMatchObject({ url: '', knownDefault: 'https://example.com/new' })
})

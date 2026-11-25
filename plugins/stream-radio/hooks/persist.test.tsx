import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, PLACE, QUEUE_JSON } from './fake-mpv'

const URL = 'https://example.com/list'
const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The engine over the shared player, with what state.json holds at the start.
function engine(on: On, saved?: Record<string, unknown>) {
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  return fakeMpv(on, { title: 'Winter Wonderland', props: { 'time-pos': 95, duration: true }, saved })
}

// A queue of three songs from URL, as an earlier session left it.
const SONGS = ['Santa Baby', 'Jingle Bells', 'Winter Wonderland']
const QUEUE = JSON.stringify({
  version: 1,
  rev: 1,
  entries: SONGS.map((title, i) => ({ id: `1.${i}`, path: `${URL}/${i}`, title })),
  arrangement: { kind: 'none' },
  root: '',
  source: URL,
})

test('a new session offers to resume where the queue got to', { options: { defaultUrl: URL } }, async ($, on) => {
  mock.clock(on)
  const world = engine(on, { knownDefault: { mod: URL } })
  world.files[QUEUE_JSON] = QUEUE
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.2', seconds: 80 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  const last = await pane.find({ type: 'Button', key: 'play-last' })
  expect([last?.props.label, last?.props.hotkey]).toEqual(['▶ Resume Winter Wonderland at 1:20 (l)', 'l'])
  await pane.unmount()
})

test('a default stream other than the last gets its button, d', { options: { defaultUrl: 'https://example.com/default' } }, async ($, on) => {
  mock.clock(on)
  engine(on, { last: { url: URL, resumeAt: { url: URL, index: 2, seconds: 80, title: 'Winter Wonderland' } } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  const play = await pane.find({ type: 'Button', key: 'play-default' })
  expect([play?.props.label, play?.props.hotkey]).toEqual(['Play default (d)', 'd'])
  await pane.unmount()
})

test('playing saves the queue and where it got to; stopping saves at once', { options: { defaultUrl: URL } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  const queue = JSON.parse(world.files[QUEUE_JSON]!)
  expect(queue).toMatchObject({ source: URL, entries: [{ path: URL }] })
  expect(JSON.parse(world.files[PLACE]!)).toEqual({ rev: queue.rev, current: queue.entries[0].id, seconds: 95 })
  // within the 10 s between saves: only a stop saves this at once
  world.set('time-pos', 100)
  await clock.advance(10)
  expect(JSON.parse(world.files[PLACE]!).seconds).toBe(95)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
  expect(JSON.parse(world.files[PLACE]!).seconds).toBe(100)
  // the queue stays; state.json no longer keeps the last URL
  expect(JSON.parse(world.files[QUEUE_JSON]!)).toEqual(queue)
  expect(world.saved()?.last ?? null).toBe(null)
})

test('a changed default stream leaves the queue', { options: { defaultUrl: 'https://example.com/new' } }, async ($, on) => {
  mock.clock(on)
  const world = engine(on, { knownDefault: { mod: URL } })
  world.files[QUEUE_JSON] = QUEUE
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.2', seconds: 80 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'play-last' }))?.props.label).toBe('▶ Resume Winter Wonderland at 1:20 (l)')
  await pane.unmount()
  expect(world.saved()).toMatchObject({ knownDefault: { mod: 'https://example.com/new' } })
  expect(world.files[QUEUE_JSON]).toBe(QUEUE)
  expect(JSON.parse(world.files[PLACE]!)).toEqual({ rev: 1, current: '1.2', seconds: 80 })
})

test('the first start without state.json brings over what the store held', { options: { defaultUrl: URL } }, async ($, on) => {
  mock.clock(on)
  const store: Record<string, unknown> = {
    last: { url: URL, resumeAt: { url: URL, index: -1, seconds: 80, title: 'Winter Wonderland' }, knownDefault: URL },
    volume: { value: 35, configured: 60 },
    repeat: 'one',
  }
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  const world = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'play-last' }))?.props.label).toBe('▶ Resume Winter Wonderland at 1:20 (l)')
  await pane.unmount()
  expect(world.saved()).toEqual({
    version: 1,
    last: { url: URL, resumeAt: { url: URL, index: -1, seconds: 80, title: 'Winter Wonderland' } },
    knownDefault: { mod: URL },
    migrated: { mod: true },
    volume: { value: 35, configured: { mod: 60 } },
    repeat: 'one',
  })
})

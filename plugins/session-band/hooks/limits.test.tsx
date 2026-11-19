import { expect, test } from 'claude-code/testing'

const BAND = (bodyColumns: number) =>
  ({
    plugin: 'session-band',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as const

const NOW = Date.parse('2026-11-02T10:00:00Z')

const seed = {
  stats: { turn: 3, speed: 80, turnCost: 0.12, total: 1.5, context: 40, costAtStart: 1.38 },
  cache: { expiresAt: null, secondsLeft: null },
  isHidden: false,
  effort: 'high',
  limits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-02T12:10:00Z' },
    { kind: 'seven_day', percentUsed: 91, resetsAt: '2026-11-05T10:00:00Z' },
  ],
} as Record<string, unknown>

test('the band shows the 5-hour and weekly limits, with resets when wide', async ($, on) => {
  on('state.get', (_, e) => (e.key in seed ? { value: { value: seed[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))

  const wide = await $.ui.mount(BAND(120))
  expect((await wide.find({ type: 'Text', text: '5h' }))?.text).toBe('5h')
  expect((await wide.find({ type: 'Text', text: '24%' }))?.text).toBe('24%')
  expect((await wide.find({ type: 'Text', text: '91%' }))?.text).toBe('91%')
  expect((await wide.find({ type: 'Text', text: /↻2h10m/ }))?.text).toBe('↻2h10m')
  expect((await wide.find({ type: 'Text', text: /↻3d/ }))?.text).toBe('↻3d')
  expect((await wide.find({ type: 'Text', text: 'sonnet-5-5' }))?.text).toBe('sonnet-5-5')
  expect((await wide.find({ type: 'Text', text: '· high' }))?.text).toBe('· high')
  await wide.unmount()

  const narrow = await $.ui.mount(BAND(70))
  expect((await narrow.find({ type: 'Text', text: '91%' }))?.text).toBe('91%')
  expect(await narrow.find({ type: 'Text', text: /↻/ })).toBe(undefined)
  await narrow.unmount()
})

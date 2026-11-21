import { expect, test } from 'claude-code/testing'

const BAND = (bodyColumns: number) =>
  ({
    plugin: 'turn-gauge',
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

test('the band takes its background from the setting, the terminal\'s by default', async ($, on) => {
  on('state.get', (_, e) => (e.key in seed ? { value: { value: seed[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  const ui = await $.ui.mount(BAND(120))
  expect((await ui.find({ key: 'band' }))?.props.backgroundColor).toBe(undefined)
  await ui.unmount()
})

test('a set background paints the band', { options: { background: '#1e2430' } }, async ($, on) => {
  on('state.get', (_, e) => (e.key in seed ? { value: { value: seed[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  const ui = await $.ui.mount(BAND(120))
  expect((await ui.find({ key: 'band' }))?.props.backgroundColor).toBe('#1e2430')
  await ui.unmount()
})

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const seedIcons = (on: On) => {
  on('state.get', (_, e) => (e.key in seed ? { value: { value: seed[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
}

test('the terminal draws emoji icons and a context bar when wide', async ($, on) => {
  seedIcons(on)
  const wide = await $.ui.mount(BAND(120))
  expect(await wide.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await wide.find({ type: 'Text', text: '💰' }))?.text).toBe('💰')
  expect((await wide.find({ type: 'Text', text: '⏳' }))?.text).toBe('⏳')
  expect((await wide.find({ type: 'Text', text: '████' }))?.props.color).toBe('#4caf6e')
  expect((await wide.find({ type: 'Text', text: '░░░░░░' }))?.props.color).toBe('#4caf6e')
  await wide.unmount()

  const narrow = await $.ui.mount(BAND(90))
  expect(await narrow.find({ key: 'context-bar' })).toBe(undefined)
  expect((await narrow.find({ type: 'Text', text: '40%' }))?.text).toBe('40%')
  await narrow.unmount()
})

test('the terminal draws glyphs when set', { options: { terminalIcons: 'glyphs' } }, async ($, on) => {
  seedIcons(on)
  const ui = await $.ui.mount(BAND(120))
  expect((await ui.find({ type: 'Text', text: '$' }))?.text).toBe('$')
  expect((await ui.find({ type: 'Text', text: '⧗' }))?.text).toBe('⧗')
  expect(await ui.find({ type: 'Text', text: '💰' })).toBe(undefined)
  await ui.unmount()
})

test('the desktop draws its ring icons', async ($, on) => {
  seedIcons(on)
  const ui = await $.ui.mount({ ...BAND(120), surface: 'desktop' } as never)
  expect((await ui.findAll({ type: 'Svg' })).length > 0).toBe(true)
  expect(await ui.find({ type: 'Text', text: '💰' })).toBe(undefined)
  await ui.unmount()
})

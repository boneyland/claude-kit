import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-20T10:00:00Z')
const H = 3600_000

const band = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'turn-gauge',
    component: 'AbovePrompt',
    surface,
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as never

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const seed = (on: On) => {
  const state: Record<string, unknown> = {
    stats: { turn: 12, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, recentCosts: [0.1, 0.2, 0.3] },
    cache: { expiresAt: NOW + 50 * 60_000, secondsLeft: 3000 },
    isHidden: false,
    limits: [
      { kind: 'five_hour', percentUsed: 24, resetsAt: new Date(NOW + 2 * H).toISOString() },
      { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 72 * H).toISOString() },
    ],
    tokens: { input: 1_200_000, output: 34_000, turn: { uncached: 0, read: 0, write: 0, output: 0, missed: 0 }, last: null, prevContext: null, prevModel: null, cause: null, lastCause: null, dismissedTurn: -1 },
  }
  on('state.get', (_, e) => ({ value: { value: state[e.key], version: 1 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
}

const has = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], surface: 'terminal' | 'desktop', columns: number, text: string | RegExp) => {
  const ui = await $.ui.mount(band(surface, columns))
  const found = (await ui.find({ type: 'Text', text })) !== undefined
  await ui.unmount()
  return found
}

test('a wide band shows everything; a narrower one drops details rather than running off', async ($, on: On) => {
  seed(on)
  expect(await has($, 'terminal', 160, 'Turn')).toBe(true)
  expect(await has($, 'terminal', 160, /^↻/)).toBe(true)
  expect(await has($, 'terminal', 160, 'Σ')).toBe(true)
  // Too narrow for the resets and tokens, still wide enough for the turn and limits.
  expect(await has($, 'terminal', 70, /^↻/)).toBe(false)
  expect(await has($, 'terminal', 70, 'Σ')).toBe(false)
  expect(await has($, 'terminal', 70, '5h')).toBe(true)
  // The context reading stays at any width.
  expect(await has($, 'terminal', 30, '15%')).toBe(true)
})

test('the desktop app\'s pixel icons count: it drops details at a width the terminal would fit', async ($, on: On) => {
  seed(on)
  let terminalFull = 0
  let desktopFull = 0
  for (let c = 60; c <= 200; c++) {
    if (!terminalFull && (await has($, 'terminal', c, /^↻/))) terminalFull = c
    if (!desktopFull && (await has($, 'desktop', c, /^↻/))) desktopFull = c
  }
  expect(terminalFull).toBeGreaterThan(0)
  expect(desktopFull).toBeGreaterThan(terminalFull)
})

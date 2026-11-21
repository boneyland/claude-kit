import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'turn-gauge',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
} as const

const NOW = Date.parse('2026-11-05T10:00:00Z')

test('a restarted session draws its saved band before its next answer', async ($, on) => {
  const store: Record<string, unknown> = {
    'session:local_abc': { turn: 7, total: 2.5, speed: 90, context: 33, expiresAt: NOW + 20 * 60_000 },
    limits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-05T12:00:00Z' },
      // Reset since it was saved: drawn as 0%.
      { kind: 'seven_day', percentUsed: 80, resetsAt: '2026-11-04T10:00:00Z' },
    ],
  }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_, e) => (delete store[e.key], { value: undefined }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? 'local_abc' : undefined }))
  on('session.id', () => ({ value: 'engine-id' }))
  // A fresh launch: the engine's cost counts from here, no limits read yet.
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('command.register', () => ({ value: { command: 'turn-gauge' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: '7' }))?.text).toBe('7')
  expect((await ui.find({ type: 'Text', text: '$2.50' }))?.text).toBe('$2.50')
  expect((await ui.find({ type: 'Text', text: '40%' }))?.text).toBe('40%')
  expect((await ui.find({ type: 'Text', text: /^0%$/ }))?.text).toBe('0%')
  expect((await ui.find({ type: 'Text', text: '33%' }))?.text).toBe('33%')
  await ui.unmount()
})

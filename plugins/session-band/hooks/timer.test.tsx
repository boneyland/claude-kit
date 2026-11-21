import { expect, mock, test } from 'claude-code/testing'

const BAND = (isWorking: boolean) =>
  ({
    plugin: 'session-band',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as const

const NOW = Date.parse('2026-11-20T10:00:00Z')

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const engine = (on: On) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'session_data' } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const shown = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0], isWorking: boolean, text: string) => {
  const ui = await $.ui.mount(BAND(isWorking))
  const found = (await ui.find({ type: 'Text', text }))?.text
  await ui.unmount()
  return found
}

test('the turn timer and cache countdown move a minute at a time, then stop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await shown($, true, '<1m')).toBe('<1m')
  await clock.advance(59_000)
  expect(await shown($, true, '<1m')).toBe('<1m')
  await clock.advance(2_000)
  expect(await shown($, true, '1m')).toBe('1m')
  await clock.advance(60 * 60_000)
  expect(await shown($, true, '1h01m')).toBe('1h01m')

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await shown($, false, '60m')).toBe('60m')
  // The finished turn's length stays, and stops moving.
  expect(await shown($, false, '1h01m')).toBe('1h01m')
  // Rounded up: 59m 30s left still reads 60m.
  await clock.advance(30_000)
  expect(await shown($, false, '60m')).toBe('60m')
  await clock.advance(31_000)
  expect(await shown($, false, '59m')).toBe('59m')
  await clock.advance(59 * 60_000)
  expect(await shown($, false, 'expired')).toBe('expired')
  expect(await shown($, false, '1h01m')).toBe('1h01m')

  // The next turn starts its own count.
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await shown($, true, '<1m')).toBe('<1m')
  expect(await shown($, true, '1h01m')).toBe(undefined)
})

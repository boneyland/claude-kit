import { expect, test } from 'claude-code/testing'

import { accuracy, addSample, checkpoint, describe, describeAccuracy, project, runOutWarning, span, when, type PaceWindow } from './pace'

const H = 3600_000
const D = 24 * H
// Fri 2026-11-20 10:00 UTC.
const NOW = Date.parse('2026-11-20T10:00:00Z')

test('times read as today\'s clock, or the weekday', () => {
  expect(when(NOW + 2 * H, NOW, 0)).toBe('12:00')
  expect(when(NOW + 3 * D + 5 * H, NOW, 0)).toBe('Mon 15:00')
  // UTC+8: 18:00 the same day.
  expect(when(NOW, NOW, 480)).toBe('18:00')
  expect(span(3 * D)).toBe('3d')
  expect(span(2 * H + 10 * 60_000)).toBe('2h10m')
})

test('readings: kept once per change, a new reset time starts a window and scores the old', () => {
  const r1 = addSample(null, 'seven_day', NOW + 5 * D, NOW, 10)
  expect(r1.window.samples).toEqual([[NOW, 10]])
  // Unchanged a minute later: not kept; a moved reading is.
  expect(addSample(r1.window, 'seven_day', NOW + 5 * D, NOW + 60_000, 10).isChanged).toBe(false)
  const r2 = addSample(r1.window, 'seven_day', NOW + 5 * D + 30_000, NOW + 60_000, 11)
  expect(r2.window.samples.length).toBe(2)
  // A stale session's reading of the window before: dropped.
  expect(addSample(r2.window, 'seven_day', NOW - 2 * D, NOW + 2 * 60_000, 80).isChanged).toBe(false)
  // The week reset: the old window is finished at its highest reading.
  const w = { ...r2.window, checks: { '50': { blend: 60, linear: 40 } } }
  const r3 = addSample(w, 'seven_day', NOW + 12 * D, NOW + 6 * D, 2)
  expect(r3.finished).toEqual({ kind: 'seven_day', resetsAt: NOW + 5 * D, final: 11, checks: { '50': { blend: 60, linear: 40 } } })
  expect(r3.window).toEqual({ resetsAt: NOW + 12 * D, samples: [[NOW + 6 * D, 2]], checks: {} })
})

// A week 3 days in (resets in 4), 30% used: 10%/day on average.
const week = (samples: [number, number][]): PaceWindow => ({ resetsAt: NOW + 4 * D, samples, checks: {} })

test('a steady pace projects the same either way', () => {
  const steady = week([[NOW - 3 * D, 0], [NOW - 2 * D, 10], [NOW - D, 20], [NOW, 30]])
  const p = project('seven_day', steady, NOW)!
  expect(Math.round(p.projected)).toBe(70)
  expect(Math.round(p.linear)).toBe(70)
  expect(p.runOutAt).toBe(null)
  expect(Math.round(p.fraction * 100)).toBe(43)
})

test('a faster last day pulls the blend up, and names when it runs out', () => {
  // 30% of it in the last day.
  const busy = week([[NOW - 3 * D, 0], [NOW - D - H, 0], [NOW, 30]])
  const p = project('seven_day', busy, NOW)!
  // Recent 30%/day, average 10%/day: 0.6*30 + 0.4*10 = 22%/day; 4 days left.
  expect(Math.round(p.projected)).toBe(118)
  expect(Math.round(p.linear)).toBe(70)
  // 70 points at 22/day: 3.18 days, Mon 14:21.
  expect(when(p.runOutAt!, NOW, 0)).toBe('Mon 14:21')
  expect(runOutWarning(p, NOW, 0)?.text).toBe("Heads up: at this pace you'll hit the weekly limit Mon 14:21, 20h before it resets")
})

test('idle since the last reading slows the recent pace', () => {
  // 30% by two days ago, nothing since.
  const idle = week([[NOW - 3 * D, 0], [NOW - 2 * D, 30]])
  const p = project('seven_day', idle, NOW)!
  expect(Math.round(p.projected)).toBe(46)
})

test('too early in a window says nothing; the 5-hour window too', () => {
  expect(project('seven_day', { resetsAt: NOW + 7 * D - 2 * H, samples: [[NOW, 3]], checks: {} }, NOW)).toBe(null)
  // 2h into 5h, 40% used, 25% of it in the last hour.
  const five: PaceWindow = { resetsAt: NOW + 3 * H, samples: [[NOW - 2 * H, 0], [NOW - H, 15], [NOW, 40]], checks: {} }
  const p = project('five_hour', five, NOW)!
  // Recent 25/h, average 20/h: 23/h for 3h → 109%.
  expect(Math.round(p.projected)).toBe(109)
  expect(runOutWarning(p, NOW, 0)?.text).toBe("Heads up: at this pace you'll hit the 5-hour limit 12:36, 23m before it resets")
})

test('marks are noted once, near a quarter, half and three quarters through', () => {
  const steady = week([[NOW - 3 * D, 0], [NOW, 30]])
  const p = project('seven_day', steady, NOW)!
  // 43% through: past the 25% mark by more than its slack, short of 50%.
  expect(checkpoint(steady, p).checks).toEqual({})
  const at50 = project('seven_day', steady, NOW + 0.6 * D)!
  const noted = checkpoint(steady, at50)
  expect(Object.keys(noted.checks)).toEqual(['50'])
  expect(checkpoint(noted, at50)).toBe(noted)
})

test('accuracy: the mean miss of each model, over 100 counted as 100', () => {
  const history = [
    { kind: 'seven_day' as const, resetsAt: 1, final: 80, checks: { '50': { blend: 90, linear: 60 } } },
    { kind: 'seven_day' as const, resetsAt: 2, final: 100, checks: { '50': { blend: 130, linear: 70 } } },
    { kind: 'five_hour' as const, resetsAt: 3, final: 10, checks: { '25': { blend: 50, linear: 50 } } },
  ]
  expect(accuracy(history, 'seven_day').find(r => r.mark === '50')).toEqual({ mark: '50', windows: 2, blend: 5, linear: 25 })
  expect(describeAccuracy(history, 'seven_day')).toBe(
    'weekly accuracy (mean miss in points; blend vs straight line):\n  at 50% through: ±5.0 vs ±25.0  (2 windows)',
  )
  expect(describeAccuracy([], 'five_hour')).toBe('5-hour accuracy: no finished window scored yet.')
  expect(describe(null, 'five_hour', NOW, 0)).toBe('5-hour: too early in the window, or no readings yet.')
})

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const BAND = {
  plugin: 'session-band',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 140, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
} as const

test('the band shows each window\'s projection and a heads-up that can be dismissed', async ($, on: On) => {
  const busy = week([[NOW - 3 * D, 0], [NOW - D - H, 0], [NOW, 30]])
  const state: Record<string, unknown> = {
    stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38 },
    cache: { expiresAt: NOW + 50 * 60_000, secondsLeft: 3000 },
    isHidden: false,
    limits: [
      { kind: 'five_hour', percentUsed: 5, resetsAt: new Date(NOW + 4 * H).toISOString() },
      { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * D).toISOString() },
    ],
    pace: { windows: { seven_day: busy }, dismissed: '' },
  }
  let version = 1
  on('state.get', (_, e) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_, e) => ((state[e.key] = e.value), { value: { isSet: true, version: ++version } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: '→100%+' }))?.props.color).toBe('#e0846b')
  expect((await ui.find({ type: 'Text', text: /^Heads up/ }))?.text).toMatch(/weekly limit/)
  await ui.press({ key: 'dismiss-pace' })
  await ui.unmount()
  expect((state.pace as { dismissed: string }).dismissed).toBe(`seven_day:${NOW + 4 * D}`)
  const again = await $.ui.mount(BAND)
  expect(await again.find({ type: 'Text', text: /^Heads up/ })).toBe(undefined)
  // The projection stays beside the limit.
  expect(await again.find({ type: 'Text', text: '→100%+' })).toBeTruthy()
  await again.unmount()
})

test('live readings are saved for every session, and a reset scores the window', async ($, on: On) => {
  const store: Record<string, unknown> = {}
  let now = NOW
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  const measure = async (pct: number, resetsAt: number) =>
    $.session.measure({
      changed: ['rateLimits'],
      rateLimits: [{ kind: 'seven_day', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }],
    } as never)

  const reset1 = NOW + 3.5 * D
  await measure(40, reset1)
  now += 3 * H
  await measure(42, reset1)
  const kept = store['pace:seven_day'] as PaceWindow
  expect(kept.samples).toEqual([[NOW, 40], [NOW + 3 * H, 42]])
  // Half through when read: the 50% mark is noted.
  expect(kept.checks['50']).toBeTruthy()

  // The week resets: scored against its highest reading.
  now = reset1 + H
  await measure(1, reset1 + 7 * D)
  expect(store['pace-history']).toEqual([{ kind: 'seven_day', resetsAt: reset1, final: 42, checks: kept.checks }])
  expect((store['pace:seven_day'] as PaceWindow).samples).toEqual([[now, 1]])
})

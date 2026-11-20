import { expect, test } from 'claude-code/testing'

import { accuracy, addSample, checkpoint, describe, describeAccuracy, learnWeek, project, runOutWarning, span, when, type PaceWindow } from './pace'

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
  const w = { ...r2.window, checks: { '50': { smooth: 60, linear: 40 } } }
  const r3 = addSample(w, 'seven_day', NOW + 12 * D, NOW + 6 * D, 2)
  expect(r3.finished).toEqual({ kind: 'seven_day', resetsAt: NOW + 5 * D, final: 11, checks: { '50': { smooth: 60, linear: 40 } } })
  expect(r3.window).toEqual({ resetsAt: NOW + 12 * D, samples: [[NOW + 6 * D, 2]], checks: {} })
})

// A week 3 days in (resets in 4), 30% used: 10%/day on average.
const week = (samples: [number, number][]): PaceWindow => ({ resetsAt: NOW + 4 * D, samples, checks: {} })
const NONE = { prev: null, profile: null, offsetMinutes: 0 }

test('a steady pace projects the same smoothed or straight', () => {
  const steady = week([[NOW - 2 * D, 10], [NOW - D, 20], [NOW, 30]])
  const p = project('seven_day', steady, NOW, NONE)!
  expect(Math.round(p.models.smooth!)).toBe(70)
  expect(Math.round(p.models.linear!)).toBe(70)
  expect(p.models.snaive).toBe(null)
  expect(p.models.profile).toBe(null)
  expect(p.shown).toBe('smooth')
  expect(p.runOutAt).toBe(null)
  expect(Math.round(p.fraction * 100)).toBe(43)
})

test('a busy last day weighs more in the smoothed pace, and names when it runs out', () => {
  // All 30% in the last 25 hours: smoothed 0.82%/h, 4 days left.
  const busy = week([[NOW - D - H, 0], [NOW, 30]])
  const p = project('seven_day', busy, NOW, NONE)!
  expect(Math.round(p.models.smooth!)).toBe(108)
  expect(Math.round(p.models.linear!)).toBe(70)
  expect(p.ratePerHour.toFixed(2)).toBe('0.82')
  expect(when(p.runOutAt!, NOW, 0)).toBe('Mon 23:39')
  expect(runOutWarning(p, NOW, 0)?.text).toBe("Heads up: at this pace you'll hit the weekly limit Mon 23:39, 10h before it resets")
})

test('idle since the last reading slows the smoothed pace', () => {
  // 30% in the first day, nothing in the two since.
  const idle = week([[NOW - 2 * D, 30]])
  expect(Math.round(project('seven_day', idle, NOW, NONE)!.models.smooth!)).toBe(41)
})

test('too early in a window says nothing; the 5-hour window too', () => {
  expect(project('seven_day', { resetsAt: NOW + 7 * D - 2 * H, samples: [[NOW, 3]], checks: {} }, NOW, NONE)).toBe(null)
  // 2h into 5h, 40% used, 25 of it in the last hour: smoothed 22.3%/h for 3h.
  const five: PaceWindow = { resetsAt: NOW + 3 * H, samples: [[NOW - H, 15], [NOW, 40]], checks: {} }
  const p = project('five_hour', five, NOW, NONE)!
  expect(Math.round(p.projected)).toBe(107)
  expect(runOutWarning(p, NOW, 0)?.text).toBe("Heads up: at this pace you'll hit the 5-hour limit 12:41, 19m before it resets")
})

// Weeks from Sunday 00:00 UTC; 2026-11-15 is a Sunday.
const SUN = Date.parse('2026-11-15T00:00:00Z')
// A week used only on weekdays 09:00-17:00, `perHour` points an hour, up to `until`.
const workWeek = (start: number, perHour: number, until = start + 7 * D): PaceWindow => {
  const samples: [number, number][] = []
  let used = 0
  for (let day = 1; day <= 5; day++) {
    const open = start + day * D + 9 * H
    if (open >= until) break
    samples.push([open, used])
    const close = Math.min(open + 8 * H, until)
    used += perHour * ((close - open) / H)
    samples.push([close, used])
  }
  return { resetsAt: start + 7 * D, samples, checks: {} }
}

test('the last window, at the same point through it, is the seasonal naive forecast', () => {
  const prev = workWeek(SUN - 7 * D, 2)
  const now = SUN + 3 * D + 12 * H
  const w = workWeek(SUN, 3, now)
  const p = project('seven_day', w, now, { prev, profile: null, offsetMinutes: 0 })!
  // Last week: 38% by Wednesday noon, 80% at the end: 42 more.
  expect(p.used).toBe(57)
  expect(p.models.snaive).toBe(99)
  // A week that isn't the one just before is no guide.
  expect(project('seven_day', w, now, { prev: workWeek(SUN - 14 * D, 2), profile: null, offsetMinutes: 0 })!.models.snaive).toBe(null)
})

test('the weekly profile learns the hours used, scales to this week, and takes over after two weeks', () => {
  const one = learnWeek(null, workWeek(SUN - 14 * D, 2), 0)
  expect(one.weeks).toBe(1)
  // Monday 10:00 is hour 34: 2 points; Monday 08:00 none.
  expect(Math.round(one.points[34]! * 100) / 100).toBe(2)
  expect(one.points[32]).toBe(0)
  const now = SUN + 3 * D + 12 * H
  const w = workWeek(SUN, 3, now)
  expect(project('seven_day', w, now, { prev: null, profile: one, offsetMinutes: 0 })!.shown).toBe('smooth')

  const two = learnWeek(one, workWeek(SUN - 7 * D, 2), 0)
  const p = project('seven_day', w, now, { prev: null, profile: two, offsetMinutes: 0 })!
  // 57 used against 38 expected by now: 1.5×; 42 expected to come, 63 at that level.
  expect(p.shown).toBe('profile')
  expect(Math.round(p.models.profile!)).toBe(120)
  // 43 to go at 3/h of work hours: 15 Wednesday, 24 Thursday, 4 Friday by 10:20.
  expect(when(p.runOutAt!, now, 0)).toBe('Fri 10:20')
})

test('each model\'s forecast is noted once, near a quarter, half and three quarters through', () => {
  const steady = week([[NOW - 2 * D, 10], [NOW - D, 20], [NOW, 30]])
  // 43% through: past the 25% mark by more than its slack, short of 50%.
  expect(checkpoint(steady, project('seven_day', steady, NOW, NONE)).checks).toEqual({})
  const at50 = project('seven_day', steady, NOW + 0.6 * D, NONE)!
  const noted = checkpoint(steady, at50)
  expect(Object.keys(noted.checks)).toEqual(['50'])
  expect(Object.keys(noted.checks['50']!)).toEqual(['smooth', 'linear'])
  expect(checkpoint(noted, at50)).toBe(noted)
})

test('accuracy: each model\'s mean miss, over 100 counted as 100; older records without a model skip it', () => {
  const history = [
    { kind: 'seven_day' as const, resetsAt: 1, final: 80, checks: { '50': { smooth: 90, linear: 60, snaive: 82 } } },
    { kind: 'seven_day' as const, resetsAt: 2, final: 100, checks: { '50': { smooth: 130, linear: 70 } } },
    { kind: 'five_hour' as const, resetsAt: 3, final: 10, checks: { '25': { smooth: 50, linear: 50 } } },
  ]
  const at50 = accuracy(history, 'seven_day').find(r => r.mark === '50')!
  expect(at50.errors.smooth).toEqual({ mae: 5, windows: 2 })
  expect(at50.errors.linear).toEqual({ mae: 25, windows: 2 })
  expect(at50.errors.snaive).toEqual({ mae: 2, windows: 1 })
  expect(at50.errors.profile).toBe(null)
  expect(describeAccuracy(history, 'seven_day')).toBe(
    'weekly accuracy, mean miss in points (windows scored):\n  at 50% through: smoothed ±5.0 (2) · straight line ±25.0 (2) · last window ±2.0 (1)',
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
  const busy = week([[NOW - D - H, 0], [NOW, 30]])
  const state: Record<string, unknown> = {
    stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38 },
    cache: { expiresAt: NOW + 50 * 60_000, secondsLeft: 3000 },
    isHidden: false,
    limits: [
      { kind: 'five_hour', percentUsed: 5, resetsAt: new Date(NOW + 4 * H).toISOString() },
      { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * D).toISOString() },
    ],
    pace: { windows: { seven_day: busy }, prev: {}, profile: null, dismissed: '' },
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
  // Kept as the last window, and learned as a week of the profile.
  expect((store['pace-prev:seven_day'] as PaceWindow).resetsAt).toBe(reset1)
  expect((store['pace-profile'] as { weeks: number }).weeks).toBe(1)
})

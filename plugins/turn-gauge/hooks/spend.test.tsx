import type { TurnUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { baselineFromBreakdown, expiredWarning, overheadWarning, costPerTurn, predictUsd, ratesFor, stepsPerTurn } from './spend'

// Opus 5.5: cache reads $0.20/M, 1-hour writes $8/M, output $20/M.
const OPUS = {
  model: 'claude-opus-5-5',
  context: 150_000,
  baseline: 20_000,
  scale: null,
  recentSteps: [16, 16, 16],
  // A typical turn at $0.60: carrying 130k (≈ $0.42) is 69% of it.
  recentCosts: [0.6, 0.6, 0.6],
  summary: null,
}

test('prices by model, the longer id first', async () => {
  expect(ratesFor('claude-opus-5-5')?.read).toBe(0.2)
  expect(ratesFor('claude-opus-5')?.read).toBe(0.5)
  expect(ratesFor('claude-opus-5-5[1m]')?.input).toBe(4)
  expect(ratesFor('claude-sonnet-4-6')?.input).toBe(3)
  expect(ratesFor('some-other-model')).toBe(null)
})

test('Haiku 5.5 prices a prompt over 100k at its long-prompt rates, on all of it', async () => {
  expect(ratesFor('claude-haiku-5-5')?.read).toBe(0.01)
  expect(ratesFor('claude-haiku-5-5', 100_000)?.read).toBe(0.01)
  expect(ratesFor('claude-haiku-5-5', 100_001)?.read).toBe(0.05)
  expect(ratesFor('claude-haiku-5-5', 150_000)?.input).toBe(0.5)
  // Models without a long-prompt row keep one price.
  expect(ratesFor('claude-opus-5-5', 500_000)?.read).toBe(0.2)
  const read = (n: number) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: n, cache_creation_input_tokens: 0 })
  expect(Math.round(predictUsd('claude-haiku-5-5', read(50_000)) * 1e6)).toBe(500)
  expect(Math.round(predictUsd('claude-haiku-5-5', read(150_000)) * 1e6)).toBe(7500)
})

test('on Haiku 5.5 the long context pays long-prompt rates, a fresh session short ones', async () => {
  const haiku = { ...OPUS, model: 'claude-haiku-5-5' }
  // 150k × $1/M against 20k × $0.20/M.
  expect(expiredWarning(haiku)?.text).toBe('Cache expired: next turn rewrites 150k ≈ $0.15 · new session ≈ $0.004')
  // A request: 150k × $0.05/M − 20k × $0.01/M = $0.0073; under $0.05 a turn stays quiet,
  // however large its share.
  const cheap = { ...haiku, recentCosts: [0.06, 0.06, 0.06] }
  expect(overheadWarning({ ...cheap, recentSteps: [6, 6, 6] })).toBe(null)
  expect(overheadWarning({ ...cheap, recentSteps: [7, 7, 7] })?.text).toBe(
    'Carry cost ≈ $0.05/turn (130k × 7 req) · new session + ~25k re-read (guess) ≈ $0.009 once → pays back in 1 turn',
  )
})

test('an expired cache prices re-caching the context against a fresh session', async () => {
  expect(expiredWarning(OPUS)?.text).toBe('Cache expired: next turn rewrites 150k ≈ $1.20 · new session ≈ $0.16')
  // Little carried: nothing to say.
  expect(expiredWarning({ ...OPUS, context: 30_000 })).toBe(null)
  // 50k above the baseline is still early in a session.
  expect(expiredWarning({ ...OPUS, context: 70_000 })).toBe(null)
})

test('the overhead names its cost a turn and when starting over pays back', async () => {
  // 20k cached, plus 25k guessed re-read and cached, for $0.36; it then carries 45k, saving 105k × 16 reads a turn.
  expect(overheadWarning(OPUS)?.text).toBe('Carry cost ≈ $0.42/turn (130k × 16 req) · new session + ~25k re-read (guess) ≈ $0.36 once → pays back in 2 turns')
  expect(overheadWarning({ ...OPUS, summary: 10_000 })?.text).toBe(
    'Carry cost ≈ $0.42/turn (130k × 16 req) · new session + ~25k re-read (guess) ≈ $0.36 once → pays back in 2 turns · /compact ≈ $0.47 once → pays back in 2 turns',
  )
  expect(overheadWarning({ ...OPUS, recentSteps: [2, 2, 2] })).toBe(null)
})

test('a new session re-reads its warm-up: measured, else guessed, and pays back only on what it does not carry', async () => {
  // Measured: 28k re-read, for $0.38 once; it carries 48k, saving 102k × 16 reads a turn.
  expect(overheadWarning({ ...OPUS, warmup: 28_000 })?.text).toBe(
    'Carry cost ≈ $0.42/turn (130k × 16 req) · new session + 28k re-read ≈ $0.38 once → pays back in 2 turns',
  )
  // The guess is a quarter of the old context when that is under 25k.
  expect(overheadWarning({ ...OPUS, context: 100_000, recentCosts: [0.4, 0.4, 0.4] })?.text).toBe(
    'Carry cost ≈ $0.26/turn (80k × 16 req) · new session + ~20k re-read (guess) ≈ $0.32 once → pays back in 2 turns',
  )
  // A warm-up as large as the old context saves nothing: no new-session part.
  expect(overheadWarning({ ...OPUS, warmup: 130_000 })?.text).toBe('Carry cost ≈ $0.42/turn (130k × 16 req)')
  expect(overheadWarning({ ...OPUS, warmup: 200_000, summary: 10_000 })?.text).toBe(
    'Carry cost ≈ $0.42/turn (130k × 16 req) · /compact ≈ $0.47 once → pays back in 2 turns',
  )
})

test('the overhead shows once carrying the old context is 60% of a typical turn', async () => {
  // $0.42 against a $0.70 turn: 59%.
  expect(overheadWarning({ ...OPUS, recentCosts: [0.7, 0.7, 0.7] })).toBe(null)
  expect(overheadWarning({ ...OPUS, recentCosts: [0.69, 0.69, 0.69] })).not.toBe(null)
  // The median turn, so one costly turn does not hide it.
  expect(overheadWarning({ ...OPUS, recentCosts: [0.5, 0.6, 9] })).not.toBe(null)
  // The same on every model: Sonnet 5.5 carries 130k for $0.21 a turn.
  const sonnet = { ...OPUS, model: 'claude-sonnet-5-5' }
  expect(overheadWarning({ ...sonnet, recentCosts: [0.3, 0.3, 0.3] })?.text).toContain('Carry cost ≈ $0.21/turn')
  expect(overheadWarning({ ...sonnet, recentCosts: [0.4, 0.4, 0.4] })).toBe(null)
})

test('the overhead waits for three turns and prices one at their median', async () => {
  expect(overheadWarning({ ...OPUS, recentSteps: [77, 10] })).toBe(null)
  expect(overheadWarning({ ...OPUS, recentCosts: [0.6, 0.6] })).toBe(null)
  // One long run does not set the price.
  expect(overheadWarning({ ...OPUS, recentSteps: [77, 16, 20] })?.text).toBe(
    'Carry cost ≈ $0.52/turn (130k × 20 req) · new session + ~25k re-read (guess) ≈ $0.36 once → pays back in 1 turn',
  )
})

test('requests per turn read from the first turn, median beside mean', async () => {
  expect(stepsPerTurn([])).toBe(null)
  expect(stepsPerTurn([4])).toEqual({ median: 4, mean: 4 })
  expect(stepsPerTurn([77, 8, 10])).toEqual({ median: 10, mean: 32 })
})

test('cost per turn: the median a typical turn, the mean with the long runs', async () => {
  expect(costPerTurn([])).toBe(null)
  expect(costPerTurn([0.3])).toEqual({ median: 0.3, mean: 0.3 })
  expect(costPerTurn([0.1, 0.2, 2.1])?.median).toBe(0.2)
  expect(Math.round(costPerTurn([0.1, 0.2, 2.1])!.mean * 1000) / 1000).toBe(0.8)
  expect(Math.round(costPerTurn([0.1, 0.25, 0.3, 3])!.median * 1000) / 1000).toBe(0.275)
})

test('the band shows the median and mean cost per turn beside the last', async ($, on) => {
  seedBand(on, { stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, recentCosts: [0.1, 0.3, 2] } })
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: '· med' }))?.text).toBe('· med')
  expect((await ui.find({ type: 'Text', text: '$0.30' }))?.text).toBe('$0.30')
  expect((await ui.find({ type: 'Text', text: '$0.80' }))?.text).toBe('$0.80')
  await ui.unmount()
})

test('the band shows what the last turn\'s subagents spent beside its cost', async ($, on) => {
  seedBand(on, { stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, agentsCost: 0.08 } })
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: '(agents $0.08)' }))?.text).toBe('(agents $0.08)')
  await ui.unmount()
})

test('an agents part under a cent still shows, as under a cent', async ($, on) => {
  seedBand(on, { stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, agentsCost: 0.0045 } })
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: '(agents <$0.01)' }))?.text).toBe('(agents <$0.01)')
  await ui.unmount()
})

test('no agents part when the turn ran no subagents', async ($, on) => {
  seedBand(on, { stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, agentsCost: 0 } })
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: /^\(agents/ })).toBe(undefined)
  await ui.unmount()
})

test('an unknown model waits for calibration; the scale follows the engine', async () => {
  expect(expiredWarning({ ...OPUS, model: 'mystery' })).toBe(null)
  expect(expiredWarning({ ...OPUS, scale: 2 })?.text).toBe('Cache expired: next turn rewrites 150k ≈ $2.40 · new session ≈ $0.32')
})

test('B from the breakdown is everything in use but the conversation, else nothing', async () => {
  const rows = [
    { name: 'System prompt', tokens: 4_000, kind: 'used' },
    { name: 'System tools', tokens: 12_000, kind: 'used' },
    { name: 'Memory files', tokens: 2_000, kind: 'used' },
    { name: 'Messages', tokens: 90_000, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 5_000, kind: 'deferred' },
    { name: 'Free space', tokens: 80_000, kind: 'free' },
  ]
  expect(baselineFromBreakdown(rows)).toBe(18_000)
  expect(baselineFromBreakdown(rows.filter(r => r.name !== 'Messages'))).toBe(null)
})

const BAND = (maxRows = 3) =>
  ({
    plugin: 'turn-gauge',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 140, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as const

const NOW = Date.parse('2026-11-20T10:00:00Z')

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const seedBand = (on: On, extra: Record<string, unknown>) => {
  const state: Record<string, unknown> = {
    stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38, recentCosts: [0.6, 0.6, 0.6] },
    cache: { expiresAt: NOW + 30 * 60_000, secondsLeft: 1800 },
    isHidden: false,
    spend: {
      ...OPUS,
      isBaselineMeasured: true,
      steps: 0,
      predicted: 0,
      usdAtTurnStart: 0,
      calibPredicted: 0,
      calibObserved: 0,
      dismissedAt: null,
      isFresh: false,
      isCompactPending: false,
    },
    ...extra,
  }
  on('state.get', (_, e) => (e.key in state ? { value: { value: state[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
}

test('the band shows the overhead warning while idle and the cache is warm', async ($, on) => {
  seedBand(on, {})
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: /^Carry cost/ }))?.text).toMatch(/\$0\.42\/turn/)
  expect(await ui.find({ type: 'Button', key: 'dismiss-spend' })).not.toBe(undefined)
  expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.label).toBe('compact, keep 3')
  await ui.unmount()
})

test('the band shows the expired-cache warning once the cache lapsed', async ($, on) => {
  seedBand(on, { cache: { expiresAt: NOW - 1000, secondsLeft: 0 } })
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: /^Cache expired/ }))?.text).toBe(
    'Cache expired: next turn rewrites 150k ≈ $1.20 · new session ≈ $0.16',
  )
  await ui.unmount()
})

type Test$ = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

// A live session against a faked engine: the real hooks, scripted responses and costs.
const liveSession = ($: Test$, on: On) => {
  const store: Record<string, unknown> = {}
  const live = { usd: 0, agents: [] as { id: string; usd: number }[], spend: {} as Record<string, any>, stats: {} as Record<string, any> }
  const steps: TurnUsage[][] = []
      on('state.set', (_, e, next) => {
    if (e.key === 'spend') live.spend = e.value as unknown as Record<string, any>
    if (e.key === 'stats') live.stats = e.value as unknown as Record<string, any>
    return next(e)
  })
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_, e) => (delete store[e.key], { value: undefined }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('clock.now', () => ({ value: NOW }))
  on('command.register', () => ({ value: { command: 'turn-gauge' } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: live.usd } } }))
  on('agent.list', () => ({ value: live.agents.map(a => ({ id: a.id, cost: { usd: a.usd } })) as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    const [usage] = steps.shift() ?? []
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: usage ?? null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage ?? null }
  })

  const usage = (u: Partial<Record<string, number>>): TurnUsage => ({
    input_tokens: 3,
    output_tokens: 500,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
    model: 'claude-opus-5-5',
    ...u,
  })
  const turn = async (id: string, responses: TurnUsage[], costAfter: number) => {
    await $.turn.start({ text: 'go', turnId: id })
    for (const response of responses) {
      steps.push([response])
      for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
    }
    live.usd = costAfter
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer' })
  }
  return { live, store, steps, usage, turn }
}

test('a fresh session measures B, the price scale and a compaction summary from real responses', async ($, on) => {
  const { live, store, steps, usage, turn } = liveSession($, on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  // List price: 18003 written for an hour, 500 out = $0.154; then a read and a write = $0.0256.
  await turn(
    't1',
    [
      usage({ cache_creation_input_tokens: 18_000, ephemeral_1h_input_tokens: 18_000 }),
      usage({ cache_read_input_tokens: 18_003, cache_creation_input_tokens: 2_000, ephemeral_1h_input_tokens: 2_000, output_tokens: 300 }),
    ],
    0.3592,
  )
  // The first request of a fresh session is B.
  expect(store['baseline:/proj']).toEqual([18_003])

  const after1 = live.spend
  expect(Math.round(after1.scale! * 1000) / 1000).toBe(2)
  expect(after1.recentSteps).toEqual([2])
  expect(after1.context).toBe(20_006)
  expect(live.stats.turn).toBe(1)
  expect(live.stats.recentCosts).toEqual([0.3592])

  // No subagents yet: nothing spent by agents.
  expect(live.stats.agentsCost).toBe(0)

  // A subagent's run is not a turn of the band's.
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'agent-1' })
  expect(live.stats.turn).toBe(1)

  // A compaction, then the next request carries B plus the summary.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  // The carried context is gone with it: no warning on the old figure.
  expect(live.spend.context).toBe(null)
  await turn('t2', [usage({ cache_creation_input_tokens: 29_997, ephemeral_1h_input_tokens: 29_997 })], 0.6)
  expect(store.summaries).toEqual([12_000 - 3])
  expect(live.stats.recentCosts?.length).toBe(2)

  // An agent that ran before this turn counts only what it spends during it; one
  // the engine drops before the turn ends keeps its last reading.
  live.agents = [{ id: 'old', usd: 0.5 }]
  await $.turn.start({ text: 'go', turnId: 't3' })
  live.agents = [{ id: 'old', usd: 0.6 }, { id: 'new', usd: 0.05 }]
  steps.push([usage({ cache_read_input_tokens: 30_000 })])
  for await (const _ of $.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
  live.agents = [{ id: 'old', usd: 0.62 }]
  live.usd = 1.2
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' })
  expect(Math.round(live.stats.agentsCost * 1000) / 1000).toBe(0.17)
  expect(live.stats.recentCosts?.length).toBe(3)
  expect(Math.round(live.stats.recentCosts.at(-1) * 1000) / 1000).toBe(0.6)

  // A background agent that goes on after the turn ended: its spend is still that turn's,
  // in the band and in the turn's place among the recent costs.
  live.agents = [{ id: 'bg', usd: 0.03 }]
  live.usd = 1.23
  steps.push([usage({ cache_read_input_tokens: 1_000 })])
  for await (const _ of $.turn.step({ turnId: 'b1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'bg' })) void _
  expect(Math.round(live.stats.turnCost * 1000) / 1000).toBe(0.63)
  expect(Math.round(live.stats.agentsCost * 1000) / 1000).toBe(0.2)
  expect(live.stats.recentCosts?.length).toBe(3)
  expect(Math.round(live.stats.recentCosts.at(-1) * 1000) / 1000).toBe(0.63)
  live.agents = [{ id: 'bg', usd: 0.04 }]
  live.usd = 1.24
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'b1', reason: 'answer', agentId: 'bg' })
  expect(Math.round(live.stats.recentCosts.at(-1) * 1000) / 1000).toBe(0.64)
  expect(live.stats.recentCosts?.length).toBe(3)

  // The next turn starts from there and counts none of it.
  await $.turn.start({ text: 'go', turnId: 't4' })
  expect(live.stats.agentsCost).toBe(0)
  expect(live.stats.recentCosts?.length).toBe(3)
})

test('a fresh session measures its warm-up over its first turns, and a compaction cancels it', async ($, on) => {
  const { live, store, usage, turn } = liveSession($, on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turn('t1', [usage({ cache_creation_input_tokens: 18_000 }), usage({ cache_read_input_tokens: 18_003, cache_creation_input_tokens: 10_000 })], 0.2)
  // One turn of the default two: not yet.
  expect(store['warmup:/proj']).toBe(undefined)
  expect(live.spend.warmupFrom).toBe(18_003)
  await turn('t2', [usage({ cache_read_input_tokens: 28_003, cache_creation_input_tokens: 12_000 })], 0.4)
  // 40,006 carried after turn 2, over the first request's 18,003.
  expect(store['warmup:/proj']).toEqual([22_003])
  expect(live.spend.warmup).toBe(22_003)
  expect(live.spend.warmupFrom).toBe(null)
  // Later turns add nothing.
  await turn('t3', [usage({ cache_read_input_tokens: 40_006, cache_creation_input_tokens: 5_000 })], 0.5)
  expect(store['warmup:/proj']).toEqual([22_003])
})

test('the warm-up counts as many turns as the option says, and a compaction during it measures nothing', async ($, on) => {
  const { live, store, usage, turn } = liveSession($, on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turn('t1', [usage({ cache_creation_input_tokens: 18_000 })], 0.2)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  expect(live.spend.warmupFrom).toBe(null)
  await turn('t2', [usage({ cache_creation_input_tokens: 25_000 })], 0.4)
  expect(store['warmup:/proj']).toBe(undefined)
})

test('one warm-up turn, by option', { options: { warmupTurns: 1 } }, async ($, on) => {
  const { store, usage, turn } = liveSession($, on)
  store['warmup:/proj'] = [30_000, 10_000]
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await turn('t1', [usage({ cache_creation_input_tokens: 18_000 }), usage({ cache_read_input_tokens: 18_003, cache_creation_input_tokens: 6_000 })], 0.2)
  expect(store['warmup:/proj']).toEqual([30_000, 10_000, 6_003])
})

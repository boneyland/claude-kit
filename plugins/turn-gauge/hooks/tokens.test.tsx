import type { TurnUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { cacheMissWarning, formatTokens, hitRate, missedOf, NO_TOKENS, outputWarning } from './spend'

// Opus 5.5: input $4/M, cache reads $0.20/M, 1-hour writes $8/M, output $20/M.
const OPUS = { model: 'claude-opus-5-5', context: 150_000, baseline: 20_000, scale: null, recentSteps: [4, 4, 4], recentCosts: [0.2, 0.2, 0.2], summary: null }

test('token counts read exactly when small', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(240)).toBe('240')
  expect(formatTokens(2_400)).toBe('2.4k')
  expect(formatTokens(3_000)).toBe('3k')
  expect(formatTokens(9_960)).toBe('10k')
  expect(formatTokens(161_000)).toBe('161k')
  expect(formatTokens(1_240_000)).toBe('1.2M')
})

test('the hit rate is the share of input read from the cache', () => {
  expect(hitRate(NO_TOKENS)).toBe(null)
  expect(hitRate({ ...NO_TOKENS, read: 90, write: 8, uncached: 2 })).toBe(0.9)
})

test('a request misses what the previous request carried and it did not read', () => {
  const u = (read: number) => ({ input_tokens: 3, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 500 })
  expect(missedOf(null, u(0))).toBe(0)
  expect(missedOf(100_000, u(100_000))).toBe(0)
  expect(missedOf(100_000, u(0))).toBe(100_000)
})

test('a cache miss warns unless the band knows why, and only when it is large', () => {
  const miss = { ...NO_TOKENS, read: 10_000, write: 90_000, missed: 84_000 }
  expect(cacheMissWarning(OPUS, miss, null)?.text).toBe(
    'Cache miss: last turn re-wrote 84k ≈ $0.66 extra (hit 10%) · a tool, MCP, CLAUDE.md or plugin change resets the cache',
  )
  expect(cacheMissWarning(OPUS, miss, 'expired')).toBe(null)
  expect(cacheMissWarning(OPUS, miss, 'compacted')).toBe(null)
  expect(cacheMissWarning(OPUS, { ...miss, missed: 5_000 }, null)).toBe(null)
  expect(cacheMissWarning(OPUS, null, null)).toBe(null)
})

test('an output-heavy turn says what its output cost and its share of the turn', () => {
  expect(outputWarning(OPUS, { ...NO_TOKENS, output: 34_000 })?.text).toBe("Output-heavy turn: 34k tokens out ≈ $0.68 · 100% of the turn's cost")
  // $0.68 out against $0.80 of cache reads: 46%.
  expect(outputWarning(OPUS, { ...NO_TOKENS, read: 4_000_000, output: 34_000 })?.text).toMatch(/46% of the turn's cost$/)
  expect(outputWarning(OPUS, { ...NO_TOKENS, output: 12_000 })).toBe(null)
})

test('a long output in a turn that paid mostly for input does not warn', () => {
  // The case that prompted this: 100k out ≈ $2.00 beside ~$9.40 of mostly cache reads.
  expect(outputWarning(OPUS, { ...NO_TOKENS, read: 34_000_000, write: 300_000, uncached: 2_000, output: 100_000 })).toBe(null)
})

test('the share holds on a model without known prices', () => {
  const unknown = { ...OPUS, model: 'claude-future-9', scale: null }
  expect(outputWarning(unknown, { ...NO_TOKENS, output: 34_000 })?.text).toBe("Output-heavy turn: 34k tokens out · 100% of the turn's cost")
})

const NOW = Date.parse('2026-11-20T10:00:00Z')

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

// Drives real turns through the band's hooks; returns its tokens as last written.
const harness = (on: On) => {
  const steps: TurnUsage[] = []
  const state: { tokens: Record<string, any> } = { tokens: {} }
  const store: Record<string, unknown> = {}
  on('state.set', (_, e, next) => {
    if (e.key === 'tokens') state.tokens = e.value as unknown as Record<string, any>
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
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    const usage = steps.shift() ?? null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  return { steps, state }
}

const usage = (u: Partial<Record<string, number>>, model = 'claude-opus-5-5'): TurnUsage => ({
  input_tokens: 3,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  model,
  ...u,
})

test('turns count tokens, and a miss is told apart from the expected ones', async ($, on) => {
  const { steps, state } = harness(on)
  const turn = async (id: string, responses: TurnUsage[], agentId?: string) => {
    await $.turn.start({ text: 'go', turnId: id, ...(agentId ? { agentId } : {}) })
    for (const r of responses) {
      steps.push(r)
      for await (const _ of $.turn.step({ turnId: id, index: 0, model: r.model, messageCount: 1, ...(agentId ? { agentId } : {}) })) void _
    }
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer', ...(agentId ? { agentId } : {}) })
  }

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  // A fresh session writes everything: expected.
  await turn('t1', [usage({ cache_creation_input_tokens: 50_000 }), usage({ cache_read_input_tokens: 50_003, cache_creation_input_tokens: 1_000 })])
  expect(state.tokens.last.missed).toBe(0)
  expect(state.tokens.lastCause).toBe('fresh')
  expect(state.tokens.input).toBe(101_009)
  expect(state.tokens.output).toBe(1_000)

  // Warm: reads the whole previous context.
  await turn('t2', [usage({ cache_read_input_tokens: 51_006, cache_creation_input_tokens: 2_000 })])
  expect(state.tokens.last.missed).toBe(0)
  expect(state.tokens.lastCause).toBe(null)

  // Something changed the prefix: the context is written again for no known reason.
  await turn('t3', [usage({ cache_read_input_tokens: 4_000, cache_creation_input_tokens: 50_000 })])
  expect(state.tokens.last.missed).toBe(53_009 - 4_000)
  expect(state.tokens.lastCause).toBe(null)

  // A subagent's tokens count for the session, not for the main turn.
  const before = state.tokens.last
  await turn('s1', [usage({ cache_creation_input_tokens: 30_000, output_tokens: 2_000 })], 'agent-1')
  expect(state.tokens.output).toBe(1_000 + 500 + 500 + 2_000)
  expect(state.tokens.last).toEqual(before)

  // Another model has no cache of this context: expected.
  await turn('t4', [usage({ cache_creation_input_tokens: 54_000 }, 'claude-sonnet-5-5')])
  expect(state.tokens.last.missed).toBe(54_003)
  expect(state.tokens.lastCause).toBe('model')

  // After a compaction the context is new: nothing missed.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await turn('t5', [usage({ cache_creation_input_tokens: 25_000 }, 'claude-sonnet-5-5')])
  expect(state.tokens.last.missed).toBe(0)
})

const BAND = (bodyColumns = 140) =>
  ({
    plugin: 'turn-gauge',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 }, isCollapsed: false, view: {} },
  }) as const

const seed = (on: On, tokens: Record<string, unknown>) => {
  const state: Record<string, unknown> = {
    stats: { turn: 9, speed: 80, turnCost: 0.12, total: 4.5, context: 15, costAtStart: 4.38 },
    cache: { expiresAt: NOW + 30 * 60_000, secondsLeft: 1800 },
    isHidden: false,
    // A small context: no overhead warning in the way.
    spend: { ...OPUS, context: 40_000, isBaselineMeasured: true, steps: 0, predicted: 0, usdAtTurnStart: 0, calibPredicted: 0, calibObserved: 0, dismissedAt: null, isFresh: false, isCompactPending: false },
    tokens: { input: 840_000, output: 21_000, turn: NO_TOKENS, prevContext: 40_000, prevModel: 'claude-opus-5-5', cause: null, lastCause: null, dismissedTurn: -1, ...tokens },
  }
  let version = 1
  on('state.get', (_, e) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_, e) => ((state[e.key] = e.value), { value: { isSet: true, version: ++version } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
}

test('the band shows the session tokens and the last turn\'s hit rate', async ($, on) => {
  seed(on, { last: { ...NO_TOKENS, read: 92_000, write: 8_000 } })
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: '840k in' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '21k out' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: '92%' }))?.props.color).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^Cache miss/ })).toBe(undefined)
  await ui.unmount()
  // Narrower: in/out only; narrower still: no tokens.
  const mid = await $.ui.mount(BAND(85))
  expect(await mid.find({ type: 'Text', text: '840k' })).toBeTruthy()
  await mid.unmount()
  const narrow = await $.ui.mount(BAND(66))
  expect(await narrow.find({ type: 'Text', text: '840k' })).toBe(undefined)
  await narrow.unmount()
})

test('a cache miss warns until dismissed, and the rate turns red', async ($, on) => {
  seed(on, { last: { ...NO_TOKENS, read: 10_000, write: 90_000, missed: 84_000 } })
  const ui = await $.ui.mount(BAND())
  expect((await ui.find({ type: 'Text', text: /^Cache miss/ }))?.text).toMatch(/re-wrote 84k/)
  expect((await ui.find({ type: 'Text', text: '10%' }))?.props.color).toBe('#e0846b')
  await ui.press({ key: 'dismiss-turn' })
  await ui.unmount()
  // The stubbed state does not redraw its readers: draw it again.
  const again = await $.ui.mount(BAND())
  expect(await again.find({ type: 'Text', text: /^Cache miss/ })).toBe(undefined)
  await again.unmount()
})

test('an expected re-write does not warn; a long output does', async ($, on) => {
  seed(on, { last: { ...NO_TOKENS, write: 90_000, missed: 84_000, output: 34_000 }, lastCause: 'expired' })
  const ui = await $.ui.mount(BAND())
  expect(await ui.find({ type: 'Text', text: /^Cache miss/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^Output-heavy/ }))?.text).toMatch(/34k tokens out/)
  await ui.unmount()
})

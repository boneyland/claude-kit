// What carrying a long context costs, against starting over: the prices, and the
// arithmetic the band's spend warnings show. Pure: no engine calls.

// USD per million tokens: input, cache read, output. Cache writes are input at
// 1.25x (5 minutes) and 2x (1 hour). Claude API list prices, 2026-11-03.
type Rates = { input: number; read: number; output: number }

// A request whose input (uncached, cache read and cache write together) is over
// this many tokens pays a model's long-prompt rates, when it has them, on all of it.
export const LONG_PROMPT = 100_000

const LONG_RATES: [prefix: string, rates: Rates][] = [['haiku-5-5', { input: 0.5, read: 0.05, output: 2.5 }]]

const RATES: [prefix: string, rates: Rates][] = [
  ['fable-5-2', { input: 8, read: 0.2, output: 40 }],
  ['mythos-5-2', { input: 8, read: 0.2, output: 40 }],
  ['fable-5-1', { input: 10, read: 0.25, output: 50 }],
  ['mythos-5-1', { input: 10, read: 0.25, output: 50 }],
  ['fable-5', { input: 10, read: 1, output: 50 }],
  ['mythos-5', { input: 10, read: 1, output: 50 }],
  ['opus-5-5', { input: 4, read: 0.2, output: 20 }],
  ['opus-5', { input: 5, read: 0.5, output: 25 }],
  ['opus-4', { input: 5, read: 0.5, output: 25 }],
  ['sonnet-5-5', { input: 2, read: 0.1, output: 10 }],
  ['sonnet-5', { input: 2, read: 0.2, output: 10 }],
  ['sonnet-4', { input: 3, read: 0.3, output: 15 }],
  ['haiku-5-5', { input: 0.1, read: 0.01, output: 0.5 }],
  ['haiku-4', { input: 1, read: 0.1, output: 5 }],
]

// A model not in the table: the usual ratios, its scale left to calibration.
const RELATIVE: Rates = { input: 1, read: 0.1, output: 5 }

const lookup = (table: [string, Rates][], model: string) => {
  const id = model.replace(/^(us\.|eu\.)?(anthropic\.)?claude-/, '')
  return table.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`))?.[1] ?? null
}

// A model's rates for a request carrying `prompt` input tokens; a short prompt when unsaid.
export const ratesFor = (model: string, prompt = 0): Rates | null =>
  (prompt > LONG_PROMPT ? lookup(LONG_RATES, model) : null) ?? lookup(RATES, model)

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}

// What one response cost at list price; a write with no lifetime prices as 5
// minutes, as /cost does.
export const predictUsd = (model: string, u: StepUsage) => {
  const r = ratesFor(model, contextOf(u)) ?? RELATIVE
  const hour = u.ephemeral_1h_input_tokens ?? 0
  const fiveMin = u.cache_creation_input_tokens - hour
  return (
    (u.input_tokens * r.input +
      u.cache_read_input_tokens * r.read +
      fiveMin * 1.25 * r.input +
      hour * 2 * r.input +
      u.output_tokens * r.output) /
    1e6
  )
}

// The input a response was answered over: the context it carried.
export const contextOf = (u: StepUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export type SpendInputs = {
  model: string | null
  // C: the input tokens of the main loop's last request.
  context: number | null
  // B: what a fresh session in this project starts with.
  baseline: number | null
  // Engine cost over list price; null until measured, required for unknown models.
  scale: number | null
  // Requests each recent main turn made: their median prices a turn, so one long run does not.
  recentSteps: readonly number[]
  // What each recent main turn cost in USD, subagents included: the carry cost is weighed against their median.
  recentCosts: readonly number[]
  // Median tokens a compaction summary came to, measured; null until one ran.
  summary: number | null
  // Median tokens a fresh session in this project re-reads in its first turns, measured;
  // null (or absent) until one did, when WARMUP_GUESS stands in.
  warmup?: number | null
}

// Below this much carried context, nothing is worth saying.
const MIN_OLD_TOKENS = 60_000
// The expired cache: shown when starting over saves at least this much.
const EXPIRED_MIN_SAVING = 0.1
// The steady overhead: shown when carrying the old context comes to this share of a
// typical turn's cost, the same on every model since both sides use its prices...
export const OVERHEAD_MIN_SHARE = 0.6
// ...and to at least this much a turn, so a large share of pennies stays quiet.
export const OVERHEAD_MIN_USD = 0.05
// ...and only when starting over or compacting pays for itself within this many
// turns (the `maxPaybackTurns` setting): further out is a guess at the session's length.
export const MAX_PAYBACK_TURNS = 5
// Turns seen before the overhead is priced: one turn says little about the next.
export const MIN_TURNS = 3
// How many recent turns' request counts are kept.
export const RECENT_TURNS = 10
// Before a fresh session has measured its warm-up: this many tokens re-read, or this
// share of the old context when that is less, since a new session rebuilds part of it.
export const WARMUP_GUESS = 25_000
export const WARMUP_GUESS_SHARE = 0.25

// 240, 2.4k, 84k, 1.2M: exact under a thousand, so a short answer never shows as 0k.
const tokens = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 9_950
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
        : String(Math.round(n))
// $0.42; under a cent, $0.004, so a cheap fresh session never shows as $0.00.
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 3 : 2)}`

// Prices per token for a request carrying `prompt` input tokens in this session,
// scaled to what the engine's cost says.
const unitPrices = (s: SpendInputs, prompt: number) => {
  if (s.model === null) return null
  const known = ratesFor(s.model, prompt)
  if (known === null && s.scale === null) return null
  const r = known ?? RELATIVE
  const k = (s.scale ?? 1) / 1e6
  return { input: r.input * k, read: r.read * k, output: r.output * k, write1h: 2 * r.input * k }
}

// Starting over: a new session caches its baseline, then re-reads part of what this
// one carries (the warm-up, measured or guessed) and caches that too, and goes on
// carrying both. Its one-off cost, what it carries, and how the row names the re-read.
const restartOf = (s: SpendInputs & { baseline: number; context: number }) => {
  const old = s.context - s.baseline
  const isGuess = s.warmup === null || s.warmup === undefined
  const warmup = isGuess ? Math.min(WARMUP_GUESS, WARMUP_GUESS_SHARE * old) : s.warmup!
  const carried = s.baseline + warmup
  const b = unitPrices(s, s.baseline)!
  const w = unitPrices(s, carried)!
  return {
    cost: s.baseline * b.write1h + warmup * w.write1h,
    carried,
    read: w.read,
    label: `new session + ${isGuess ? `~${tokens(warmup)} re-read (guess)` : `${tokens(warmup)} re-read`}`,
  }
}

export type SpendWarning = { kind: 'expired' | 'overhead' | 'cache-miss' | 'output'; text: string }

// After the cache lapsed the next message writes the whole context back at the
// 1-hour rate; a fresh session writes its baseline and, over its first turns, its
// warm-up. (A /compact then costs more than either: it reads the uncached context too.)
export const expiredWarning = (s: SpendInputs): SpendWarning | null => {
  if (s.context === null || s.baseline === null) return null
  const p = unitPrices(s, s.context)
  const b = unitPrices(s, s.baseline)
  if (p === null || b === null) return null
  if (s.context - s.baseline < MIN_OLD_TOKENS) return null

  const resume = s.context * p.write1h
  const fresh = restartOf({ ...s, baseline: s.baseline, context: s.context })
  if (resume - fresh.cost < EXPIRED_MIN_SAVING) return null
  return {
    kind: 'expired',
    text: `Cache expired: next turn rewrites ${tokens(s.context)} ≈ ${usd(resume)} · ${fresh.label} ≈ ${usd(fresh.cost)}`,
  }
}

// With the cache warm each request still reads the whole context; what that costs
// over reading a fresh session's baseline, times the requests a turn makes, is the
// overhead. (A long prompt can pay higher rates on all of it, not just the old part.)
export const overheadWarning = (s: SpendInputs, maxPayback = MAX_PAYBACK_TURNS): SpendWarning | null => {
  if (s.context === null || s.baseline === null) return null
  const p = unitPrices(s, s.context)
  const b = unitPrices(s, s.baseline)
  if (p === null || b === null) return null
  const old = s.context - s.baseline
  if (old < MIN_OLD_TOKENS) return null

  if (s.recentSteps.length < MIN_TURNS || s.recentCosts.length < MIN_TURNS) return null
  const steps = stepsPerTurn(s.recentSteps)!.median
  const perTurn = (s.context * p.read - s.baseline * b.read) * steps
  const typical = costPerTurn(s.recentCosts)!.median
  if (perTurn < OVERHEAD_MIN_USD || perTurn < OVERHEAD_MIN_SHARE * typical) return null

  const paybackTurns = (cost: number, saving: number) => Math.max(1, Math.ceil(cost / saving))
  const turnsText = (turns: number) => `${turns} turn${turns === 1 ? '' : 's'}`
  const parts = [`Carry cost ≈ ${usd(perTurn)}/turn (${tokens(old)} × ${steps} req)`]
  let soonest = Infinity

  // The new session goes on carrying its baseline and warm-up, so it saves only the rest.
  const fresh = restartOf({ ...s, baseline: s.baseline, context: s.context })
  const freshSaving = (s.context * p.read - fresh.carried * fresh.read) * steps
  if (freshSaving > 0) {
    const turns = paybackTurns(fresh.cost, freshSaving)
    soonest = Math.min(soonest, turns)
    parts.push(`${fresh.label} ≈ ${usd(fresh.cost)} once → pays back in ${turnsText(turns)}`)
  }

  // A compaction reads the context once, writes the summary, then re-caches
  // baseline and summary; it saves what the summary does not carry.
  if (s.summary !== null) {
    const kept = s.baseline + s.summary
    const k = unitPrices(s, kept)!
    const cost = s.context * p.read + s.summary * p.output + kept * k.write1h
    const saving = (s.context * p.read - kept * k.read) * steps
    if (saving > 0) {
      const turns = paybackTurns(cost, saving)
      soonest = Math.min(soonest, turns)
      parts.push(`/compact ≈ ${usd(cost)} once → pays back in ${turnsText(turns)}`)
    }
  }
  // Nothing to do about it soon enough: say nothing.
  if (soonest > maxPayback) return null
  return { kind: 'overhead', text: parts.join(' · ') }
}

// The next message's cost once the cache lapses, for the expiry notification.
export const resumeCost = (s: SpendInputs) => {
  if (s.context === null) return null
  const p = unitPrices(s, s.context)
  return p === null ? null : s.context * p.write1h
}

export const formatUsd = usd

// B from /context's breakdown: everything in use but the conversation itself.
// Null when no `Messages` row can be told apart, so nothing is guessed.
export const baselineFromBreakdown = (categories: readonly { name: string; tokens: number; kind: string }[]) => {
  const used = categories.filter(c => c.kind === 'used')
  const messages = used.filter(c => c.name === 'Messages')
  if (messages.length !== 1) return null
  return used.reduce((sum, c) => sum + (c.name === 'Messages' ? 0 : c.tokens), 0)
}

// Requests a main turn makes, over the recent turns: the median prices one, the
// mean shows what long runs add. Null before the first turn.
export const stepsPerTurn = (recent: readonly number[]) => {
  if (recent.length === 0) return null
  return {
    median: Math.max(1, median(recent)!),
    mean: Math.round(mean(recent)),
  }
}

// What the recent main turns cost, in USD: the median is a typical turn, the
// mean adds the long runs. Unrounded, unlike median(). Null before the first turn.
export const costPerTurn = (recent: readonly number[]) => {
  if (recent.length === 0) return null
  const s = [...recent].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return { median: s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2, mean: mean(recent) }
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export const median = (xs: readonly number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

// ---------------------------------------------------------------------------
// Token counts and the prompt cache's hit rate, and the warnings when they look off.

// A main turn's tokens: input by where it came from, output, and the context the
// previous request carried that this one did not read from the cache.
export type TurnTokens = { uncached: number; read: number; write: number; output: number; missed: number }

export const NO_TOKENS: TurnTokens = { uncached: 0, read: 0, write: 0, output: 0, missed: 0 }

// The share of input served from the cache; null before any input.
export const hitRate = (t: TurnTokens) => {
  const all = t.uncached + t.read + t.write
  return all === 0 ? null : t.read / all
}

// What one request missed: the previous request's context it should have read
// from the cache. Null previous (a session's first request, after a compaction)
// misses nothing.
export const missedOf = (previous: number | null, u: StepUsage) =>
  previous === null ? 0 : Math.max(0, previous - u.cache_read_input_tokens)

// Below this much context re-written, a miss is not worth a word.
export const MISS_MIN_TOKENS = 20_000
// A turn writing this much output is shown, with what it cost...
export const OUTPUT_WARN_TOKENS = 30_000
// ...when its output came to at least this share of the turn's cost.
export const OUTPUT_WARN_SHARE = 0.4
// The band's hit rate turns amber below this.
export const RATE_WARN = 0.8

export const formatTokens = tokens

// A turn re-wrote context the cache should have held, for no reason the band
// knows of (an expired cache, a compaction, a model switch, a fresh session):
// something in the prompt's prefix changed.
export const cacheMissWarning = (s: SpendInputs, t: TurnTokens | null, cause: string | null): SpendWarning | null => {
  if (t === null || cause !== null || t.missed < MISS_MIN_TOKENS) return null
  const p = s.context === null ? null : unitPrices(s, s.context)
  const rate = hitRate(t)
  const extra = p === null ? '' : ` ≈ ${usd(t.missed * (p.write1h - p.read))} extra`
  return {
    kind: 'cache-miss',
    text: `Cache miss: last turn re-wrote ${tokens(t.missed)}${extra}${rate === null ? '' : ` (hit ${Math.round(rate * 100)}%)`} · a tool, MCP, CLAUDE.md or plugin change resets the cache`,
  }
}

// A turn whose output ran long and carried much of its cost. A long agentic turn
// writes plenty of output yet pays mostly for re-reading its context, so the
// token count alone would warn exactly when output matters least.
export const outputWarning = (s: SpendInputs, t: TurnTokens | null): SpendWarning | null => {
  if (t === null || t.output < OUTPUT_WARN_TOKENS) return null
  // The share needs only the price ratios, which hold without a measured scale.
  const r = (s.model === null ? null : ratesFor(s.model, s.context ?? 0)) ?? RELATIVE
  const out = t.output * r.output
  const total = t.uncached * r.input + t.read * r.read + t.write * 2 * r.input + out
  const share = out / total
  if (share < OUTPUT_WARN_SHARE) return null
  const p = unitPrices(s, s.context ?? 0)
  const cost = p === null ? '' : ` ≈ ${usd(t.output * p.output)}`
  return {
    kind: 'output',
    text: `Output-heavy turn: ${tokens(t.output)} tokens out${cost} · ${Math.round(share * 100)}% of the turn's cost`,
  }
}

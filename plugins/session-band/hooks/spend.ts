// What carrying a long context costs, against starting over: the prices, and the
// arithmetic the band's spend warnings show. Pure: no engine calls.

// USD per million tokens: input, cache read, output. Cache writes are input at
// 1.25x (5 minutes) and 2x (1 hour). Claude API list prices, 2026-11-03.
type Rates = { input: number; read: number; output: number }

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

export const ratesFor = (model: string): Rates | null => {
  const id = model.replace(/^(us\.|eu\.)?(anthropic\.)?claude-/, '')
  return RATES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`))?.[1] ?? null
}

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
  const r = ratesFor(model) ?? RELATIVE
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
  // Median tokens a compaction summary came to, measured; null until one ran.
  summary: number | null
}

// Below this much carried context, nothing is worth saying.
const MIN_OLD_TOKENS = 60_000
// The expired cache: shown when starting over saves at least this much.
const EXPIRED_MIN_SAVING = 0.1
// The steady overhead: shown when the old context costs this much a turn.
export const OVERHEAD_MIN_USD = 0.4
// Turns seen before the overhead is priced: one turn says little about the next.
export const MIN_TURNS = 3
// How many recent turns' request counts are kept.
export const RECENT_TURNS = 10

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
const usd = (n: number) => `$${n.toFixed(2)}`

// Prices per token for this session, scaled to what the engine's cost says.
const unitPrices = (s: SpendInputs) => {
  if (s.model === null) return null
  const known = ratesFor(s.model)
  if (known === null && s.scale === null) return null
  const r = known ?? RELATIVE
  const k = (s.scale ?? 1) / 1e6
  return { input: r.input * k, read: r.read * k, output: r.output * k, write1h: 2 * r.input * k }
}

export type SpendWarning = { kind: 'expired' | 'overhead' | 'cache-miss' | 'output'; text: string }

// After the cache lapsed the next message writes the whole context back at the
// 1-hour rate; a fresh session writes only its baseline. (A /compact then costs
// more than either: it reads the uncached context too.)
export const expiredWarning = (s: SpendInputs): SpendWarning | null => {
  const p = unitPrices(s)
  if (p === null || s.context === null || s.baseline === null) return null
  if (s.context - s.baseline < MIN_OLD_TOKENS) return null

  const resume = s.context * p.write1h
  const fresh = s.baseline * p.write1h
  if (resume - fresh < EXPIRED_MIN_SAVING) return null
  return {
    kind: 'expired',
    text: `Cache expired: next message re-caches ${tokens(s.context)} ≈ ${usd(resume)} · new session ≈ ${usd(fresh)}`,
  }
}

// With the cache warm each request still reads the whole context; the part a
// fresh session would not carry, times the requests a turn makes, is the overhead.
export const overheadWarning = (s: SpendInputs): SpendWarning | null => {
  const p = unitPrices(s)
  if (p === null || s.context === null || s.baseline === null) return null
  const old = s.context - s.baseline
  if (old < MIN_OLD_TOKENS) return null

  if (s.recentSteps.length < MIN_TURNS) return null
  const { median: steps, mean } = stepsPerTurn(s.recentSteps)!
  const perTurn = old * p.read * steps
  if (perTurn < OVERHEAD_MIN_USD) return null

  const payback = (cost: number, saving: number) => {
    const turns = Math.max(1, Math.ceil(cost / saving))
    return `${turns} turn${turns === 1 ? '' : 's'}`
  }
  const parts = [
    `Old context ≈ ${usd(perTurn)}/turn (${tokens(old)} × ${steps} req median, ${mean} mean)`,
    `new session pays back in ${payback(s.baseline * p.write1h, perTurn)}`,
  ]

  // A compaction reads the context once, writes the summary, then re-caches
  // baseline and summary; it saves what the summary does not carry.
  if (s.summary !== null) {
    const cost = s.context * p.read + s.summary * p.output + (s.baseline + s.summary) * p.write1h
    const saving = (old - s.summary) * p.read * steps
    if (saving > 0) parts.push(`/compact ≈ ${usd(cost)}, pays back in ${payback(cost, saving)}`)
  }
  return { kind: 'overhead', text: parts.join(' · ') }
}

// The next message's cost once the cache lapses, for the expiry notification.
export const resumeCost = (s: SpendInputs) => {
  const p = unitPrices(s)
  return p === null || s.context === null ? null : s.context * p.write1h
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
// A turn writing this much output is shown, with what it cost.
export const OUTPUT_WARN_TOKENS = 30_000
// The band's hit rate turns amber below this.
export const RATE_WARN = 0.8

export const formatTokens = tokens

// A turn re-wrote context the cache should have held, for no reason the band
// knows of (an expired cache, a compaction, a model switch, a fresh session):
// something in the prompt's prefix changed.
export const cacheMissWarning = (s: SpendInputs, t: TurnTokens | null, cause: string | null): SpendWarning | null => {
  if (t === null || cause !== null || t.missed < MISS_MIN_TOKENS) return null
  const p = unitPrices(s)
  const rate = hitRate(t)
  const extra = p === null ? '' : ` ≈ ${usd(t.missed * (p.write1h - p.read))} extra`
  return {
    kind: 'cache-miss',
    text: `Cache miss: last turn re-wrote ${tokens(t.missed)}${extra}${rate === null ? '' : ` (hit ${Math.round(rate * 100)}%)`} · a tool, MCP, CLAUDE.md or plugin change resets the cache`,
  }
}

// A turn whose output alone ran long: output is priced several times input.
export const outputWarning = (s: SpendInputs, t: TurnTokens | null): SpendWarning | null => {
  if (t === null || t.output < OUTPUT_WARN_TOKENS) return null
  const p = unitPrices(s)
  const cost = p === null ? '' : ` ≈ ${usd(t.output * p.output)}`
  const ratio = p === null ? null : Math.round(p.output / p.input)
  return {
    kind: 'output',
    text: `Output-heavy turn: ${tokens(t.output)} tokens out${cost}${ratio === null ? '' : ` · output costs ${ratio}× input`}`,
  }
}

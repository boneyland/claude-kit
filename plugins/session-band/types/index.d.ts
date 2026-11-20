export type Stats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  context: number
  costAtStart: number
  // What each recent main turn cost, oldest first; the last RECENT_TURNS.
  recentCosts?: number[]
  // The saved total of an earlier launch when the engine's cost counts from this one.
  costOffset?: number
  // What the turn's subagents spent, a part of turnCost; absent before the first measure.
  agentsCost?: number
}

// Each agent's cost (USD) when the main turn started, and as last seen, by agent id.
export type AgentSpend = {
  base: Record<string, number>
  seen: Record<string, number>
}

export type Cache = {
  expiresAt: number | null
  secondsLeft: number | null
}

// A plan rate-limit window: `five_hour`, `seven_day` or a gateway's `spend_limit`.
export type Limit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

// The main loop's running turn; startedAt null between turns.
export type TurnClock = {
  startedAt: number | null
  seconds: number
}

export type Git = {
  branch: string
  isDirty: boolean
}

// The spend warnings' inputs: measured tokens, and list price calibrated to the engine's cost.
export type Spend = {
  model: string | null
  // C: the input tokens of the main loop's last request.
  context: number | null
  // B: a fresh session's first request in this project, or /context's non-conversation rows.
  baseline: number | null
  isBaselineMeasured: boolean
  // The engine's cost over list price, null until a turn measured it.
  scale: number | null
  // Requests each recent main turn made, oldest first; the last RECENT_TURNS.
  recentSteps: number[]
  // Median measured compaction summary, in tokens.
  summary: number | null
  // The running main turn: its requests, list price of every loop's responses, cost at its start.
  steps: number
  predicted: number
  usdAtTurnStart: number
  calibPredicted: number
  calibObserved: number
  // The context size when the overhead warning was dismissed.
  dismissedAt: number | null
  isFresh: boolean
  isCompactPending: boolean
}

// A main turn's tokens: input uncached, read from and written to the cache; output;
// and the previous request's context it did not read from the cache.
export type TurnTokens = { uncached: number; read: number; write: number; output: number; missed: number }

// Token counts: the session's, every loop's; the running and the last main turn's.
export type Tokens = {
  input: number
  output: number
  turn: TurnTokens
  last: TurnTokens | null
  // The main loop's last request: its whole input, and its model.
  prevContext: number | null
  prevModel: string | null
  // Why the running (and the last) turn re-wrote the cache, when the band knows: expired, compacted, model, fresh.
  cause: string | null
  lastCause: string | null
  // The turn whose cache-miss or output warning was dismissed.
  dismissedTurn: number
}

// The pace projection's readings of the plan windows, by kind: each [time ms, % used]
// with each model's forecast noted at 25/50/75% through.
export type PaceWindow = {
  resetsAt: number
  samples: [number, number][]
  checks: Partial<Record<'25' | '50' | '75', Partial<Record<'smooth' | 'linear' | 'snaive' | 'profile', number>>>>
}
// The current and the last finished window by kind; the hour-of-week profile
// learned from finished weeks; and the heads-up dismissed, `kind:resetsAt`.
export type Pace = {
  windows: Partial<Record<'five_hour' | 'seven_day', PaceWindow>>
  prev: Partial<Record<'five_hour' | 'seven_day', PaceWindow>>
  profile: { points: number[]; weeks: number } | null
  dismissed: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': { stats: Stats; cache: Cache; limits: Limit[]; isHidden: boolean; isBusy: boolean; warned: number; effort: string | null; turnClock: TurnClock; git: Git | null; spend: Spend; agentSpend: AgentSpend; tokens: Tokens; pace: Pace }
  }
}

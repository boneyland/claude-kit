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

declare module 'claude-code' {
  interface PluginState {
    'session-band': { stats: Stats; cache: Cache; limits: Limit[]; isHidden: boolean; isBusy: boolean; warned: number; effort: string | null; turnClock: TurnClock; git: Git | null; spend: Spend }
  }
}

export type Stats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  context: number
  costAtStart: number
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

declare module 'claude-code' {
  interface PluginState {
    'session-band': { stats: Stats; cache: Cache; limits: Limit[]; isHidden: boolean; isBusy: boolean; warned: number; effort: string | null; turnClock: TurnClock; git: Git | null }
  }
}

export type Check = {
  name: string
  url: string
  // when this run started, as GitHub gives it: a re-run has a later one
  at?: string
}

// One pull request as gh reported it on the last poll.
export type PrStatus = {
  url: string
  number: number
  repo: string
  title: string
  // OPEN, MERGED or CLOSED
  state: string
  branch: string
  base: string
  sha: string
  isConflicting: boolean
  failing: Check[]
  // checks still running; after decide(), only those not stuck
  pending: number
  // when each pending check started (epoch ms), null where GitHub gives no time (queued)
  pendingStarts?: (number | null)[]
  // pending checks that have run or waited over an hour: counted as not running
  stalled?: number
  labels?: string[]
  total: number
}

// A watched pull request: what the last poll saw, and what pr-watch has
// already asked Claude to fix, so a broken commit is reported once.
export type Watched = {
  url: string
  number: number
  repo: string
  title: string
  status: PrStatus | null
  // the last gh error; empty when the last poll worked
  error: string
  // what each kind of fix was last asked for: the head commit for a conflict;
  // for CI, the head commit and its failing runs (see ciKey), or a bare commit from before 0.8.0
  prompted: { ci: string; conflict: string }
  // fixes asked for since the PR was last healthy
  attempts: number
  // the attempts ran out; cleared when the PR is healthy again
  hasGivenUp: boolean
  // the base branch when watching started: a PR retargeted elsewhere is dropped
  base?: string
  // the head commit, and when pr-watch first saw it: the age of a queued check
  headSince?: { sha: string; at: number }
}

declare module 'claude-code' {
  interface PluginState {
    'pr-watch': {
      // The pull requests this session watches, in the order they were added.
      watched: Watched[]
      // Whether the panel is up, for the footer button's label.
      isOpen: boolean
      // The reply to the panel's last action; empty for none.
      notice: string
      // The PR a turn that pr-watch started is fixing, while that turn runs: its tool calls are fenced.
      fence: { branch: string; number: number } | null
    }
  }
}

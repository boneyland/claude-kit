export type Check = { name: string; url: string }

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
  pending: number
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
  // the head commit each kind of fix was last asked for
  prompted: { ci: string; conflict: string }
  // fixes asked for since the PR was last healthy
  attempts: number
  // the attempts ran out; cleared when the PR is healthy again
  hasGivenUp: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pr-watch': {
      // The pull requests this session watches, in the order they were added.
      watched: Watched[]
    }
  }
}

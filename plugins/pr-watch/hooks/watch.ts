// What pr-watch reads from `gh pr view --json` and decides from it, kept free of
// the engine so it can be tested as plain functions.

export const FIELDS =
  'number,url,title,state,headRefName,baseRefName,headRefOid,mergeable,statusCheckRollup'

import type { Check, PrStatus, Watched } from '../types'

export type { Check, PrStatus, Watched }

type RawCheck = {
  __typename?: string
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string
  detailsUrl?: string
  startedAt?: string
  context?: string
  state?: string
  targetUrl?: string
}

const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATUS = new Set(['FAILURE', 'ERROR'])
const PENDING_STATUS = new Set(['PENDING', 'EXPECTED'])

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/

// "owner/repo" from a pull request URL.
export function repoOf(url: string): string {
  return PR_URL.exec(url)?.[1] ?? ''
}

// Reads `gh pr view --json <FIELDS>` output. Throws on output that is not that.
export function readStatus(json: string): PrStatus {
  const raw = JSON.parse(json) as Record<string, unknown>
  if (typeof raw.url !== 'string' || typeof raw.number !== 'number') {
    throw new Error('gh returned no pull request')
  }
  // A re-run check appears again: keep the latest of each.
  const latest = new Map<string, RawCheck>()
  for (const check of (raw.statusCheckRollup as RawCheck[] | null) ?? []) {
    const key =
      check.__typename === 'StatusContext'
        ? `status:${check.context}`
        : `run:${check.workflowName ?? ''}/${check.name ?? ''}`
    const seen = latest.get(key)
    if (!seen || (check.startedAt ?? '') >= (seen.startedAt ?? '')) latest.set(key, check)
  }
  const failing: Check[] = []
  let pending = 0
  for (const check of latest.values()) {
    if (check.__typename === 'StatusContext') {
      const state = check.state ?? ''
      if (FAILED_STATUS.has(state)) failing.push({ name: check.context ?? '?', url: check.targetUrl ?? '' })
      else if (PENDING_STATUS.has(state)) pending += 1
    } else if (check.status !== 'COMPLETED') {
      pending += 1
    } else if (FAILED_RUN.has(check.conclusion ?? '')) {
      const name = check.workflowName ? `${check.workflowName} / ${check.name}` : (check.name ?? '?')
      failing.push({ name, url: check.detailsUrl ?? '' })
    }
  }

  return {
    url: raw.url,
    number: raw.number,
    repo: repoOf(raw.url),
    title: String(raw.title ?? ''),
    state: String(raw.state ?? ''),
    branch: String(raw.headRefName ?? ''),
    base: String(raw.baseRefName ?? ''),
    sha: String(raw.headRefOid ?? ''),
    // UNKNOWN (GitHub still computing it, as after a push) is not a conflict
    isConflicting: raw.mergeable === 'CONFLICTING',
    failing,
    pending,
    total: latest.size,
  }
}

export function newWatched(status: PrStatus): Watched {
  return {
    url: status.url,
    number: status.number,
    repo: status.repo,
    title: status.title,
    status,
    error: '',
    prompted: { ci: '', conflict: '' },
    attempts: 0,
    hasGivenUp: false,
  }
}

export type Rules = { fixCi: boolean; fixConflicts: boolean; maxAttempts: number }
export type Problem = 'ci' | 'conflict'

export type Decision = {
  next: Watched
  // what to ask Claude to fix now; empty for nothing
  problems: Problem[]
  // the attempts ran out on this poll (reported once)
  isGivingUp: boolean
  // merged or closed: stop watching it
  isDone: boolean
}

// What a poll's status means for a watched PR. CI is reported once every check
// on the head commit has finished, so the prompt names all the failures;
// a conflict as soon as GitHub reports one. Each is asked for once per head
// commit: a fix pushes a new one.
export function decide(watched: Watched, status: PrStatus, rules: Rules): Decision {
  const seen: Watched = { ...watched, status, title: status.title, error: '' }
  const quiet = { problems: [] as Problem[], isGivingUp: false, isDone: false }
  if (status.state !== 'OPEN') return { ...quiet, next: seen, isDone: true }

  const isHealthy = status.failing.length === 0 && !status.isConflicting && status.pending === 0
  if (isHealthy) return { ...quiet, next: { ...seen, attempts: 0, hasGivenUp: false } }

  const ciDue =
    rules.fixCi && status.pending === 0 && status.failing.length > 0 && watched.prompted.ci !== status.sha
  const conflictDue = rules.fixConflicts && status.isConflicting && watched.prompted.conflict !== status.sha
  const problems: Problem[] = []
  if (conflictDue) problems.push('conflict')
  if (ciDue) problems.push('ci')
  if (problems.length === 0) return { ...quiet, next: seen }

  if (watched.attempts >= rules.maxAttempts) {
    return { ...quiet, next: { ...seen, hasGivenUp: true }, isGivingUp: !watched.hasGivenUp }
  }

  const prompted = {
    ci: ciDue ? status.sha : watched.prompted.ci,
    conflict: conflictDue ? status.sha : watched.prompted.conflict,
  }

  return { ...quiet, next: { ...seen, prompted, attempts: watched.attempts + 1 }, problems }
}

// The prompt that wakes the session to fix a PR.
export function buildPrompt(status: PrStatus, problems: Problem[], allowPush: boolean): string {
  const lines = [
    `pr-watch: PR #${status.number} in ${status.repo} needs a fix.`,
    status.url,
    `Branch \`${status.branch}\` into \`${status.base}\`, head ${status.sha.slice(0, 7)}: "${status.title}"`,
    '',
  ]
  if (problems.includes('conflict')) {
    lines.push(
      `- Merge conflict with \`${status.base}\`. Merge \`${status.base}\` into \`${status.branch}\` and resolve the conflicts (merge, not rebase, so no force-push is needed).`,
    )
  }
  if (problems.includes('ci')) {
    lines.push('- CI failed:')
    for (const check of status.failing) lines.push(`  - ${check.name}${check.url ? ` (${check.url})` : ''}`)
    lines.push(
      '  Read the failing logs (`gh run view <run-id> --log-failed`, the run id is in the URL), reproduce locally where you can, and fix the cause.',
    )
  }
  lines.push(
    '',
    "Work on the PR's branch: check it out, or use a worktree if this checkout has other work in it.",
    allowPush
      ? 'Commit the fix and push it to the PR branch: the user allows pushing fixes to the PRs pr-watch watches. Never force-push or merge the PR.'
      : 'Commit the fix, then ask the user before pushing.',
    "If it can't be fixed safely (the failure is flaky, external, or needs a decision), say so instead of guessing.",
  )

  return lines.join('\n')
}

export type Tone = 'success' | 'error' | 'warning' | 'subtle'

// One short label for the band.
export function label(watched: Watched): { text: string; tone: Tone } {
  const s = watched.status
  const pr = `#${watched.number}`
  if (watched.error) return { text: `${pr} ? ${watched.error.slice(0, 40)}`, tone: 'warning' }
  if (!s) return { text: `${pr} …`, tone: 'subtle' }
  const fixing = (kind: Problem) => (watched.prompted[kind] === s.sha && !watched.hasGivenUp ? ' · fixing' : '')
  const parts: string[] = []
  if (s.isConflicting) parts.push(`conflict${fixing('conflict')}`)
  if (s.failing.length > 0) {
    const tail = s.pending > 0 ? ` (${s.pending} running)` : fixing('ci')
    parts.push(`✗ ${s.failing.length} failed${tail}`)
  }
  if (parts.length > 0) {
    return { text: `${pr} ${parts.join(', ')}${watched.hasGivenUp ? ' · gave up' : ''}`, tone: 'error' }
  }
  if (s.pending > 0) return { text: `${pr} ⏳ ${s.total - s.pending}/${s.total}`, tone: 'subtle' }

  return { text: `${pr} ✓`, tone: 'success' }
}

// The footer button's label while the panel is closed: `PRs` with nothing
// watched, `PRs 2✓` all green, else what needs a look (`PRs ✗1 ⏳1`).
export function summary(list: Watched[]): string {
  const counts = { '✗': 0, '⏳': 0, '?': 0 }
  for (const w of list) {
    const s = w.status
    if (w.error) counts['?'] += 1
    else if (s && (s.failing.length > 0 || s.isConflicting)) counts['✗'] += 1
    else if (!s || s.pending > 0) counts['⏳'] += 1
  }
  if (list.length === 0) return 'PRs'
  const marks = Object.entries(counts).filter(([, n]) => n > 0)

  return marks.length === 0 ? `PRs ${list.length}✓` : `PRs ${marks.map(([mark, n]) => `${mark}${n}`).join(' ')}`
}

export type Command =
  | { kind: 'watch'; target: string }
  | { kind: 'unwatch'; target: string }
  | { kind: 'list' }
  | { kind: 'check' }
  | { kind: 'error'; text: string }

export const USAGE = 'Usage: /pr-watch [<number> | <PR url>] | stop [<number> | <PR url> | all] | list | check'

const TARGET = /^(#?\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*)$/

export function parseArgs(args: string): Command {
  const [word = '', rest = '', extra] = args.trim().split(/\s+/)
  const error = { kind: 'error', text: USAGE } as const
  if (extra !== undefined) return error
  if (word === '') return { kind: 'watch', target: '' }
  if (word === 'list' || word === 'status') return rest ? error : { kind: 'list' }
  if (word === 'check' || word === 'now') return rest ? error : { kind: 'check' }
  if (word === 'stop' || word === 'off' || word === 'unwatch') {
    if (rest === '' || rest === 'all') return { kind: 'unwatch', target: 'all' }

    return TARGET.test(rest) ? { kind: 'unwatch', target: rest.replace(/^#/, '') } : error
  }

  return TARGET.test(word) && rest === '' ? { kind: 'watch', target: word.replace(/^#/, '') } : error
}

// Whether a /pr-watch target (a number or a PR URL) names this PR.
export function matches(watched: Watched, target: string): boolean {
  if (/^\d+$/.test(target)) return watched.number === Number(target)
  const found = PR_URL.exec(target)

  return found !== null && watched.repo === found[1] && watched.number === Number(found[2])
}

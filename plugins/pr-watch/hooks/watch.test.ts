import { expect, test } from 'claude-code/testing'

import { buildPrompt, decide, label, matches, newWatched, parseArgs, readStatus } from './watch'
import type { PrStatus, Rules } from './watch'

const URL = 'https://github.com/acme/app/pull/12'
const RULES: Rules = { fixCi: true, fixConflicts: true, maxAttempts: 2 }

function gh(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    url: URL,
    title: 'Add thing',
    state: 'OPEN',
    headRefName: 'feat',
    baseRefName: 'main',
    headRefOid: 'aaaaaaa1111',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    ...fields,
  })
}

const run = (name: string, status: string, conclusion = '', startedAt = '2026-01-01T00:00:00Z') => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status,
  conclusion,
  startedAt,
  detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${name}`,
})

function status(fields: Partial<PrStatus> = {}): PrStatus {
  return { ...readStatus(gh()), ...fields }
}

test('reads failing, pending and conflicting from gh', () => {
  const s = readStatus(
    gh({
      mergeable: 'CONFLICTING',
      statusCheckRollup: [
        run('lint', 'COMPLETED', 'FAILURE'),
        run('test', 'IN_PROGRESS'),
        run('docs', 'COMPLETED', 'SKIPPED'),
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://x/1' },
      ],
    }),
  )
  expect(s.repo).toBe('acme/app')
  expect(s.isConflicting).toBe(true)
  expect(s.failing).toEqual([
    { name: 'CI / lint', url: 'https://github.com/acme/app/actions/runs/1/job/lint' },
    { name: 'ci/legacy', url: 'https://x/1' },
  ])
  expect(s.pending).toBe(1)
  expect(s.total).toBe(4)
})

test('a re-run check counts by its latest run; UNKNOWN is no conflict', () => {
  const s = readStatus(
    gh({
      mergeable: 'UNKNOWN',
      statusCheckRollup: [
        run('test', 'COMPLETED', 'FAILURE', '2026-01-01T00:00:00Z'),
        run('test', 'COMPLETED', 'SUCCESS', '2026-01-01T01:00:00Z'),
      ],
    }),
  )
  expect(s.failing).toEqual([])
  expect(s.isConflicting).toBe(false)
  expect(() => readStatus('{"message":"no"}')).toThrow()
})

test('CI is reported once all checks finished, once per head commit', () => {
  const w = newWatched(status())
  const failed = { name: 'CI / lint', url: '' }

  // still running: wait
  const early = decide(w, status({ failing: [failed], pending: 1 }), RULES)
  expect(early.problems).toEqual([])

  const done = decide(early.next, status({ failing: [failed] }), RULES)
  expect(done.problems).toEqual(['ci'])
  expect(done.next.attempts).toBe(1)

  // the same commit again: already asked
  expect(decide(done.next, status({ failing: [failed] }), RULES).problems).toEqual([])

  // a new commit that fails too: asked again
  const again = decide(done.next, status({ failing: [failed], sha: 'bbbbbbb' }), RULES)
  expect(again.problems).toEqual(['ci'])
})

test('a conflict is reported at once, with CI when both are due', () => {
  const w = newWatched(status())
  const both = decide(w, status({ isConflicting: true, failing: [{ name: 'x', url: '' }] }), RULES)
  expect(both.problems).toEqual(['conflict', 'ci'])
  expect(both.next.attempts).toBe(1)

  const off = decide(w, status({ isConflicting: true }), { ...RULES, fixConflicts: false })
  expect(off.problems).toEqual([])
})

test('gives up after maxAttempts, says so once, and starts over when healthy', () => {
  let w = newWatched(status())
  const failed = [{ name: 'x', url: '' }]
  w = decide(w, status({ failing: failed, sha: 'c1' }), RULES).next
  w = decide(w, status({ failing: failed, sha: 'c2' }), RULES).next
  expect(w.attempts).toBe(2)

  const third = decide(w, status({ failing: failed, sha: 'c3' }), RULES)
  expect(third.problems).toEqual([])
  expect(third.isGivingUp).toBe(true)
  expect(decide(third.next, status({ failing: failed, sha: 'c4' }), RULES).isGivingUp).toBe(false)

  const healthy = decide(third.next, status({ sha: 'c5' }), RULES)
  expect(healthy.next.attempts).toBe(0)
  expect(healthy.next.hasGivenUp).toBe(false)
})

test('a merged or closed PR is done', () => {
  expect(decide(newWatched(status()), status({ state: 'MERGED' }), RULES).isDone).toBe(true)
})

test('the prompt names the PR, the failures and the push rule', () => {
  const s = status({ isConflicting: true, failing: [{ name: 'CI / lint', url: 'https://u/1' }] })
  const text = buildPrompt(s, ['conflict', 'ci'], true)
  expect(text).toContain('PR #12 in acme/app')
  expect(text).toContain(URL)
  expect(text).toContain('Merge `main` into `feat`')
  expect(text).toContain('CI / lint (https://u/1)')
  expect(text).toContain('push it to the PR branch')
  expect(buildPrompt(s, ['ci'], false)).toContain('ask the user before pushing')
  expect(buildPrompt(s, ['ci'], false)).not.toContain('Merge conflict')
})

test('labels', () => {
  const w = newWatched(status())
  expect(label(w)).toEqual({ text: '#12 ✓', tone: 'success' })
  expect(label({ ...w, status: status({ pending: 2, total: 5 }) }).text).toBe('#12 ⏳ 3/5')
  const failing = status({ failing: [{ name: 'x', url: '' }] })
  expect(label({ ...w, status: failing }).text).toBe('#12 ✗ 1 failed')
  expect(label({ ...w, status: failing, prompted: { ci: failing.sha, conflict: '' } }).text).toBe(
    '#12 ✗ 1 failed · fixing',
  )
  expect(label({ ...w, error: 'HTTP 401' })).toEqual({ text: '#12 ? HTTP 401', tone: 'warning' })
})

test('arguments', () => {
  expect(parseArgs('')).toEqual({ kind: 'watch', target: '' })
  expect(parseArgs('#12')).toEqual({ kind: 'watch', target: '12' })
  expect(parseArgs(URL)).toEqual({ kind: 'watch', target: URL })
  expect(parseArgs('stop')).toEqual({ kind: 'unwatch', target: 'all' })
  expect(parseArgs('stop 12')).toEqual({ kind: 'unwatch', target: '12' })
  expect(parseArgs('list')).toEqual({ kind: 'list' })
  expect(parseArgs('check')).toEqual({ kind: 'check' })
  expect(parseArgs('12 13').kind).toBe('error')
  expect(parseArgs('--repo x').kind).toBe('error')
  expect(parseArgs('https://evil.example/pull/1').kind).toBe('error')
})

test('targets match by number or URL', () => {
  const w = newWatched(status())
  expect(matches(w, '12')).toBe(true)
  expect(matches(w, '13')).toBe(false)
  expect(matches(w, `${URL}/files`)).toBe(true)
  expect(matches(w, 'https://github.com/acme/other/pull/12')).toBe(false)
})

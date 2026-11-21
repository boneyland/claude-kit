import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://github.com/acme/app/pull/12'

function pr(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    url: URL,
    title: 'Add thing',
    state: 'OPEN',
    headRefName: 'feat',
    baseRefName: 'main',
    headRefOid: 'aaaaaaa1111',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'test',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/acme/app/actions/runs/7/job/8',
      },
    ],
    ...fields,
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a failing PR wakes the session once; merged, it is dropped`, async ($, on) => {
    const clock = mock.clock(on)
    let reply = pr()
    const ran: string[][] = []
    const prompts: string[] = []
    on('process.run', (_$, e) => {
      ran.push([...e.argv])

      return { value: { exitCode: 0, stdout: reply, stderr: '' } } as never
    })
    on('prompt.submit', (_$, e) => {
      prompts.push(e.text)

      return { text: e.text } as never
    })
    on('command.register', () => ({ value: { command: 'pr-watch' } }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const watching = await $.command.run({ command: 'pr-watch', args: '' } as never)
    expect(ran[0]).toEqual(['gh', 'pr', 'view', '--json', expect.any(String)])
    expect(JSON.stringify(watching)).toContain('Watching #12 ✗ 1 failed')
    // a command hook can't submit a prompt: the first check runs from a timer
    expect(prompts.length).toBe(0)
    await clock.settle()

    // CI had already failed: Claude is asked to fix it, naming the PR and the run
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('PR #12 in acme/app')
    expect(prompts[0]).toContain('CI / test (https://github.com/acme/app/actions/runs/7/job/8)')

    const ui = await $.ui.mount({
      plugin: 'pr-watch',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false },
    } as never)
    expect((await ui.find({ type: 'Text', text: /#12/ }))?.text).toBe('#12 ✗ 1 failed · fixing')
    await ui.unmount()

    // the next poll sees the same broken commit: not asked twice
    await clock.advance(90_000)
    expect(ran.length).toBe(2)
    expect(ran[1]).toContain(URL)
    expect(prompts.length).toBe(1)

    // merged: no longer watched
    reply = pr({ state: 'MERGED' })
    await clock.advance(90_000)
    const listed = await $.command.run({ command: 'pr-watch', args: 'list' } as never)
    expect(JSON.stringify(listed)).toContain('No PRs watched')
  })
}

test('a gh failure is reported, not thrown', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' } }) as never)
  const result = await $.command.run({ command: 'pr-watch', args: '' } as never)
  expect(JSON.stringify(result)).toContain('no pull requests found for branch')
})

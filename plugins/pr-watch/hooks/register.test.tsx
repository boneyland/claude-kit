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

// Terminal only: the desktop app draws none of it (see below).
for (const surface of ['terminal'] as const) {
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
    expect(prompts[0]).toContain('"CI / test" (https://github.com/acme/app/actions/runs/7/job/8)')

    const shown = JSON.stringify(await $.command.run({ command: 'pr-watch', args: 'list' } as never))
    expect(shown).toContain('#12 ✗ 1 failed · fixing')

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

test('watching the same PR twice keeps one row and asks once', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: pr(), stderr: '' } }) as never)
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)

    return { text: e.text } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)

  await $.command.run({ command: 'pr-watch', args: '' } as never)
  await clock.settle()
  const again = await $.command.run({ command: 'pr-watch', args: '12' } as never)
  await clock.settle()

  expect(JSON.stringify(again)).toContain('Already watching')
  expect(prompts.length).toBe(1)
  const listed = JSON.stringify(await $.command.run({ command: 'pr-watch', args: 'list' } as never))
  expect(listed.split('#12').length - 1).toBe(1)
})

test('no band above the prompt', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: pr(), stderr: '' } }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.command.run({ command: 'pr-watch', args: '' } as never)
  await clock.settle()

  const ui = await $.ui.mount({
    plugin: 'pr-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false },
  } as never)
  expect(await ui.find({ type: 'Text', text: /#12/ })).toBeUndefined()
  await ui.unmount()
})

test('a gh failure is reported, not thrown', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' } }) as never)
  const result = await $.command.run({ command: 'pr-watch', args: '' } as never)
  expect(JSON.stringify(result)).toContain('no pull requests found for branch')
})

test('a session outside the terminal registers no /pr-watch and never polls', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[][] = []
  const registered: string[] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: pr(), stderr: '' } } as never
  })
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { command: e.name } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(300_000)
  expect(registered).toEqual([])
  expect(ran).toEqual([])
})

test('the turn a pr-watch prompt opens is fenced; the user\'s own turns are not', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const ran: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: pr(), stderr: '' } }) as never)
  on('prompt.submit', (_$, e) => (prompts.push(e.text), { text: e.text }) as never)
  on('command.register', () => ({ value: { command: 'pr-watch' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('tool.call', (_$, e) => (ran.push(String((e as { command?: string }).command ?? e.tool)), { result: {} }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'pr-watch', args: '' } as never)
  await clock.settle()
  expect(prompts.length).toBe(1)

  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  const end = (turnId: string) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)

  await $.turn.start({ text: prompts[0]!, turnId: 'fix' })
  const forced = await bash('git push --force')
  expect(String((forced as { deny?: string }).deny)).toContain('pr-watch refused this while it is fixing PR #12')
  expect(String(((await $.tool.call({ tool: 'Edit', file_path: '/r/.mcp.json', old_string: 'a', new_string: 'b' } as never)) as { deny?: string }).deny)).toContain('.mcp.json')
  // A subagent in that turn is fenced too.
  expect(((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12', agentId: 'a1' } as never)) as { deny?: string }).deny).toBeDefined()
  await bash('git push origin feat')
  expect(ran).toEqual(['git push origin feat'])
  await end('fix')

  // The user's own turn: no fence.
  await $.turn.start({ text: 'push it with force please', turnId: 'mine' })
  await bash('git push --force')
  expect(ran).toEqual(['git push origin feat', 'git push --force'])
  await end('mine')
})

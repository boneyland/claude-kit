import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://github.com/acme/app/pull/12'
const RUN = 'https://github.com/acme/app/actions/runs/7/job/8'

type PaneRow = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

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
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN },
    ],
    ...fields,
  })
}

const PANE = {
  plugin: 'pr-watch',
  component: 'Pane',
  requestId: 'pr-watch',
  props: {
    title: 'PR watch',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// The engine beneath the plugin: panes, gh, prompts and toasts.
function engine(on: On) {
  const world = {
    panes: [] as PaneRow[],
    reply: { exitCode: 0, stdout: pr(), stderr: '' },
    ran: [] as string[][],
    prompts: [] as string[],
  }
  on('ui.panes', () => ({ value: world.panes }) as never)
  on('ui.open', (_$, e) => {
    world.panes = [{ id: e.id, title: 'PR watch', isShown: true, isFocused: false, isPlaced: true }]

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => {
    world.panes = []

    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    world.ran.push([...e.argv])

    return { value: world.reply } as never
  })
  on('prompt.submit', (_$, e) => {
    world.prompts.push(e.text)

    return { text: e.text } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return world
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the footer button summarises and toggles the panel`, async ($, on) => {
    const clock = mock.clock(on)
    const world = engine(on)
    const ui = await $.ui.mount({ plugin: 'pr-watch', component: 'SessionMode', surface, props: { modes: [] } })
    const label = async () => (await ui.find({ type: 'Button', key: 'pr-watch-toggle' }))?.props.label

    // always shown, even with nothing watched
    expect(await label()).toBe('PRs')
    await ui.press({ key: 'pr-watch-toggle' })
    expect(world.panes.map(p => p.id)).toEqual(['pr-watch'])
    expect(await label()).toBe('Hide PRs')
    await ui.press({ key: 'pr-watch-toggle' })
    expect(world.panes).toEqual([])
    expect(await label()).toBe('PRs')

    await $.command.run({ command: 'pr-watch', args: '' } as never)
    await clock.settle()
    expect(await label()).toBe('PRs ✗1')

    // /pr-watch panel toggles the same pane, and the button follows it
    // (the test kit can't raise the person's own close mark)
    await $.command.run({ command: 'pr-watch', args: 'panel' } as never)
    expect(await label()).toBe('Hide PRs')
    await $.command.run({ command: 'pr-watch', args: 'panel' } as never)
    expect(world.panes).toEqual([])
    expect(await label()).toBe('PRs ✗1')
    await ui.unmount()
  })

  test(`${surface}: the panel watches, shows, checks and stops`, async ($, on) => {
    const clock = mock.clock(on)
    const world = engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /No PRs watched/ })).toBeDefined()
    await ui.press({ key: 'watch-branch' })
    await clock.settle()
    expect(world.ran[0]).toEqual(['gh', 'pr', 'view', '--json', expect.any(String)])
    expect((await ui.find({ type: 'Text', text: /#12/ }))?.text).toContain('#12 ✗ 1 failed')
    expect(await ui.find({ type: 'Link', text: /CI \/ test/ })).toBeDefined()
    const links = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(links).toContain(URL)
    expect(links).toContain(RUN)
    // the PR was already failing: Claude is asked to fix it
    expect(world.prompts.length).toBe(1)

    await ui.press({ key: 'check' })
    expect(world.ran.at(-1)).toContain(URL)
    expect(await ui.find({ type: 'Text', text: /Checked 1 PR\./ })).toBeDefined()

    await ui.press({ key: 'stop-12' })
    expect(await ui.find({ type: 'Text', text: /#12/ })).toBeUndefined()

    // typed text that is no PR: the usage, nothing watched
    await ui.input({ key: 'target', text: 'nope' })
    expect(await ui.find({ type: 'Text', text: /Usage:/ })).toBeDefined()
    expect(world.ran.length).toBe(2)

    // a number typed watches that PR
    await ui.input({ key: 'target', text: '12' })
    await clock.settle()
    expect(world.ran.at(-1)?.slice(0, 4)).toEqual(['gh', 'pr', 'view', '12'])
    expect(await ui.find({ type: 'Text', text: /#12/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a failed watch is told in the panel`, async ($, on) => {
    mock.clock(on)
    const world = engine(on)
    world.reply = { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"' }
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'watch-branch' })
    expect(await ui.find({ type: 'Text', text: /no pull requests found/ })).toBeDefined()
    await ui.unmount()
  })
}

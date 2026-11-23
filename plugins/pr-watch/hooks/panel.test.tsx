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
type Reply = { exitCode: number; stdout: string; stderr: string }

// `answer`, when given, replies to each gh call in place of `world.reply`.
function engine(on: On, answer?: (argv: string[]) => Reply | Promise<Reply>) {
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
  on('process.run', async (_$, e) => {
    world.ran.push([...e.argv])

    return { value: answer ? await answer([...e.argv]) : world.reply } as never
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

// Terminal only: the desktop app draws none of it (see below).
for (const surface of ['terminal'] as const) {
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
    // the settings rows: the current interval marked, push fixes on by default
    expect((await ui.find({ type: 'Button', key: 'every-90' }))?.props.label).toBe('[90 s]')
    expect((await ui.find({ type: 'Button', key: 'push' }))?.props.label).toBe('on')
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

    await ui.press({ key: `stop-${URL}` })
    expect(await ui.find({ type: 'Text', text: /#12 ✗/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Stopped watching #12/ })).toBeDefined()

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

  test(`${surface}: watching twice at once adds one row and asks once`, async ($, on) => {
    const clock = mock.clock(on)
    // gh takes a second: both watches are in flight together
    const world = engine(on, async () => {
      await clock.sleep(1000)

      return { exitCode: 0, stdout: pr(), stderr: '' }
    })
    const ui = await $.ui.mount({ ...PANE, surface })
    const both = Promise.all([
      ui.press({ key: 'watch-branch' }),
      $.command.run({ command: 'pr-watch', args: '' } as never),
    ])
    await clock.advance(1000)
    await both
    await clock.settle()
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.label === 'Stop').length).toBe(1)
    expect(world.prompts.length).toBe(1)
    await ui.unmount()
  })

  test(`${surface}: Stop removes its own PR when numbers clash or the host isn't github.com`, async ($, on) => {
    const clock = mock.clock(on)
    const other = 'https://github.com/acme/lib/pull/12'
    const ghe = 'https://ghe.example.com/acme/app/pull/7'
    // no target (this branch's PR): the GHE one; else the URL asked for
    engine(on, argv => {
      const target = argv[3] === '--json' ? ghe : (argv[3] ?? ghe)

      return { exitCode: 0, stdout: pr({ url: target, number: target === ghe ? 7 : 12 }), stderr: '' }
    })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'target', text: URL })
    await ui.input({ key: 'target', text: other })
    await ui.press({ key: 'watch-branch' })
    await clock.settle()
    const stops = () => ui.findAll({ type: 'Button' }).then(all => all.filter(b => b.props.label === 'Stop'))
    expect((await stops()).length).toBe(3)

    // stop the second acme #12 (lib): app #12 and the GHE PR stay
    await ui.press({ key: (await stops())[1]?.key ?? '' })
    const hrefs = async () => (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
    expect(await hrefs()).toContain(URL)
    expect(await hrefs()).not.toContain(other)

    // stop the GHE PR
    await ui.press({ key: (await stops())[1]?.key ?? '' })
    expect(await hrefs()).not.toContain(ghe)
    expect((await stops()).length).toBe(1)
    await ui.unmount()
  })

  test(`${surface}: the panel changes the interval and push fixes, and saves them`, async ($, on) => {
    const clock = mock.clock(on)
    const world = engine(on)
    const saved: [string, unknown][] = []
    on('config.set', (_$, e) => {
      saved.push([e.key, e.value])

      return { value: e.value } as never
    })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'watch-branch' })
    await clock.settle()
    const polls = world.ran.length

    await ui.press({ key: 'every-300' })
    expect(saved).toEqual([['pr-watch.intervalSeconds', 300]])
    expect((await ui.find({ type: 'Button', key: 'every-300' }))?.props.label).toBe('[5 min]')
    expect(await ui.find({ type: 'Text', text: /Checks every 5 min\./ })).toBeDefined()
    // the new period applies at once: nothing at 90 s, a poll at 300 s
    await clock.advance(90_000)
    expect(world.ran.length).toBe(polls)
    await clock.advance(210_000)
    expect(world.ran.length).toBe(polls + 1)

    await ui.press({ key: 'push' })
    expect(saved.at(-1)).toEqual(['pr-watch.allowPush', false])
    expect((await ui.find({ type: 'Button', key: 'push' }))?.props.label).toBe('off')
    await ui.unmount()
  })

  test(`${surface}: a refused save still changes the setting for the session`, async ($, on) => {
    mock.clock(on)
    engine(on)
    on('config.set', () => ({ deny: 'managed by policy' }) as never)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'push' })
    expect((await ui.find({ type: 'Button', key: 'push' }))?.props.label).toBe('off')
    expect(await ui.find({ type: 'Text', text: /for this session \(not saved: managed by policy\)/ })).toBeDefined()
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

test('the desktop app draws neither the footer button nor the panel', async ($, on) => {
  engine(on)
  const footer = await $.ui.mount({ plugin: 'pr-watch', component: 'SessionMode', surface: 'desktop', props: { modes: [] } })
  expect(await footer.find({ type: 'Button', key: 'pr-watch-toggle' })).toBe(undefined)
  await footer.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Button' })).toBe(undefined)
  await pane.unmount()
})

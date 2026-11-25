// Fixes for bugs reported against upstream (JohnnyVizz/claude-kit) that this
// fork still had: the issue or pull request is named on each test.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const PROGRESS = 'mcp__savvy-progress__progress'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const
const pane = { title: '', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

// The engine's mocks, then the session started: every mock goes in before the
// first call on $.
function mocks(on: On) {
  mock.clock(on, { now: Date.parse('2026-11-26T02:00:00Z') })
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
}
async function start($: Engine) {
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

let calls = 0
const spawn = ($: Engine, subagentType: string, description = 'Work') =>
  $.agent.spawn({
    tool_use_id: `tu-${++calls}`,
    prompt: 'do it',
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)

const step = async ($: Engine, agentId: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
  for await (const _ of stream) void _
}
const finish = ($: Engine, agentId: string) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId, reason: 'answer', answer: 'ok' })

const bandText = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  await ui.unmount()
  return texts.join(' ')
}
const paneText = async ($: Engine): Promise<string> => {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  await ui.unmount()
  return texts.join(' ')
}

// upstream PR #42
test('a background worker counts as running after its Agent call returns, until it ends', async ($, on) => {
  mocks(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', { tool: 'Agent' }, () => ({ result: 'started in the background' }) as never)
  await start($)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate' } as never)

  // The Agent call returns at once; the worker it started runs on.
  await $.tool.call({ tool: 'Agent', subagent_type: 'savvy-flow:savvy-light', description: 'Work', prompt: 'do it' } as never)
  await spawn($, 'savvy-flow:savvy-light')
  expect(await bandText($)).toMatch(/Tasks 1 running/)

  await finish($, 'a1')
  expect(await bandText($)).toMatch(/Tasks 0 running/)
})

// upstream PR #50
test('only a savvy worker gets the step brief, not any agent of a plugin named savvy-…', async ($, on) => {
  mocks(on)
  const prompts: Record<string, string> = {}
  on('agent.spawn', (_$, e) => {
    prompts[e.subagentType] = e.prompt
    return { model: 'claude-opus-5-5', agentId: e.subagentType }
  })
  await start($)
  await spawn($, 'savvy-tools:helper')
  await spawn($, 'savvy-flow:savvy-light')
  expect(prompts['savvy-tools:helper']).toBe('do it')
  expect(prompts['savvy-flow:savvy-light']).toContain('mcp__savvy-progress__step')
})

// upstream issue #57
test('a named teammate, spawned with no agentId, takes its steps and finishes', async ($, on) => {
  mocks(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', teammateId: 'scout@crew' }))
  on('agent.list', () => ({ value: [{ id: 'a9', teammateId: 'scout@crew', description: 'Scout', type: 'general-purpose', status: 'running' }] as never }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    const usage = { model: 'claude-opus-5-5', input_tokens: 40_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  await start($)
  await spawn($, 'general-purpose', 'Scout')
  await step($, 'a9')
  expect(await paneText($)).toMatch(/42k/)
  expect(await paneText($)).toMatch(/Running · 1/)

  await finish($, 'a9')
  expect(await paneText($)).not.toMatch(/Running · /)
})

// upstream PR #40
test('the tokens total leaves out cache reads, the same context read again', async ($, on) => {
  mocks(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] as never }))
  on('turn.step', async function* () {
    const usage = { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 5_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 5_000 }
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  await start($)
  await spawn($, 'general-purpose')
  await step($, 'a1')
  expect(await paneText($)).toMatch(/· 20k tokens ·/)
})

// upstream PR #56
test('vscode: the agents pane is drawn as Svg, as on the desktop', async ($, on) => {
  mocks(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] as never }))
  await start($)
  await spawn($, 'savvy-light')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'vscode', component: 'Pane', requestId: 'savvy-agents', props: pane })
  expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(0)
  await ui.unmount()
})

// upstream PR #60
test('desktop: the bar shrinks to leave the count and the dismiss on screen', async ($, on) => {
  mocks(on)
  await start($)
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  const [svg] = await ui.findAll({ type: 'Svg' })
  expect(svg.props.width).toBeUndefined()
  expect(await ui.find({ type: 'Box', props: { flexShrink: 1, minWidth: 0 } })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'savvy-dismiss' })).toBeDefined()
  await ui.unmount()
})

// upstream PR #50, its second fix
test('a bare report after the close keeps the finished flow; finished: false reopens it', async ($, on) => {
  mocks(on)
  await start($)
  await $.tool.call({ tool: PROGRESS, title: 'Closing flow', phase: 'delegate', total: 4, done: 3 } as never)
  expect(await $.tool.call({ tool: PROGRESS, finished: true } as never)).toMatchObject({ result: 'ok: Done' })
  expect(await $.tool.call({ tool: PROGRESS, done: 4 } as never)).toMatchObject({ result: 'ok: Done' })
  expect(await bandText($)).toMatch(/Closing flow/)
  expect(await $.tool.call({ tool: PROGRESS, finished: false } as never)).toMatchObject({ result: 'ok: Tasks 4/4' })
  expect(await bandText($)).toMatch(/Closing flow/)
})

test('a flow brought after the close starts over', async ($, on) => {
  mocks(on)
  await start($)
  await $.tool.call({ tool: PROGRESS, title: 'Closing flow', phase: 'delegate', total: 4, done: 3 } as never)
  await $.tool.call({ tool: PROGRESS, finished: true } as never)
  expect(await $.tool.call({ tool: PROGRESS, title: 'Fresh flow', phase: 'delegate', total: 2 } as never)).toMatchObject({ result: 'ok: Tasks 0/2' })
  const text = await bandText($)
  expect(text).toMatch(/Fresh flow/)
  expect(text).not.toMatch(/Closing flow/)
})

// upstream PR #53
test('a worker is asked to close its step count before its final report', async ($, on) => {
  mocks(on)
  let prompt = ''
  on('agent.spawn', (_$, e) => {
    prompt = e.prompt
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  await start($)
  await spawn($, 'savvy-light')
  expect(prompt).toContain('right before your final report with `done` equal to `total`')
})

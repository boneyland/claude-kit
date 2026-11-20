import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { termCrab } from './register'

const PLUGIN = 'savvy-progress'
const text = (rows: { ch: string }[][]) => rows.map(r => r.map(c => c.ch).join(''))

test('the terminal crab is Claude Code\'s Clawd, walking in two frames', () => {
  const a = termCrab(0)
  const b = termCrab(1)
  // The logo as Claude Code draws it.
  expect(text(a)).toEqual([' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '])
  // Arms up, legs across.
  expect(text(b)).toEqual(['▗▐▛███▜▌▖', ' ▜█████▛ ', '  ▝▝ ▘▘  '])
  expect(a.flat().filter(c => c.ch !== ' ').every(c => c.fg === '#D97757')).toBe(true)
  expect(termCrab(2)).toEqual(a)
})

const pane = (bodyColumns: number) => ({ title: '', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }) as const

const spawn = async ($: Engine) => {
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Walking work', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
}

test('a running agent\'s crab walks with the panel\'s tick; a narrow panel keeps the plain mark', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  // The panel's one-second tick is set up at session start.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($)
  const legs = async (cols = 60) => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane(cols) })
    const box = await ui.find({ type: 'Box', key: 'crab' })
    const mark = await ui.find({ type: 'Text', text: '▣' })
    await ui.unmount()
    return { legs: JSON.stringify(box?.children[2]), hasMark: mark !== undefined }
  }
  const first = await legs()
  expect(first.legs).toContain('▘')
  expect(first.hasMark).toBe(false)
  await clock.advance(1000)
  expect((await legs()).legs).not.toBe(first.legs)
  expect((await legs(36)).hasMark).toBe(true)
})

test('agents sit two to a row when the panel is wide, with no bars', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  for (const id of ['t1', 't2', 't3']) {
    await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: `Work ${id}`, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  }
  const mount = (cols: number) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane(cols) })

  const wide = await mount(100)
  // Three agents: a pair, then one.
  const first = await wide.find({ type: 'Box', key: 'pair-a3' })
  expect(first?.children.length).toBe(2)
  expect(await wide.find({ type: 'Text', text: /[░]/ })).toBe(undefined)
  expect(await wide.find({ type: 'Text', text: /ctx 0%/ })).toBeTruthy()
  await wide.unmount()

  const narrow = await mount(60)
  expect(await narrow.find({ type: 'Box', key: 'pair-a3' })).toBe(undefined)
  expect(await narrow.find({ type: 'Text', text: /Work t3/ })).toBeTruthy()
  await narrow.unmount()
})

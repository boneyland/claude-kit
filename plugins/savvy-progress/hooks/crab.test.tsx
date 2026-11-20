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

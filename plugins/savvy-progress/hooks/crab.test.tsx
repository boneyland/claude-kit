import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CRAB_COLS, CRAB_FRAME_MS, CRAB_ROWS, crabKey, crabPose, rasterCells, termCrab } from './register'

const PLUGIN = 'savvy-progress'
const text = (rows: { ch: string }[][]) => rows.map(r => r.map(c => c.ch).join(''))

test('the terminal crab is Claude Code\'s Clawd, walking in two frames', () => {
  const a = termCrab(0)
  const b = termCrab(1)
  // The logo as Claude Code draws it, standing mid-box.
  expect(text(a)).toEqual(['  ▐▛███▜▌  ', ' ▝▜█████▛▘ ', '   ▘▘ ▝▝   '])
  // Arms up, legs across.
  expect(text(b)).toEqual([' ▗▐▛███▜▌▖ ', '  ▜█████▛  ', '   ▝▝ ▘▘   '])
  expect(a.flat().filter(c => c.ch !== ' ').every(c => c.fg === '#D97757')).toBe(true)
  expect(termCrab(2)).toEqual(a)
  // Scuttled to the left edge, then a half cell right of it.
  expect(text(termCrab(0, 0))[0]).toBe(' ▐▛███▜▌   ')
  expect(text(termCrab(0, 1))[0]).toBe('  █▜██▛█   ')
  for (const shift of [0, 1, 2, 3, 4]) expect(termCrab(0, shift).every(r => r.length === CRAB_COLS)).toBe(true)
  expect(termCrab(0).length).toBe(CRAB_ROWS)
})

test('a crab\'s cells are [codePoint, fg, bg] triplets', () => {
  const bytes = (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(rasterCells([[{ ch: '█', fg: '#D97757' }, { ch: ' ' }]]))
  expect([...new Uint32Array(bytes.buffer)]).toEqual([0x2588, 0xd97757, 0x01000000, 0x20, 0x01000000, 0x01000000])
})

test('a running crab moves every frame, each agent at its own point of the walk', () => {
  const poses = [0, 1, 2, 3, 4, 5, 6, 7].map(i => crabPose(i * CRAB_FRAME_MS, 'a1'))
  for (let i = 1; i < poses.length; i++) expect(poses[i]).not.toEqual(poses[i - 1])
  expect(poses.map(p => p[1]).sort()).toEqual([0, 1, 1, 2, 2, 3, 3, 4])
})

const pane = (bodyColumns: number) => ({ title: '', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }) as const

const spawn = async ($: Engine) => {
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Walking work', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
}

test('a running agent\'s crab is a Raster the crab clock repaints; a narrow panel keeps the plain mark', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: {} }) as never)
  on('ui.panes', () => ({ value: [{ id: 'savvy-agents' }] }) as never)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  const blits: { key: string; cells: string }[] = []
  on('ui.blit', (_, e) => {
    blits.push(e as never)
    return { value: {} }
  })
  // The clocks are set up at session start.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane(60) })
  const raster = await ui.find({ type: 'Raster', key: crabKey('a1') })
  expect(raster?.props.columns).toBe(CRAB_COLS)
  expect(raster?.props.cells).toBe(rasterCells(termCrab(...crabPose(1_000_000, 'a1'))))
  expect(await ui.find({ type: 'Text', text: '▣' })).toBe(undefined)
  await ui.unmount()

  // The agent opened the panel: each frame repaints the crab.
  await clock.advance(CRAB_FRAME_MS)
  await clock.advance(CRAB_FRAME_MS)
  expect(blits.length).toBe(2)
  expect(blits[0]!.key).toBe(crabKey('a1'))
  expect(blits[1]!.cells).not.toBe(blits[0]!.cells)
  // Closed: no more.
  await $.command.run({ command: 'agents-info' } as never)
  await clock.advance(CRAB_FRAME_MS)
  expect(blits.length).toBe(2)

  const narrow = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane(36) })
  expect(await narrow.find({ type: 'Text', text: '▣' })).toBeTruthy()
  expect(await narrow.find({ type: 'Raster' })).toBe(undefined)
  await narrow.unmount()
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

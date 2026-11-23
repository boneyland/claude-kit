import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'
const pane = { title: '', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('/agents-info demo fills the panel with made-up agents, and demo off takes them away', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] as never }))

  const added = await $.command.run({ command: 'agents-info', args: 'demo' } as never)
  expect(JSON.stringify(added)).toContain('Demo agents added')
  expect(opened).toEqual(['savvy-agents'])

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  for (const n of [1, 2, 3, 4, 5, 6]) expect(await ui.find({ type: 'Raster', key: `crab-demo-${n}` })).toBeTruthy()
  // Planned tasks from the demo flow, and no Open button on a made-up agent.
  expect(await ui.find({ type: 'Text', text: /Wire the search box/ })).toBeTruthy()
  for (const n of [1, 2, 3, 4, 5, 6]) expect(await ui.find({ type: 'Button', key: `view-demo-${n}` })).toBe(undefined)
  await ui.unmount()

  await $.command.run({ command: 'agents-info', args: 'demo off' } as never)
  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  expect(await after.find({ type: 'Raster' })).toBe(undefined)
  expect(await after.find({ type: 'Text', text: /Wire the search box/ })).toBe(undefined)
  await after.unmount()
})

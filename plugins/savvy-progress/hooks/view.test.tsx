import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'

const pane = { title: '', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const spawn = async ($: Engine, id: string, description: string) => {
  await $.agent.spawn({ tool_use_id: id, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: each agent the engine still holds gets a button that opens its transcript`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
    // a2 has been dropped by the engine: no button for it.
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Kept work', type: 'general-purpose', status: 'running' }] as never }))
    const viewed: unknown[] = []
    on('ui.view', (_$, e) => {
      viewed.push(e)
      return { value: {} }
    })
    await spawn($, 't1', 'Kept work')
    await spawn($, 't2', 'Dropped work')

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'savvy-agents', props: pane })
    expect(await ui.find({ type: 'Button', key: 'view-a1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'view-a2' })).toBeUndefined()
    await ui.press({ key: 'view-a1' })
    expect(viewed).toEqual([{ agentId: 'a1' }])
    await ui.unmount()
  })
}

test('a refused view says why in a toast', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Work', type: 'general-purpose', status: 'completed' }] as never }))
  on('ui.view', () => ({ value: { deny: 'no agent holds the id' } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await spawn($, 't1', 'Work')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: pane })
  await ui.press({ key: 'view-a1' })
  expect(toasts).toEqual(['Transcript not available: no agent holds the id'])
  await ui.unmount()
})

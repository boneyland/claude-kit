import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'savvy-progress'

type PaneRow = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the footer button opens and closes the agents pane`, async ($, on) => {
    mock.clock(on)
    let panes: PaneRow[] = []
    on('ui.panes', () => ({ value: panes }))
    on('ui.open', (_$, e) => {
      panes = [{ id: e.id, title: 'Agents', isShown: true, isFocused: false, isPlaced: true }]
      return { value: { isPlaced: true } }
    })
    on('ui.close', () => {
      panes = []
      return { value: undefined }
    })

    const ui = await $.ui.mount({ plugin: PLUGIN, component: 'SessionMode', surface, props: { modes: ['focus'] } })
    // The engine's own mode labels stay beside the button.
    expect(JSON.stringify((await ui.find({ type: 'Box' }))?.children[0])).toContain('"engine"')
    const label = async () => (await ui.find({ type: 'Button', key: 'savvy-agents-toggle' }))?.props.label

    expect(await label()).toBe('Agents')
    await ui.press({ key: 'savvy-agents-toggle' })
    expect(panes.map(p => p.id)).toEqual(['savvy-agents'])
    expect(await label()).toBe('Hide agents')
    await ui.press({ key: 'savvy-agents-toggle' })
    expect(panes).toEqual([])
    expect(await label()).toBe('Agents')

    // /agents-info toggles the same pane, and the button follows it.
    await $.command.run({ command: 'agents-info' } as never)
    expect(await label()).toBe('Hide agents')
    await ui.unmount()
  })
}

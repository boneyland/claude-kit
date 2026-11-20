import { expect, mock, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the footer offers Play radio when idle, and pressing it returns at once`, async ($, on) => {
    mock.clock(on)
    const ui = await $.ui.mount({
      plugin: 'stream-radio',
      component: 'SessionMode',
      surface,
      props: { modes: [] },
    })
    const button = await ui.find({ type: 'Button', key: 'stream-radio' })
    expect(button?.props.label).toBe('▶ Play radio')
    await ui.press({ key: 'stream-radio' })
    await ui.unmount()
  })
}

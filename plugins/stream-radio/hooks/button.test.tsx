import { expect, mock, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(
    `${surface}: pressing Play radio starts the player without /stream`,
    { options: { defaultUrl: 'https://example.com/live' } },
    async ($, on) => {
      mock.clock(on)
      const ran: string[][] = []
      on('process.run', (_$, e) => {
        ran.push([...e.argv])

        return { value: { exitCode: 0, stdout: '', stderr: '' } }
      })
      on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
      on('ui.toast', () => ({ value: undefined }) as never)

      const ui = await $.ui.mount({
        plugin: 'stream-radio',
        component: 'SessionMode',
        surface,
        props: { modes: [] },
      })
      const button = await ui.find({ type: 'Button', key: 'stream-radio' })
      expect(button?.props.label).toBe('▶ Play radio')
      await ui.press({ key: 'stream-radio' })

      // The click reached the start logic itself: it checked for the player.
      expect(ran).toContainEqual(['mpv', '--version'])
      await ui.unmount()
    },
  )
}

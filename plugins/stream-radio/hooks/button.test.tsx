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

        return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
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

const SCROLL_STEP = 300

test('a long title scrolls in a 40-column label while the time stays put', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  const title = 'A very long lofi hip hop radio title that will not fit in the footer'
  // The player prints one status line, then keeps playing.
  let release: () => void = () => undefined
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `NP\t${title}\t\t\tno\t222\t\tEND` } as never
    await new Promise<void>(resolve => (release = resolve))
    return { value: { code: 0, signal: null } } as never
  })

  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never).catch(() => undefined)
  const label = async () => {
    const ui = await $.ui.mount({ plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } })
    const text = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string
    await ui.unmount()
    return text
  }
  await clock.advance(0)
  const first = await label()
  expect(first.startsWith('3:42 A very long')).toBe(true)
  expect(first.length).toBe(40)
  await clock.advance(SCROLL_STEP * 12)
  const later = await label()
  expect(later.startsWith('3:42 ')).toBe(true)
  expect(later.length).toBe(40)
  expect(later).not.toBe(first)
  // The player exits; its loop winds down inside the test, and a later tick moves nothing.
  release()
  await $.command.run({ command: 'stream', args: 'stop' } as never).catch(() => undefined)
  await clock.advance(SCROLL_STEP * 3)
})

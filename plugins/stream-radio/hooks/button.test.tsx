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
      // The desktop app's footer is narrow: an icon alone there.
      expect(button?.props.label).toBe(surface === 'desktop' ? '▶' : '▶ Play radio')
      await ui.press({ key: 'stream-radio' })

      // The click reached the start logic itself: it checked for the player.
      expect(ran).toContainEqual(['mpv', '--version'])
      await ui.unmount()
    },
  )
}

const SCROLL_STEP = 1000

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

test('a video with chapters shows only the chapter in the footer', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'null', stderr: '' } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  let release: () => void = () => undefined
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'NP\tDebussy & Hokusai | Classical Music\t\t\tno\t76\tNocturne, L. 82\tEND' } as never
    await new Promise<void>(resolve => (release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } })
  expect((await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label).toBe('1:16 Nocturne, L. 82')
  await ui.unmount()
  release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('on the desktop app the footer is an icon that opens the panel', async ($, on) => {
  const clock = mock.clock(on)
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.panes', () => ({ value: panes }) as never)
  on('ui.open', (_$, e) => {
    panes = [{ id: e.id, title: 'Radio', isShown: true, isFocused: false, isPlaced: true }]

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => {
    panes = []

    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'null', stderr: '' } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  let release: () => void = () => undefined
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'NP\tClaude FM\t\t\tno\t\t\tEND' } as never
    await new Promise<void>(resolve => (release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  await $.command.run({ command: 'stream', args: 'https://example.com/live' } as never)
  await clock.advance(10)

  const ui = await $.ui.mount({ plugin: 'stream-radio', component: 'SessionMode', surface: 'desktop', props: { modes: [] } })
  const label = async () => (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label
  expect(await label()).toBe('♪')
  await ui.press({ key: 'stream-radio' })
  await clock.advance(10)
  expect(panes.map(p => p.id)).toHaveLength(1)
  await ui.press({ key: 'stream-radio' })
  await clock.advance(10)
  expect(panes).toEqual([])
  await $.command.run({ command: 'stream', args: 'pause' } as never)
  await clock.advance(10)
  expect(await label()).toBe('⏸')
  await ui.unmount()
  release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

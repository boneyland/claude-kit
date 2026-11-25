import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

for (const surface of ['terminal', 'desktop'] as const) {
  test(
    `${surface}: pressing Play radio starts the player without /stream`,
    { options: { defaultUrl: 'https://example.com/live' } },
    async ($, on) => {
      mock.clock(on)
      const ran: string[][] = []
      // the data folder's files, for the queue the click plays
      const files: Record<string, string> = {}
      on('process.run', (_$, e) => {
        ran.push([...e.argv])
        if (e.argv[0] === 'mv') files[e.argv[3]!] = files[e.argv[2]!]!

        return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
      })
      on('fs.write', (_$, e) => ((files[e.path] = e.text), { value: undefined }) as never)
      on('fs.read', (_$, e) => {
        if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
        return { value: files[e.path] } as never
      })
      on('fs.exists', (_$, e) => ({ value: e.path in files }) as never)
      on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'XDG_STATE_HOME' ? '/tmp/stream-radio-test' : undefined }) as never)
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
const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const

test('a long title scrolls in a 40-column label while the time stays put', async ($, on) => {
  const clock = mock.clock(on)
  const title = 'A very long lofi hip hop radio title that will not fit in the footer'
  fakeMpv(on, { title, props: { 'time-pos': 222, duration: true } })

  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never)
  const label = async () => {
    const ui = await $.ui.mount(FOOTER)
    const text = (await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label as string
    await ui.unmount()
    return text
  }
  await clock.advance(10)
  const first = await label()
  expect(first.startsWith('3:42 A very long')).toBe(true)
  expect(first.length).toBe(40)
  await clock.advance(SCROLL_STEP * 12)
  const later = await label()
  expect(later.startsWith('3:42 ')).toBe(true)
  expect(later.length).toBe(40)
  expect(later).not.toBe(first)
  // Stopped, a later tick moves nothing.
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(SCROLL_STEP * 3)
})

test('a video with chapters shows only the chapter in the footer', async ($, on) => {
  const clock = mock.clock(on)
  fakeMpv(on, {
    title: 'Debussy & Hokusai | Classical Music',
    props: { 'time-pos': 76, duration: true, 'chapter-metadata': { title: 'Nocturne, L. 82' } },
  })
  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never)
  await clock.advance(10)
  const ui = await $.ui.mount(FOOTER)
  expect((await ui.find({ type: 'Button', key: 'stream-radio' }))?.props.label).toBe('1:16 Nocturne, L. 82')
  await ui.unmount()
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
  fakeMpv(on, { title: 'Claude FM' })
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
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

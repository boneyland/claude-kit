import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const FOOTER = { plugin: 'stream-radio', component: 'SessionMode', surface: 'terminal', props: { modes: [] } } as const

const SONGS = ['Santa Claus Is Comin\' To Town', 'Santa Baby', 'Winter Wonderland']

// mpv beneath the plugin: a player printing one status line, and an IPC socket
// that answers the playlist and records every command sent to it.
function engine(on: On) {
  const world = { sent: [] as unknown[][], panes: [] as string[], release: () => undefined as void }
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'python3') return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const command = JSON.parse(argv[5]!) as unknown[]
    world.sent.push(command)
    const data =
      command[0] === 'get_property' && command[1] === 'playlist'
        ? SONGS.map((title, i) => ({ filename: `https://example.com/${i}`, title, ...(i === 0 ? { current: true } : {}) }))
        : null
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '' } } as never
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `NP\t${SONGS[0]}\t\t\tno\t42\t\tEND` } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  on('ui.panes', () => ({ value: world.panes.map(id => ({ id, title: 'Radio', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', (_$, e) => ((world.panes = [e.id]), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((world.panes = []), { value: undefined }) as never)
  return world
}

test('the footer opens the panel, which lists the playlist and picks, skips and pauses', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never).catch(() => undefined)
  await clock.advance(10)

  // The footer button opens the panel; pressed again, closes it.
  const footer = await $.ui.mount(FOOTER)
  await footer.press({ key: 'stream-radio' })
  expect(world.panes).toEqual(['stream-radio'])
  await footer.unmount()

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: SONGS[0] }))?.text).toBe(SONGS[0])
  // What plays is the last URL: no button to play it again.
  expect(await pane.find({ type: 'Button', key: 'play-last' })).toBe(undefined)
  expect((await pane.find({ type: 'Text', text: /1 of 3/ }))?.text).toMatch(/^0:42 · 1 of 3$/)
  expect((await pane.find({ type: 'Button', key: 'item-0' }))?.props.label).toBe(`▶ 1. ${SONGS[0]}`)
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe(`  3. ${SONGS[2]}`)

  await pane.press({ key: 'item-2' })
  expect(world.sent).toContainEqual(['playlist-play-index', 2])
  expect(world.sent).toContainEqual(['set_property', 'pause', false])
  await pane.press({ key: 'next' })
  expect(world.sent).toContainEqual(['playlist-next'])
  await pane.press({ key: 'prev' })
  expect(world.sent).toContainEqual(['playlist-prev'])
  await pane.press({ key: 'pause' })
  expect(world.sent).toContainEqual(['set_property', 'pause', true])
  await pane.unmount()

  const again = await $.ui.mount(FOOTER)
  await again.press({ key: 'stream-radio' })
  expect(world.panes).toEqual([])
  await again.unmount()

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never).catch(() => undefined)
  await clock.advance(1000)
})

test('/stream next, prev and panel reach the player and the panel', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/list' } as never).catch(() => undefined)
  await clock.advance(10)

  await $.command.run({ command: 'stream', args: 'next' } as never)
  expect(world.sent).toContainEqual(['playlist-next'])
  await $.command.run({ command: 'stream', args: 'prev' } as never)
  expect(world.sent).toContainEqual(['playlist-prev'])
  await $.command.run({ command: 'stream', args: 'panel' } as never)
  expect(world.panes).toEqual(['stream-radio'])

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never).catch(() => undefined)
  await clock.advance(1000)
})

test('with nothing playing the panel offers what to play', async ($, on) => {
  mock.clock(on)
  engine(on)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Nothing playing.' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'prev' })).toBe(undefined)
  expect(await pane.find({ type: 'Input', key: 'url' })).toBeTruthy()
  await pane.unmount()
})

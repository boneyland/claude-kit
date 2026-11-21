import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const PLAYLIST = [
  { filename: '/m/Album/01 Intro.flac', title: 'Intro', current: true },
  { filename: '/m/Album/Disc 2/01 Snow.flac', title: 'Snow' },
  { filename: '/m/Album/Disc 2/02 Rain.flac', title: 'Rain' },
  { filename: '/m/Album/Live/01 Snowfall.flac', title: 'Snowfall' },
]

function engine(on: On) {
  const world = { sent: [] as unknown[][], release: () => undefined as void }
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'python3') return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const command = JSON.parse(argv[5]!) as unknown[]
    world.sent.push(command)
    return { value: { exitCode: 0, stdout: JSON.stringify(command[1] === 'playlist' ? PLAYLIST : null), stderr: '' } } as never
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'NP\tIntro\t\t\tno\t3\t\tEND' } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  return world
}

test('typing in the filter narrows the list; Enter plays the first match', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)

  let pane = await $.ui.mount(PANE)
  await pane.input({ key: 'filter', text: 'snow', kind: 'change' })
  await pane.unmount()

  pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /match/ }))?.text).toBe('2 of 4 songs match')
  expect((await pane.find({ type: 'Button', key: 'item-1' }))?.props.label).toBe('  2. Snow · Disc 2')
  expect((await pane.find({ type: 'Button', key: 'item-3' }))?.props.label).toBe('  4. Snowfall · Live')
  expect(await pane.find({ type: 'Button', key: 'item-2' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'folder-/m/Album/Disc 2' })).toBe(undefined)
  await pane.input({ key: 'filter', text: 'snow' })
  await pane.unmount()
  expect(world.sent).toContainEqual(['playlist-play-index', 1])

  // Cleared, the tree is back.
  pane = await $.ui.mount(PANE)
  await pane.input({ key: 'filter', text: '', kind: 'change' })
  await pane.unmount()
  pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Button', key: 'folder-/m/Album/Disc 2' })).toBeTruthy()
  await pane.unmount()

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

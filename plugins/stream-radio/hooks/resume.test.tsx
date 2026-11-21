import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SONGS = ['Santa Claus Is Comin\' To Town', 'Santa Baby', 'Winter Wonderland']
const URL = 'https://example.com/list'

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// An mpv that plays a three-song playlist: each player prints the status of the
// song it is on, and a jump or seek through the socket prints the new status.
function engine(on: On) {
  const world = {
    sent: [] as unknown[][],
    current: 0,
    seconds: 0,
    say: (_line: string) => undefined as void,
    end: () => undefined as void,
  }
  const status = () => `NP\t${SONGS[world.current]}\t\t\tno\t${world.seconds}\t\tEND`
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] !== 'python3') return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    const command = JSON.parse(argv[5]!) as unknown[]
    world.sent.push(command)
    let data: unknown = null
    if (command[0] === 'get_property' && command[1] === 'playlist') {
      data = SONGS.map((title, i) => ({ filename: `https://example.com/${i}`, title, ...(i === world.current ? { current: true } : {}) }))
    } else if (command[0] === 'playlist-play-index') {
      world.current = command[1] as number
      world.seconds = 0
      world.say(status())
    } else if (command[0] === 'seek') {
      world.seconds = command[1] as number
      world.say(status())
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '' } } as never
  })
  on('process.spawn', async function* () {
    world.current = 0
    world.seconds = 0
    const lines: string[] = [status()]
    let wake: () => void = () => undefined
    let isOver = false
    world.say = line => (lines.push(line), wake())
    world.end = () => ((isOver = true), wake())
    while (!isOver) {
      while (lines.length > 0) yield { stream: 'stdout', text: lines.shift()! } as never
      if (!isOver) await new Promise<void>(resolve => (wake = resolve))
    }
    return { value: { code: 0, signal: null } } as never
  })
  return world
}

test('playing the last URL again resumes at its song and time', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)

  // The person moves to the third song and listens to 1:20 of it.
  world.current = 2
  world.seconds = 80
  world.say(`NP\t${SONGS[2]}\t\t\tno\t80\t\tEND`)
  await clock.advance(10)

  // The panel offers to resume there.
  world.end()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'play-last' }))?.props.label).toBe(`▶ Resume ${SONGS[2]} at 1:20`)
  await pane.unmount()

  world.sent = []
  const reply = await $.command.run({ command: 'stream', args: 'last' } as never)
  expect(JSON.stringify(reply)).toContain(`Resuming ${SONGS[2]} at 1:20`)
  await clock.advance(10)
  await clock.advance(10)
  expect(world.sent).toContainEqual(['playlist-play-index', 2])
  expect(world.sent).toContainEqual(['seek', 80, 'absolute'])
  // Jumped first, then sought.
  const jump = world.sent.findIndex(c => c[0] === 'playlist-play-index')
  const seek = world.sent.findIndex(c => c[0] === 'seek')
  expect(jump < seek).toBe(true)

  world.end()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a URL typed again starts at the beginning', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  world.current = 2
  world.say(`NP\t${SONGS[2]}\t\t\tno\t80\t\tEND`)
  await clock.advance(10)
  world.end()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)

  world.sent = []
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10)
  expect(world.sent.some(c => c[0] === 'playlist-play-index' || c[0] === 'seek')).toBe(false)

  world.end()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

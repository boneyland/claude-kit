import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FILES = ['/home/me/Music/Album', '/home/me/Music/one.flac']

function engine(on: On) {
  const world = { spawned: [] as string[][], release: () => undefined as void }
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: '/home/me' }) as never)
  on('session.cwd', () => ({ value: '/home/me/Music' }) as never)
  on('fs.exists', (_$, e) => ({ value: FILES.includes(e.path) }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'null', stderr: '' } }) as never)
  on('process.spawn', async function* (_$, e) {
    world.spawned.push([...e.argv])
    yield { stream: 'stdout', text: 'NP\tone.flac\t\t\tno\t3\t\tEND' } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })
  return world
}

test('/stream plays a local folder, skipping its pictures', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  const reply = await $.command.run({ command: 'stream', args: '~/Music/Album' } as never)
  expect(JSON.stringify(reply)).toContain('Starting /home/me/Music/Album')
  await clock.advance(10)
  const argv = world.spawned[0]!
  expect(argv.at(-1)).toBe('/home/me/Music/Album')
  expect(argv.at(-2)).toBe('--')
  expect(argv).toContain('--directory-filter-types=audio,video,playlist')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a relative path reads from the session folder; a missing one says so', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  const missing = await $.command.run({ command: 'stream', args: 'nope.mp3' } as never)
  expect(JSON.stringify(missing)).toContain('No such file or folder: /home/me/Music/nope.mp3')
  expect(world.spawned).toEqual([])

  await $.command.run({ command: 'stream', args: 'one.flac' } as never)
  await clock.advance(10)
  expect(world.spawned[0]!.at(-1)).toBe('/home/me/Music/one.flac')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a YouTube URL does not get the folder filter', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: 'https://example.com/v' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).not.toContain('--directory-filter-types=audio,video,playlist')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('the panel marks a subfolder in a local playlist', async ($, on) => {
  const clock = mock.clock(on)
  const world = { release: () => undefined as void }
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.stat', (_$, e) => ({ value: { kind: e.path.endsWith('Live') ? 'dir' : 'file', size: 0, mtimeMs: 0 } }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const command = argv[0] === 'python3' ? (JSON.parse(argv[5]!) as unknown[]) : []
    const data =
      command[1] === 'playlist'
        ? [
            { filename: '/m/Album/01 Intro.flac', title: 'Intro', current: true },
            { filename: '/m/Album/02 Song.flac' },
            { filename: '/m/Album/Live' },
          ]
        : null
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '' } } as never
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: 'NP\tIntro\t\t\tno\t3\t\tEND' } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })

  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)
  const pane = await $.ui.mount({
    plugin: 'stream-radio',
    component: 'Pane',
    requestId: 'stream-radio',
    surface: 'terminal',
    props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const)
  expect((await pane.find({ type: 'Button', key: 'item-0' }))?.props.label).toBe('▶ 1. Intro')
  expect((await pane.find({ type: 'Button', key: 'item-1' }))?.props.label).toBe('  2. 02 Song.flac')
  expect((await pane.find({ type: 'Button', key: 'item-2' }))?.props.label).toBe('  3. 📁 Live/')
  expect((await pane.find({ type: 'Input', key: 'url' }))?.props.submitLabel).toBe('Enter to play')
  await pane.unmount()

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('subfolders fold: the current song\'s opens by itself, a click shuts and opens one', async ($, on) => {
  const clock = mock.clock(on)
  const world = { release: () => undefined as void, spawned: [] as string[][] }
  const playlist = [
    { filename: '/m/Album/01 Intro.flac', title: 'Intro' },
    { filename: '/m/Album/Disc 2/01 A.flac', title: 'A', current: true },
    { filename: '/m/Album/Disc 2/02 B.flac', title: 'B' },
    { filename: '/m/Album/Live/01 C.flac', title: 'C' },
  ]
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/tmp/stream-radio-test' } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const command = argv[0] === 'python3' ? (JSON.parse(argv[5]!) as unknown[]) : []
    const data = command[1] === 'playlist' ? playlist : null
    return { value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '' } } as never
  })
  on('process.spawn', async function* (_$, e) {
    world.spawned.push([...e.argv])
    yield { stream: 'stdout', text: 'NP\tA\t\t\tno\t3\t\tEND' } as never
    await new Promise<void>(resolve => (world.release = resolve))
    return { value: { code: 0, signal: null } } as never
  })

  await $.command.run({ command: 'stream', args: '/m/Album' } as never)
  await clock.advance(10)
  expect(world.spawned[0]).toContain('--directory-mode=recursive')
  const PANE = {
    plugin: 'stream-radio',
    component: 'Pane',
    requestId: 'stream-radio',
    surface: 'terminal',
    props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const label = async (key: string) => {
    const pane = await $.ui.mount(PANE)
    const text = (await pane.find({ type: 'Button', key }))?.props.label as string | undefined
    await pane.unmount()
    return text
  }

  // The current song's folder is open; the other is shut.
  expect(await label('folder-/m/Album/Disc 2')).toBe('  ▾ 📁 Disc 2/ · 2')
  expect(await label('item-1')).toBe('▶   1. A')
  expect(await label('item-2')).toBe('    2. B')
  expect(await label('folder-/m/Album/Live')).toBe('  ▸ 📁 Live/ · 1')
  expect(await label('item-3')).toBe(undefined)

  // Shut by hand, the playing folder carries the mark.
  let pane = await $.ui.mount(PANE)
  await pane.press({ key: 'folder-/m/Album/Disc 2' })
  await pane.unmount()
  expect(await label('folder-/m/Album/Disc 2')).toBe('▶ ▸ 📁 Disc 2/ · 2')
  expect(await label('item-1')).toBe(undefined)

  pane = await $.ui.mount(PANE)
  await pane.press({ key: 'folder-/m/Album/Live' })
  await pane.unmount()
  expect(await label('item-3')).toBe('    1. C')

  world.release()
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv } from './fake-mpv'

const SONGS = ['Santa Claus Is Comin\' To Town', 'Santa Baby', 'Winter Wonderland']
// A playlist file of the three songs: the app expands it into the queue.
const LIST = '/m/list.m3u'
const M3U = `#EXTM3U\n${SONGS.map((title, i) => `#EXTINF:-1,${title}\nhttps://example.com/${i}\n`).join('')}`

const PANE = {
  plugin: 'stream-radio',
  component: 'Pane',
  requestId: 'stream-radio',
  surface: 'terminal',
  props: { title: 'Radio', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The shared player on the queue it is handed: a jump through the socket
// changes the song and its title, and loads it.
function engine(on: On) {
  const world = fakeMpv(on, {
    title: SONGS[0],
    props: { 'time-pos': 0, duration: true },
    onCommand: command => {
      if (command[0] !== 'playlist-play-index') return undefined
      const i = command[1] as number
      world.set('playlist-pos', i)
      world.set('media-title', SONGS[i])
      world.set('time-pos', 0)
      world.load()
      return { data: null }
    },
  })
  world.files[LIST] = M3U
  // The person moves to song `i` and listens to `seconds` of it.
  const listen = (i: number, seconds: number) => {
    world.set('playlist-pos', i)
    world.set('media-title', SONGS[i])
    world.load()
    world.set('time-pos', seconds)
  }
  return Object.assign(world, { listen })
}

test('playing the queue again resumes at its song and time', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: LIST } as never)
  await clock.advance(10)

  // The person moves to the third song and listens to 1:20 of it.
  world.listen(2, 80)
  await clock.advance(10)

  // The panel offers to resume there.
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Button', key: 'play-last' }))?.props.label).toBe(`▶ Resume ${SONGS[2]} at 1:20 (l)`)
  await pane.unmount()

  world.sent = []
  const reply = await $.command.run({ command: 'stream', args: 'last' } as never)
  expect(JSON.stringify(reply)).toContain(`Resuming ${SONGS[2]} at 1:20`)
  await clock.advance(10)
  await clock.advance(10)
  // mpv starts at the song itself, and seeks once it has loaded it
  expect(world.launches[1]).toContain('--playlist-start=2')
  expect(world.sent).toContainEqual(['seek', 80, 'absolute'])
  expect(world.sent.some(c => c[0] === 'playlist-play-index')).toBe(false)

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('a playlist typed again starts at the beginning', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  await $.command.run({ command: 'stream', args: LIST } as never)
  await clock.advance(10)
  world.listen(2, 80)
  await clock.advance(10)
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)

  world.sent = []
  await $.command.run({ command: 'stream', args: LIST } as never)
  await clock.advance(10)
  expect(world.launches[1]).toContain('--playlist-start=0')
  expect(world.sent.some(c => c[0] === 'playlist-play-index' || c[0] === 'seek')).toBe(false)

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('the resume seek happens for a file that loaded before the watcher began', async ($, on) => {
  const clock = mock.clock(on)
  const world = fakeMpv(on, {
    title: SONGS[0],
    loadsBeforeWatch: true,
    exists: () => true,
    // an earlier version's last URL, the folder /m: it becomes the queue
    stat: path => ({ kind: path === '/m' ? 'dir' : 'file' }),
    list: () => SONGS.map((_, i) => ({ name: `${i}.flac`, kind: 'file' as const })),
    playlist: SONGS.map((title, i) => ({ filename: `/m/${i}.flac`, title })),
    saved: { last: { url: '/m', resumeAt: { url: '/m', index: 2, seconds: 80, title: SONGS[2] } }, knownDefault: { mod: '' } },
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'stream', args: 'last' } as never)
  await clock.advance(10)
  await clock.advance(10)
  expect(world.launches[0]).toContain('--playlist-start=2')
  expect(world.sent).toContainEqual(['seek', 80, 'absolute'])

  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { DATA, fakeMpv, PLACE, QUEUE_JSON } from './fake-mpv'

const LIB = '/home/me/.local/share/stream-radio/playlists'
const FAV = `${LIB}/★ Favourites.m3u`
const HISTORY = `${DATA}/history.jsonl`

function engine(on: On) {
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  return fakeMpv(on, {
    title: 'Song',
    props: { 'time-pos': 3, duration: true },
    list: path => (path === LIB ? [{ name: 'Road trip.m3u', kind: 'file' }, { name: 'Empty.m3u', kind: 'file' }] : undefined) as never,
  })
}

const queue = (...paths: string[]) =>
  JSON.stringify({ version: 1, rev: 1, entries: paths.map((path, i) => ({ id: `1.${i}`, path })), arrangement: { kind: 'none' }, root: '', source: '' })

const text = (reply: unknown) => JSON.stringify(reply)

test('/stream fav toggles the playing song in Favourites', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  expect(text(await $.command.run({ command: 'stream', args: 'fav' } as never))).toContain('Nothing playing.')
  world.files[QUEUE_JSON] = queue('/home/me/Music/a.mp3', '/home/me/Music/b.mp3')
  world.files[PLACE] = JSON.stringify({ rev: 1, current: '1.1', seconds: 3 })
  expect(text(await $.command.run({ command: 'stream', args: 'fav' } as never))).toContain('Added to ★ Favourites.')
  expect(world.files[FAV]).toBe('#EXTM3U\n/home/me/Music/b.mp3\n')
  expect(text(await $.command.run({ command: 'stream', args: 'fav' } as never))).toContain('Removed from ★ Favourites.')
  expect(world.files[FAV]).not.toContain('b.mp3')
  await clock.advance(10)
})

test('/stream add and remove, and an unknown playlist', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[QUEUE_JSON] = queue('/home/me/Music/a.mp3')
  world.files[`${LIB}/Road trip.m3u`] = '#EXTM3U\n'
  expect(text(await $.command.run({ command: 'stream', args: 'add road trip' } as never))).toContain('Added to Road trip.')
  expect(world.files[`${LIB}/Road trip.m3u`]).toContain('/home/me/Music/a.mp3')
  expect(text(await $.command.run({ command: 'stream', args: 'remove Road trip' } as never))).toContain('Removed from Road trip.')
  expect(text(await $.command.run({ command: 'stream', args: 'add Nope' } as never))).toContain('No playlist called Nope.')
  await clock.advance(10)
})

test('/stream history prints the plays, newest first', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  expect(text(await $.command.run({ command: 'stream', args: 'history' } as never))).toContain('Nothing played yet.')
  const at = Math.floor(Date.now() / 1000)
  world.files[HISTORY] = [{ at: at - 7200, path: '/m/old.mp3', title: 'Old' }, { at: at - 5, path: '/m/new.mp3', title: 'New' }].map(p => JSON.stringify(p)).join('\n') + '\n'
  const reply = text(await $.command.run({ command: 'stream', args: 'history' } as never))
  expect(reply.indexOf('New')).toBeGreaterThan(-1)
  expect(reply.indexOf('New')).toBeLessThan(reply.indexOf('Old'))
  await clock.advance(10)
})

test('/stream play <list> plays a saved list; history plays newest first', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[`${LIB}/Road trip.m3u`] = '#EXTM3U\n/home/me/Music/a.mp3\n/home/me/Music/b.mp3\n'
  const nope = text(await $.command.run({ command: 'stream', args: 'play nope' } as never))
  expect(nope).toContain('No playlist called nope.')
  expect(nope).not.toContain('Playing')
  world.files[`${LIB}/Empty.m3u`] = '#EXTM3U\n'
  expect(text(await $.command.run({ command: 'stream', args: 'play empty' } as never))).toContain('Empty is empty.')
  expect(text(await $.command.run({ command: 'stream', args: 'play road trip' } as never))).toContain('Playing Road trip.')
  await clock.advance(10)
  let q = JSON.parse(world.files[QUEUE_JSON]!) as { entries: { path: string }[]; source: string }
  expect(q.entries.map(e => e.path)).toEqual(['/home/me/Music/a.mp3', '/home/me/Music/b.mp3'])
  expect(q.source).toBe(`${LIB}/Road trip.m3u`)

  world.files[HISTORY] = [{ at: 1, path: '/m/old.mp3', title: 'Old' }, { at: 2, path: '/m/new.mp3', title: 'New' }].map(p => JSON.stringify(p)).join('\n') + '\n'
  await $.command.run({ command: 'stream', args: 'play history' } as never)
  await clock.advance(10)
  q = JSON.parse(world.files[QUEUE_JSON]!) as typeof q
  expect(q.entries.map(e => e.path)).toEqual(['/m/new.mp3', '/m/old.mp3'])
  expect(q.source).toBe('')
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('/stream play fav goes through the alias', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on)
  world.files[FAV] = '#EXTM3U\n/home/me/Music/a.mp3\n'
  await $.command.run({ command: 'stream', args: 'play fav' } as never)
  await clock.advance(10)
  expect((JSON.parse(world.files[QUEUE_JSON]!) as { entries: { path: string }[] }).entries.map(e => e.path)).toEqual(['/home/me/Music/a.mp3'])
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

test('/stream play <file> and a folder named history play from the session folder', async ($, on) => {
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  const world = engine(on)
  world.files['/repo/song.mp3'] = 'x'
  expect(text(await $.command.run({ command: 'stream', args: 'play song.mp3' } as never))).not.toContain('No playlist')
  await clock.advance(10)
  expect(world.urls[0]).toBe('/repo/song.mp3')
  expect(text(await $.command.run({ command: 'stream', args: 'play gone.mp3' } as never))).toContain('No such file or folder: /repo/gone.mp3')
  world.files['/repo/history'] = 'x'
  expect(text(await $.command.run({ command: 'stream', args: 'history' } as never))).not.toContain('Nothing played yet.')
  await clock.advance(10)
  expect(world.urls.at(-1)).toBe('/repo/history')
  // a folder named play, with nothing after the word
  world.files['/repo/play'] = 'x'
  expect(text(await $.command.run({ command: 'stream', args: 'play' } as never))).not.toContain('Usage')
  await clock.advance(10)
  expect(world.urls.at(-1)).toBe('/repo/play')
  delete world.files['/repo/play']
  expect(text(await $.command.run({ command: 'stream', args: 'add' } as never))).toContain('Usage: /stream add <playlist>')
  await $.command.run({ command: 'stream', args: 'stop' } as never)
  await clock.advance(10)
})

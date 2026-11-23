import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fakeMpv, LOG } from './fake-mpv'
import type { FakeOptions } from './fake-mpv'

const URL = 'https://www.youtube.com/watch?v=abc'
const ANDROID = '--ytdl-raw-options-append=extractor-args=youtube:player_client=android'
// What mpv prints when yt-dlp finds nothing to play.
const REFUSED = [
  '[ytdl_hook] ERROR: [youtube] abc: No video formats found!; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template.',
  '[ytdl_hook] youtube-dl failed: unexpected error occurred',
  'Failed to recognize file format.',
  '',
].join('\n')

function engine(on: On, options: FakeOptions) {
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'stream' } }) as never)
  return fakeMpv(on, { title: 'Song', ...options })
}

const start = { cwd: '/repo', surface: 'terminal', isInteractive: true } as never
const usesAndroid = (argv: string[]) => argv.includes(ANDROID)

test('with the android client always on, a refused start retries with the default client', { options: { androidClient: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { refuses: argv => (usesAndroid(argv) ? REFUSED : undefined) })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10_000)
  expect(world.launches.map(usesAndroid)).toEqual([true, false])
  expect(world.isRunning).toBe(true)
  expect(world.logs).toContain(`stream-radio: ${URL} would not play; retrying with the default client`)
  expect(world.toasts.filter(t => t.startsWith('stream failed'))).toEqual([])
})

test('the default client refused, the android one is tried once, then it says what yt-dlp said', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { refuses: () => REFUSED })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(20_000)
  expect(world.launches.map(usesAndroid)).toEqual([false, true])
  expect(world.logs).toContain(
    `stream-radio: could not play ${URL}: [youtube] abc: No video formats found!`,
  )
  expect(world.toasts).toContain('stream failed: [youtube] abc: No video formats found!')
  expect(world.files[LOG]).toBe(REFUSED)
})

test('without a yt-dlp error, the last line mpv printed is the reason', async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { refuses: () => 'Failed to open https://example.com/x.\n' })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: 'https://example.com/x' } as never)
  await clock.advance(20_000)
  expect(world.launches.length).toBe(2)
  expect(world.logs).toContain('stream-radio: could not play https://example.com/x: Failed to open https://example.com/x.')
})

test('a reconnect keeps the client that played', { options: { androidClient: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = engine(on, { refuses: argv => (usesAndroid(argv) ? REFUSED : undefined) })
  await $.session.start(start)
  await $.command.run({ command: 'stream', args: URL } as never)
  await clock.advance(10_000)
  world.end()
  await clock.advance(2100)
  expect(world.launches.map(usesAndroid)).toEqual([true, false, false])
  expect(world.isRunning).toBe(true)
})

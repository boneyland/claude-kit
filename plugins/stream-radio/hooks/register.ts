import type { Register } from 'claude-code'

import { parseArgs, parseNowPlaying, STATUS_FORMAT } from './nowplaying'

type Options = { defaultUrl?: string; volume?: number; player?: string }

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv' } = options as Options
  // The running player's stream: ending its loop kills the child.
  let current: { return: () => Promise<unknown> } | undefined
  let run = 0

  // Ends the running player (if any); the caller clears the status line.
  async function stop() {
    run += 1
    const old = current
    current = undefined
    await old?.return()
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stream',
      description: 'Play a YouTube stream\'s audio; shows what is playing',
      argumentHint: '[url | stop]',
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop()
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    const parsed = parseArgs(e.args, defaultUrl)
    if (parsed.kind === 'error') return { text: parsed.text }
    if (parsed.kind === 'stop') {
      await stop()
      $.ui.status(undefined)

      return { text: 'Stopped.' }
    }

    await stop()
    const mine = run
    const argv = [
      player,
      '--no-video',
      '--no-input-terminal',
      '--ytdl-format=bestaudio/best',
      `--volume=${Math.round(volume)}`,
      '--msg-level=all=error,statusline=status',
      `--term-status-msg=${STATUS_FORMAT}`,
      '--',
      parsed.url,
    ]

    try {
      await $.process.run([player, '--version'], { timeoutMs: 5000 })
    } catch {
      return { text: `Can't start "${player}". Install mpv (and yt-dlp for YouTube).` }
    }

    $.ui.status('♪ connecting…')
    const stream = $.process.spawn({ argv })
    current = stream
    void (async () => {
      let lastError = ''
      let lastTitle = ''
      try {
        for await (const { stream: pipe, text } of stream) {
          if (mine !== run) return
          if (pipe === 'stderr') {
            lastError = text.trim().split('\n').pop() ?? lastError
            continue
          }
          const track = parseNowPlaying(text)
          if (track && track.title !== lastTitle) {
            lastTitle = track.title
            $.ui.status(`♪ ${track.title}`)
          }
        }
      } catch {
        // a child that cannot start or was killed ends the loop; reported below
      }
      if (mine !== run) return
      current = undefined
      $.ui.status(undefined)
      if (!lastTitle && lastError) {
        $.ui.toast(`stream failed: ${lastError.slice(0, 200)}`)
      }
    })()

    return { text: `Streaming ${parsed.url}. /stream stop to end it.` }
  })
}

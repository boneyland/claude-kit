import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { parseArgs, parseNowPlaying, STATUS_FORMAT } from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')

type Options = { defaultUrl?: string; volume?: number; player?: string }

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv' } = options as Options
  // The running player's stream: ending its loop kills the child.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: { return: (value: any) => Promise<unknown> } | undefined
  let run = 0

  // Ends the running player (if any); the caller clears the status line.
  async function stop() {
    run += 1
    const old = current
    current = undefined
    await old?.return(undefined)
  }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    await $.command.register({
      name: 'stream',
      description: 'Play a YouTube stream\'s audio; shows what is playing',
      argumentHint: '[url | stop]',
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop()
    await update($, playing, () => '')

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    const parsed = parseArgs(e.args, defaultUrl)
    if (parsed.kind === 'error') return { text: parsed.text }
    if (parsed.kind === 'stop') {
      await stop()
      await update($, playing, () => '')

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

    await update($, playing, () => 'connecting…')
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
            await update($, playing, () => track.title)
          }
        }
      } catch {
        // a child that cannot start or was killed ends the loop; reported below
      }
      if (mine !== run) return
      current = undefined
      await update($, playing, () => '')
      if (!lastTitle && lastError) {
        $.ui.toast(`stream failed: ${lastError.slice(0, 200)}`)
      }
    })()

    return { text: `Streaming ${parsed.url}. /stream stop to end it.` }
  })

  // The track, dim, at the right of the prompt footer after the engine's own labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const title = await read($, playing)
    if (!title) return next(e)
    const shown = title.length > 60 ? `${title.slice(0, 59)}…` : title

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Text dimColor>♪ {shown}</Text>
      </Box>
    )
  })
}

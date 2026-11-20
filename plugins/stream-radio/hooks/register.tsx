import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { parseArgs, parseNowPlaying, STATUS_FORMAT } from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)

const SEND =
  'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1]); s.sendall((sys.argv[2]+"\\n").encode())'
const TOGGLE_PAUSE = '{"command":["cycle","pause"]}'

type Options = { defaultUrl?: string; volume?: number; player?: string }

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv' } = options as Options
  // The running player's stream: ending its loop kills the child.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: { return: (value: any) => Promise<unknown> } | undefined
  // The socket path mpv listens on; undefined when nothing plays.
  let control: string | undefined
  let run = 0

  // Ends the running player (if any); the caller clears the footer.
  async function stop() {
    run += 1
    const old = current
    current = undefined
    control = undefined
    await old?.return(undefined)
  }

  // The command that sends one JSON command to mpv's IPC socket.
  function send(json: string): string[] {
    return ['python3', '-I', '-c', SEND, control ?? '', json]
  }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | pause | stop]',
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
    if (parsed.kind === 'toggle') {
      if (!control) return { text: 'Nothing is playing.' }
      await $.process.run(send(TOGGLE_PAUSE), { timeoutMs: 3000 }).catch(() => undefined)
      await update($, isPaused, paused => !paused)

      return { text: 'Toggled pause.' }
    }

    await stop()
    const mine = run

    try {
      await $.process.run([player, '--version'], { timeoutMs: 5000 })
    } catch {
      return { text: `Can't start "${player}". Install mpv (and yt-dlp for YouTube).` }
    }

    // mpv's IPC socket, in the plugin's data folder; pause and resume go through it.
    const dir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
    const pipe = `${dir}/mpv-${mine}.sock`
    await $.process.run(['rm', '-f', pipe])
    control = pipe

    const argv = [
      player,
      '--no-video',
      '--no-input-terminal',
      `--input-ipc-server=${pipe}`,
      '--ytdl-format=bestaudio/best',
      `--volume=${Math.round(volume)}`,
      '--msg-level=all=error,statusline=status',
      `--term-status-msg=${STATUS_FORMAT}`,
      '--',
      parsed.url,
    ]

    await update($, isPaused, () => false)
    await update($, playing, () => 'connecting…')
    const stream = $.process.spawn({ argv })
    current = stream
    void (async () => {
      let lastError = ''
      let lastTitle = ''
      let lastPaused = false
      try {
        for await (const { stream: from, text } of stream) {
          if (mine !== run) return
          if (from === 'stderr') {
            lastError = text.trim().split('\n').pop() ?? lastError
            continue
          }
          const track = parseNowPlaying(text)
          if (track && track.title !== lastTitle) {
            lastTitle = track.title
            await update($, playing, () => track.title)
          }
          if (track && track.isPaused !== lastPaused) {
            lastPaused = track.isPaused
            await update($, isPaused, () => track.isPaused)
          }
        }
      } catch {
        // a child that cannot start or was killed ends the loop; reported below
      } finally {
        await $.process.run(['rm', '-f', pipe]).catch(() => undefined)
      }
      if (mine !== run) return
      current = undefined
      control = undefined
      await update($, playing, () => '')
      if (!lastTitle && lastError) {
        $.ui.toast(`stream failed: ${lastError.slice(0, 200)}`)
      }
    })()

    return { text: `Streaming ${parsed.url}. Click the footer title or /stream pause to pause, /stream stop to end it.` }
  })

  // The track at the right of the prompt footer after the engine's own labels;
  // pressing it pauses and resumes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const title = await read($, playing)
    if (!title) return next(e)
    const paused = await read($, isPaused)
    const shown = title.length > 60 ? `${title.slice(0, 59)}…` : title

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button
          key="stream-radio"
          label={`${paused ? '⏸' : '♪'} ${shown}`}
          onPress={async () => {
            if (!control) return
            await $.process.run(send(TOGGLE_PAUSE), { timeoutMs: 3000 }).catch(() => undefined)
            await update($, isPaused, was => !was)
          }}
        />
      </Box>
    )
  })
}

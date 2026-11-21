import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { completeLines, parseArgs, parseNowPlaying, STATUS_FORMAT } from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)
const percent = atom({ plugin: 'stream-radio', key: 'percent' } as const, -1)

const SEND =
  'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1]); s.sendall((sys.argv[2]+"\\n").encode())'
const TOGGLE_PAUSE = '{"command":["cycle","pause"]}'

type Options = { defaultUrl?: string; volume?: number; player?: string }
type Config = { volume: number; player: string }

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

// Starts playing `url`. Returns at once: the first start after a reload is slow,
// and a hook that takes too long is reported as unanswered, so the startup runs
// in the background.
function start($: EngineInterface, config: Config, url: string) {
  const { player, volume } = config
  const old = current
  current = undefined
  control = undefined
  run += 1
  const mine = run
  void (async () => {
    let lastError = ''
    let lastTitle = ''
    let lastPaused = false
    let lastPercent = -1
    let unread = ''
    let pipe = ''
    try {
      await old?.return(undefined)
      await update($, isPaused, () => false)
      await update($, percent, () => -1)
      await update($, playing, () => 'connecting…')

      try {
        await $.process.run([player, '--version'], { timeoutMs: 5000 })
      } catch {
        await update($, playing, () => '')
        $.ui.toast(`Can't start "${player}". Install mpv (and yt-dlp for YouTube).`)
        return
      }

      // mpv's IPC socket, in the plugin's data folder; pause and resume go through it.
      const dir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
      pipe = `${dir}/mpv-${mine}.sock`
      await $.process.run(['rm', '-f', pipe])
      if (mine !== run) return
      control = pipe

      const argv = [
        player,
        '--no-video',
        '--no-input-terminal',
        // Your mpv.conf may loop one file or pause at its end; a stream plays on.
        '--loop-file=no',
        '--loop-playlist=inf',
        '--keep-open=no',
        `--input-ipc-server=${pipe}`,
        '--ytdl-format=bestaudio/best',
        `--volume=${Math.round(volume)}`,
        '--msg-level=all=error,statusline=status',
        `--term-status-msg=${STATUS_FORMAT}`,
        '--',
        url,
      ]
      const stream = $.process.spawn({ argv })
      current = stream
      for await (const { stream: from, text } of stream) {
        if (mine !== run) return
        if (from === 'stderr') {
          lastError = text.trim().split('\n').pop() ?? lastError
          continue
        }
        // Output comes in pieces: read complete lines only, or a half-printed
        // line can claim the stream is not paused.
        const { complete, rest } = completeLines(unread + text)
        unread = rest
        const track = parseNowPlaying(complete)
        if (track && track.title !== lastTitle) {
          lastTitle = track.title
          await update($, playing, () => track.title)
        }
        const pos = track?.percent ?? -1
        if (track && pos !== lastPercent) {
          lastPercent = pos
          await update($, percent, () => pos)
        }
        if (track && track.isPaused !== null && track.isPaused !== lastPaused) {
          lastPaused = track.isPaused
          await update($, isPaused, () => track.isPaused)
        }
      }
    } catch (error) {
      // a child that cannot start or was killed ends the loop; reported below
      lastError ||= error instanceof Error ? error.message : String(error)
    } finally {
      if (pipe) await $.process.run(['rm', '-f', pipe]).catch(() => undefined)
    }
    if (mine !== run) return
    current = undefined
    control = undefined
    await update($, playing, () => '')
    if (!lastTitle && lastError) {
      $.ui.toast(`stream failed: ${lastError.slice(0, 200)}`)
    }
  })()
}

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv' } = options as Options
  const config: Config = { volume, player }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    // State outlives a reload but the player does not: start from idle.
    await update($, playing, () => '')
    await update($, isPaused, () => false)
    await update($, percent, () => -1)
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
    // A throwing hook is skipped and /stream then says nothing useful: say why.
    try {
      const parsed = parseArgs(e.args, defaultUrl)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'stop') {
        await stop()
        await update($, playing, () => '')

        return { text: 'Stopped.' }
      }
      if (parsed.kind === 'toggle') {
        if (!control) return { text: 'Nothing is playing.' }
        const sent = await $.process
          .run(send(TOGGLE_PAUSE), { timeoutMs: 3000 })
          .catch(() => undefined)
        if (sent?.exitCode !== 0) return { text: 'The player is not ready yet.' }
        await update($, isPaused, paused => !paused)

        return { text: 'Toggled pause.' }
      }

      start($, config, parsed.url)

      return {
        text: `Starting ${parsed.url}. Click the footer title or /stream pause to pause, /stream stop to end it.`,
      }
    } catch (error) {
      return { text: `stream-radio failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // The track at the right of the prompt footer after the engine's own labels;
  // pressing it pauses and resumes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const title = await read($, playing)
    if (!title) {
      // Idle: a button that starts the default stream, like a bare /stream. It
      // starts it directly: a plugin's own $.command.run never reaches its own
      // command.run hook.
      if (!defaultUrl) return next(e)

      return (
        <Box flexDirection="row" gap={1}>
          {await next(e)}
          <Button
            key="stream-radio"
            label="▶ Play radio"
            onPress={() => start($, config, defaultUrl)}
          />
        </Box>
      )
    }
    const paused = await read($, isPaused)
    const done = await read($, percent)
    // A file in a playlist shows how far along it is; a live stream has no end.
    const progress = done >= 0 ? `${done}%` : ''
    const icon = paused ? `⏸ ${progress}`.trim() : progress || '♪'
    const shown = title.length > 60 ? `${title.slice(0, 59)}…` : title

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button
          key="stream-radio"
          label={`${icon} ${shown}`}
          onPress={async () => {
            if (!control) return
            const sent = await $.process
              .run(send(TOGGLE_PAUSE), { timeoutMs: 3000 })
              .catch(() => undefined)
            // Not listening yet (still connecting): leave the state alone.
            if (sent?.exitCode === 0) await update($, isPaused, was => !was)
          }}
        />
      </Box>
    )
  })
}

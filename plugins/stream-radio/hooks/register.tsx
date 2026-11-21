import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { completeLines, parseArgs, parseNowPlaying, STATUS_FORMAT } from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)
const percent = atom({ plugin: 'stream-radio', key: 'percent' } as const, -1)
// The last URL that actually played: what the idle button plays again.
const lastUrl = atom({ plugin: 'stream-radio', key: 'lastUrl' } as const, '')
// The default stream the last load saw: when it changes, the new default wins
// over the remembered URL.
const knownDefault = atom({ plugin: 'stream-radio', key: 'knownDefault' } as const, '')

const SEND =
  'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1]); s.sendall((sys.argv[2]+"\\n").encode())'
const TOGGLE_PAUSE = '{"command":["cycle","pause"]}'

type Options = { defaultUrl?: string; volume?: number; player?: string; androidClient?: boolean }
type Config = { volume: number; player: string; androidClient: boolean }

// URLs that only played with the android client; they start with it directly.
const needsAndroid = new Set<string>()

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
function start($: EngineInterface, config: Config, url: string, retryClient?: string) {
  const { player, volume, androidClient } = config
  // YouTube refuses the default client's stream URLs for some content (403);
  // the android client gets through, with muxed AAC and no audio-only Opus.
  const client = retryClient ?? (androidClient || needsAndroid.has(url) ? 'android' : undefined)
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
        ...(client
          ? [`--ytdl-raw-options-append=extractor-args=youtube:player_client=${client}`]
          : []),
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
          // The first title means it really plays: remember it for the button.
          if (!lastTitle) {
            await update($, lastUrl, () => url)
            if (client) needsAndroid.add(url)
          }
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
    if (!lastTitle && !client) {
      // Nothing played with the default client: try once with android.
      $.ui.log(`stream-radio: ${url} would not play; retrying with the android client`)
      start($, config, url, 'android')

      return
    }
    if (!lastTitle) {
      // Nothing ever played: say so where it stays (a toast alone is easy to miss).
      const why = lastError
        ? lastError.slice(0, 300)
        : 'the player exited before anything played; is the URL playable?'
      $.ui.log(`stream-radio: could not play ${url}: ${why}`)
      $.ui.toast(`stream failed: ${why.slice(0, 120)}`)
    }
  })()
}

// Pauses or resumes through mpv; false while it is not listening yet. The new
// state is decided before sending and written as that value, not a flip: mpv's
// own status line reports the change while the send runs, and a late flip would
// undo it.
async function togglePause($: EngineInterface): Promise<boolean> {
  if (!control) return false
  const target = !(await read($, isPaused))
  const sent = await $.process.run(send(TOGGLE_PAUSE), { timeoutMs: 3000 }).catch(() => undefined)
  if (sent?.exitCode !== 0) return false
  await update($, isPaused, () => target)

  return true
}

// What the footer button opens: a question dialog with the song and the actions;
// text typed under "Other" is a URL to play.
async function openMenu($: EngineInterface, config: Config, defaultUrl: string) {
  const title = await read($, playing)
  const paused = await read($, isPaused)
  const done = await read($, percent)
  const last = await read($, lastUrl)
  const options = [paused ? 'Resume' : 'Pause', 'Stop']
  if (last) options.push('Play last')
  if (defaultUrl && defaultUrl !== last) options.push('Play default')
  const progress = done >= 0 ? ` (${done}%)` : ''
  const question = `Now playing: ${title}${progress}${paused ? ', paused' : ''}. Pick an action, or type a URL under Other?`
  let answer: string
  try {
    answer = await $.ui.ask(question, { options, header: 'Radio' })
  } catch {
    return // dismissed
  }
  if (answer === 'Pause' || answer === 'Resume') {
    if (!(await togglePause($))) $.ui.toast('The player is not ready yet.')
  } else if (answer === 'Stop') {
    await stop()
    await update($, playing, () => '')
  } else if (answer === 'Play last' && last) {
    start($, config, last)
  } else if (answer === 'Play default' && defaultUrl) {
    start($, config, defaultUrl)
  } else {
    const parsed = parseArgs(answer.trim(), '')
    if (parsed.kind === 'play') start($, config, parsed.url)
    else $.ui.toast('Type a full http(s) URL.')
  }
}

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv', androidClient = false } = options as Options
  const config: Config = { volume, player, androidClient }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    // State outlives a reload but the player does not: start from idle.
    await update($, playing, () => '')
    await update($, isPaused, () => false)
    await update($, percent, () => -1)
    if ((await read($, knownDefault)) !== defaultUrl) {
      await update($, knownDefault, () => defaultUrl)
      await update($, lastUrl, () => '')
    }
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | last | pause | stop]',
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
        if (!(await togglePause($))) return { text: 'The player is not ready yet.' }

        return { text: 'Toggled pause.' }
      }

      if (parsed.kind === 'last') {
        // What played last in this session; the default stream before anything has.
        const again = (await read($, lastUrl)) || defaultUrl
        if (!again) return { text: 'Nothing has played yet, and there is no default stream.' }
        start($, config, again)

        return { text: `Starting ${again}.` }
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
      // Idle: a button that plays again what played last, else the default
      // stream. It starts it directly: a plugin's own $.command.run never
      // reaches its own command.run hook.
      const again = (await read($, lastUrl)) || defaultUrl
      if (!again) return next(e)

      return (
        <Box flexDirection="row" gap={1}>
          {await next(e)}
          <Button
            key="stream-radio"
            label="▶ Play radio"
            onPress={() => start($, config, again)}
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
          onPress={() => openMenu($, config, defaultUrl)}
        />
      </Box>
    )
  })
}

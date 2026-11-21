import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Queue, Resume } from '../types'

import { completeLines, formatTime, marquee, parseArgs, parseNowPlaying, STATUS_FORMAT, textWidth, titleColumns } from './nowplaying'

// What the footer shows; empty when nothing plays.
const playing = atom({ plugin: 'stream-radio', key: 'playing' } as const, '')
const isPaused = atom({ plugin: 'stream-radio', key: 'isPaused' } as const, false)
// How far into the current file, in seconds; -1 for a live stream.
const elapsed = atom({ plugin: 'stream-radio', key: 'elapsed' } as const, -1)
// The current chapter's title (often the song in a multi-song video); empty when none.
const chapter = atom({ plugin: 'stream-radio', key: 'chapter' } as const, '')
// The last URL that actually played: what the idle button plays again.
const lastUrl = atom({ plugin: 'stream-radio', key: 'lastUrl' } as const, '')
// The default stream the last load saw: when it changes, the new default wins
// over the remembered URL.
const knownDefault = atom({ plugin: 'stream-radio', key: 'knownDefault' } as const, '')
// How far a title too long for the footer has scrolled, in ticks; 0 at its start.
const scroll = atom({ plugin: 'stream-radio', key: 'scroll' } as const, 0)

// What the panel lists to pick from.
// (Queue: see the type contract.)
const NO_QUEUE: Queue = { kind: 'none', items: [], current: -1 }
const queue = atom({ plugin: 'stream-radio', key: 'queue' } as const, NO_QUEUE)
// The reply to the panel's last action; empty for none.
const notice = atom({ plugin: 'stream-radio', key: 'notice' } as const, '')

// Where the last URL got to: its playlist entry (-1 when it has no playlist) and
// the seconds into it (-1 for a live stream), with the song's title. Outlives a
// reload, which kills the player, so playing the last URL again resumes there.
const NO_RESUME: Resume = { url: '', index: -1, seconds: -1, title: '' }
const resumeAt = atom({ plugin: 'stream-radio', key: 'resumeAt' } as const, NO_RESUME)
// Closer to a song's start than this, it resumes at the start.
const RESUME_MIN_SECONDS = 5

// One step of a long title's scroll.
const SCROLL_MS = 600

// Sends one command to mpv's IPC socket and prints its reply's data as JSON;
// exits 1 when mpv answers with an error. Other lines on the socket (events,
// replies to other requests) are skipped.
const IPC = `import socket,sys,json
s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])
s.sendall((json.dumps({"command":json.loads(sys.argv[2]),"request_id":7})+"\\n").encode())
b=b""
while True:
  c=s.recv(65536)
  if not c: sys.exit(1)
  b+=c
  *lines,b=b.split(b"\\n")
  for l in lines:
    d=json.loads(l or b"{}")
    if d.get("request_id")==7:
      print(json.dumps(d.get("data")))
      sys.exit(0 if d.get("error")=="success" else 1)`

// The panel; also the footer button's target.
const PANE = 'stream-radio'
const TITLE = 'Radio'

type Options = { defaultUrl?: string; volume?: number; player?: string; androidClient?: boolean; toggleOnly?: boolean }
type Config = { volume: number; player: string; androidClient: boolean; toggleOnly: boolean }

// URLs that only played with the android client; they start with it directly.
const needsAndroid = new Set<string>()

// The running player's stream: ending its loop kills the child.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let current: { return: (value: any) => Promise<unknown> } | undefined
// The socket path mpv listens on; undefined when nothing plays.
let control: string | undefined
let run = 0
// Steps a long title along while something plays; undefined otherwise.
let scroller: Timer | undefined

// The footer label's fixed part and its title: the icon and time stay put,
// only the title scrolls.
async function labelParts($: EngineInterface) {
  const title = await read($, playing)
  const paused = await read($, isPaused)
  const done = await read($, elapsed)
  const part = await read($, chapter)
  // A file in a playlist shows how far along it is; a live stream has no end.
  const progress = done >= 0 ? formatTime(done) : ''
  const icon = paused ? `⏸ ${progress}`.trim() : progress || '♪'
  // A video of several songs names each in a chapter: that comes first.
  const name = part ? `${part} · ${title}` : title
  return { prefix: `${icon} `, name, paused }
}

// Runs while a player runs; a tick moves the title only when it overflows and
// is not paused, so a short or paused title costs no redraws.
function startScroller($: EngineInterface) {
  scroller?.cancel()
  scroller = $.clock.every(SCROLL_MS, () => {
    void (async () => {
      const { prefix, name, paused } = await labelParts($)
      if (paused || textWidth(name) <= titleColumns(prefix)) return
      await update($, scroll, n => n + 1)
    })().catch(() => undefined)
  })
}

function stopScroller() {
  scroller?.cancel()
  scroller = undefined
}

// Ends the running player (if any); the caller clears the footer.
async function stop() {
  run += 1
  const old = current
  current = undefined
  control = undefined
  stopScroller()
  await old?.return(undefined)
}

// Runs one mpv command; resolves to its reply's data, or undefined when nothing
// plays, mpv is not listening yet or it refused.
async function mpv($: EngineInterface, command: readonly unknown[]): Promise<{ data: unknown } | undefined> {
  if (!control) return undefined
  const result = await $.process
    .run(['python3', '-I', '-c', IPC, control, JSON.stringify(command)], { timeoutMs: 3000 })
    .catch(() => undefined)
  if (result?.exitCode !== 0) return undefined
  try {
    return { data: JSON.parse(result.stdout || 'null') as unknown }
  } catch {
    return { data: null }
  }
}

// What the panel lists: the playlist's entries, else the file's chapters (a
// video of several songs), else nothing to pick from.
async function refreshQueue($: EngineInterface) {
  const list = (await mpv($, ['get_property', 'playlist']))?.data
  let next: Queue = NO_QUEUE
  if (Array.isArray(list) && list.length > 1) {
    const entries = list as { filename?: string; title?: string; current?: boolean }[]
    next = {
      kind: 'playlist',
      items: entries.map(e => e.title || e.filename || '?'),
      current: entries.findIndex(e => e.current),
    }
  } else {
    const chapters = (await mpv($, ['get_property', 'chapter-list']))?.data
    if (Array.isArray(chapters) && chapters.length > 1) {
      const at = (await mpv($, ['get_property', 'chapter']))?.data
      next = {
        kind: 'chapters',
        items: (chapters as { title?: string }[]).map((c, i) => c.title || `Chapter ${i + 1}`),
        current: typeof at === 'number' ? at : -1,
      }
    }
  }
  await update($, queue, () => next)
}

// Plays entry `index` of the queue, unpaused.
async function pick($: EngineInterface, index: number): Promise<string> {
  const q = await read($, queue)
  if (q.kind === 'none') return 'Nothing to pick from.'
  const ok = await mpv($, q.kind === 'playlist' ? ['playlist-play-index', index] : ['set_property', 'chapter', index])
  if (!ok) return 'The player is not ready yet.'
  await mpv($, ['set_property', 'pause', false])
  await update($, queue, x => ({ ...x, current: index }))
  return ''
}

// The next or previous playlist entry, else chapter.
async function step($: EngineInterface, by: 1 | -1): Promise<string> {
  const q = await read($, queue)
  if (q.kind === 'none') return 'Nothing before or after this.'
  const command =
    q.kind === 'playlist' ? [by > 0 ? 'playlist-next' : 'playlist-prev'] : ['add', 'chapter', by]
  return (await mpv($, command)) ? '' : 'The player is not ready yet.'
}

// Starts playing `url`. Returns at once: the first start after a reload is slow,
// and a hook that takes too long is reported as unanswered, so the startup runs
// in the background.
// `from`: a place to resume at once it plays, for the URL played last.
function start($: EngineInterface, config: Config, url: string, from?: Resume, retryClient?: string) {
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
    let lastSeconds = -1
    let lastChapter = ''
    let unread = ''
    let pipe = ''
    // Cleared once reached; until then the position is not recorded, or the first
    // song's start would overwrite where to go.
    let pending = from?.url === url && (from.index > 0 || from.seconds >= RESUME_MIN_SECONDS) ? from : undefined
    try {
      await old?.return(undefined)
      await update($, isPaused, () => false)
      await update($, elapsed, () => -1)
      await update($, chapter, () => '')
      await update($, scroll, () => 0)
      await update($, queue, () => NO_QUEUE)
      await update($, playing, () => 'connecting…')
      startScroller($)

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
          await update($, scroll, () => 0)
          await update($, playing, () => track.title)
          // Waited for: the position recorded below needs this song's place in it.
          await refreshQueue($).catch(() => undefined)
          if (pending) {
            const q = await read($, queue)
            if (q.kind === 'playlist' && pending.index >= 0 && pending.index < q.items.length && q.current !== pending.index) {
              // The jump starts another song; its title comes back through here.
              if (!(await mpv($, ['playlist-play-index', pending.index]))) pending = undefined
            } else {
              if (pending.seconds >= RESUME_MIN_SECONDS) await mpv($, ['seek', pending.seconds, 'absolute'])
              pending = undefined
            }
          }
        }
        const pos = track?.seconds ?? -1
        if (track && pos !== lastSeconds) {
          lastSeconds = pos
          await update($, elapsed, () => pos)
          if (!pending && lastTitle) {
            const q = await read($, queue)
            const index = q.kind === 'playlist' ? q.current : -1
            const title = (await read($, chapter)) || lastTitle
            await update($, resumeAt, () => ({ url, index, seconds: pos, title }))
          }
        }
        if (track && track.chapter !== null && track.chapter !== lastChapter) {
          const next = track.chapter
          lastChapter = next
          await update($, scroll, () => 0)
          await update($, chapter, () => next)
          void refreshQueue($).catch(() => undefined)
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
    stopScroller()
    await update($, playing, () => '')
    await update($, chapter, () => '')
    await update($, queue, () => NO_QUEUE)
    if (!lastTitle && !client) {
      // Nothing played with the default client: try once with android.
      $.ui.log(`stream-radio: ${url} would not play; retrying with the android client`)
      start($, config, url, from, 'android')

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
  if (!(await mpv($, ['set_property', 'pause', target]))) return false
  await update($, isPaused, () => target)

  return true
}

// Plays `url` again from where it got to, when that is where it got to.
function resume($: EngineInterface, config: Config, url: string, at: Resume) {
  start($, config, url, at.url === url ? at : undefined)
}

// Where playing `url` again picks up, as `Song name at 1:20`; empty when it
// starts at the beginning.
function resumable(at: Resume, url: string): string {
  if (at.url !== url || (at.index <= 0 && at.seconds < RESUME_MIN_SECONDS)) return ''
  const time = at.seconds >= RESUME_MIN_SECONDS ? ` at ${formatTime(at.seconds)}` : ''
  return `${at.title || 'where it was'}${time}`
}

async function stopPlaying($: EngineInterface) {
  await stop()
  await update($, playing, () => '')
  await update($, queue, () => NO_QUEUE)
}

// Opens the panel, or closes it if it is up; the footer button and /stream panel.
async function togglePane($: EngineInterface): Promise<'opened' | 'closed'> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    return 'closed'
  }
  await $.ui.open({ id: PANE, title: TITLE })
  return 'opened'
}

const cut = (text: string, width: number) => {
  if (textWidth(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (textWidth(out + ch) > width - 1) break
    out += ch
  }
  return `${out}…`
}

export const register: Register = (on, options) => {
  const { defaultUrl = '', volume = 60, player = 'mpv', androidClient = false, toggleOnly = false } = options as Options
  const config: Config = { volume, player, androidClient, toggleOnly }

  on('session.start', async ($, e, next) => {
    // 0.1.0 pinned the title as a status line; a reload leaves that line up.
    $.ui.status(undefined)
    // State outlives a reload but the player does not: start from idle.
    await update($, playing, () => '')
    await update($, isPaused, () => false)
    await update($, elapsed, () => -1)
    await update($, chapter, () => '')
    await update($, scroll, () => 0)
    await update($, queue, () => NO_QUEUE)
    await update($, notice, () => '')
    if ((await read($, knownDefault)) !== defaultUrl) {
      await update($, knownDefault, () => defaultUrl)
      await update($, lastUrl, () => '')
    }
    await $.command.register({
      name: 'stream',
      description: "Play a YouTube stream's audio; shows what is playing",
      argumentHint: '[url | last | pause | next | prev | panel | stop]',
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopPlaying($)

    return next(e)
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    // A throwing hook is skipped and /stream then says nothing useful: say why.
    try {
      const parsed = parseArgs(e.args, defaultUrl)
      if (parsed.kind === 'error') return { text: parsed.text }
      if (parsed.kind === 'stop') {
        await stopPlaying($)

        return { text: 'Stopped.' }
      }
      if (parsed.kind === 'panel') return { text: `Radio panel ${await togglePane($)}.` }
      if (parsed.kind === 'next' || parsed.kind === 'prev') {
        if (!control) return { text: 'Nothing is playing.' }
        return { text: (await step($, parsed.kind === 'next' ? 1 : -1)) || (parsed.kind === 'next' ? 'Next.' : 'Previous.') }
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
        const at = await read($, resumeAt)
        resume($, config, again, at)
        const where = resumable(at, again)

        return { text: where ? `Resuming ${where}.` : `Starting ${again}.` }
      }

      start($, config, parsed.url)

      return {
        text: `Starting ${parsed.url}. Click the footer title for the panel; /stream pause, next, prev or stop work too.`,
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
            onPress={async () => resume($, config, again, await read($, resumeAt))}
          />
        </Box>
      )
    }
    // At most LABEL_COLUMNS cells: the icon and time fixed, a long title
    // scrolling through what is left.
    const { prefix, name } = await labelParts($)
    const shown = marquee(name, titleColumns(prefix), await read($, scroll))

    return (
      <Box flexDirection="row" gap={1}>
        {await next(e)}
        <Button
          key="stream-radio"
          label={`${prefix}${shown}`}
          onPress={() => (config.toggleOnly ? void togglePause($) : void togglePane($))}
        />
      </Box>
    )
  })

  // The panel: what plays, its controls, the playlist or chapters to pick from,
  // and a URL field. Each action's reply shows in it: a button has no reply line.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const title = await read($, playing)
    const paused = await read($, isPaused)
    const done = await read($, elapsed)
    const part = await read($, chapter)
    const last = await read($, lastUrl)
    const q = await read($, queue)
    const said = await read($, notice)
    const act = async (work: () => Promise<string>) => {
      let reply: string
      try {
        reply = await work()
      } catch (error) {
        reply = `stream-radio failed: ${error instanceof Error ? error.message : String(error)}`
      }
      await update($, notice, () => reply)
    }
    const at = await read($, resumeAt)
    const resumeLabel = last ? resumable(at, last) : ''
    const play = (url: string) =>
      act(async () => {
        start($, config, url)
        return ''
      })
    const state = [
      done >= 0 ? formatTime(done) : 'live',
      paused ? 'paused' : '',
      q.kind !== 'none' && q.current >= 0 ? `${q.current + 1} of ${q.items.length}` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        {title ? (
          <Box flexDirection="column">
            <Text bold>{cut(part || title, width)}</Text>
            {part ? <Text dimColor>{cut(title, width)}</Text> : null}
            <Text dimColor>{state.join(' · ')}</Text>
            <Box flexDirection="row" gap={1}>
              {q.kind !== 'none' ? (
                <Button key="prev" label="⏮ Prev" onPress={() => act(() => step($, -1))} />
              ) : null}
              <Button
                key="pause"
                label={paused ? '▶ Resume' : '⏸ Pause'}
                onPress={() => act(async () => ((await togglePause($)) ? '' : 'The player is not ready yet.'))}
              />
              {q.kind !== 'none' ? (
                <Button key="next" label="Next ⏭" onPress={() => act(() => step($, 1))} />
              ) : null}
              <Button key="stop" label="⏹ Stop" onPress={() => act(async () => (await stopPlaying($), ''))} />
            </Box>
          </Box>
        ) : (
          <Text dimColor>Nothing playing.</Text>
        )}
        {(last && last !== title) || (defaultUrl && defaultUrl !== last) ? (
          <Box flexDirection="row" gap={1}>
            {last ? (
              <Button
                key="play-last"
                label={resumeLabel ? cut(`▶ Resume ${resumeLabel}`, width) : 'Play last'}
                onPress={() =>
                  act(async () => {
                    resume($, config, last, at)
                    return ''
                  })
                }
              />
            ) : null}
            {defaultUrl && defaultUrl !== last ? (
              <Button key="play-default" label="Play default" onPress={() => play(defaultUrl)} />
            ) : null}
          </Box>
        ) : null}
        <Input
          key="url"
          placeholder="YouTube or stream URL"
          submitLabel="play"
          onSubmit={(value: string) => {
            const parsed = parseArgs(value.trim(), '')
            return parsed.kind === 'play' ? play(parsed.url) : act(async () => 'Type a full http(s) URL.')
          }}
        />
        {said !== '' && <Text dimColor>{said}</Text>}
        {q.kind !== 'none' ? (
          <Box flexDirection="column">
            <Text dimColor>{q.kind === 'playlist' ? 'Playlist' : 'Chapters'}</Text>
            {q.items.map((item, i) => (
              <Button
                key={`item-${i}`}
                plain
                dimColor={i !== q.current}
                label={cut(`${i === q.current ? '▶' : ' '} ${i + 1}. ${item}`, width)}
                onPress={() => act(() => pick($, i))}
              />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}

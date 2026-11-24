import React from 'react'
import { render } from 'ink'
import { openSession } from './session'
import { FALLBACK_CELL, graphicsOn, probeTerminal, type Cell } from './gfx/probe'
import { App } from './ui/App'

// Set by build.mjs; absent under vitest or tsx.
declare const __VERSION__: string | undefined
declare const __COMMIT__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const COMMIT = typeof __COMMIT__ === 'string' ? __COMMIT__ : 'unknown'

const USAGE = `Usage: stream-radio-tui [url | path]

A full-screen player for the stream-radio mod's shared mpv. With a URL, or a
file, folder or playlist, it plays that; with none it follows the player that
is running, or shows the last URL, ready to play with l.

Keys:
  ↑/↓ or k/j   move            Enter   play the song, or open/shut a folder
  ←/→          shut/open folder
  space        pause           n/p     next/previous
  +/-          volume by 5     s       shuffle      r   repeat all/one/off
  /            filter (Enter plays the first match, Esc clears)
  o            open a URL or path
  l            play the last URL from where it got to
  x            stop the player
  q, Ctrl-C    quit (the music keeps playing)

Config: $XDG_CONFIG_HOME/stream-radio/config.json
        (~/.config/stream-radio/config.json without XDG_CONFIG_HOME)
        volume, player, androidClient, defaultUrl,
        graphics ("auto", "on" or "off": album art and a pixel waveform)

  --help       this text
  --version    the version`

// Whether to draw pictures, and the cell size to draw them at. The terminal is
// asked only when the setting leaves it open, and before Ink takes stdin.
async function pictures(setting: 'auto' | 'on' | 'off'): Promise<{ isOn: boolean; cell: Cell }> {
  const probe = setting === 'auto' || setting === 'on' ? await probeTerminal(process.stdin, process.stdout) : { kitty: false }
  return { isOn: graphicsOn(process.env, setting, probe), cell: probe.cell ?? FALLBACK_CELL }
}

const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'

async function main(argv: string[]) {
  if (argv.includes('--version')) return console.log(`stream-radio-tui ${VERSION} (${COMMIT})`)
  if (argv.includes('--help') || argv.includes('-h')) return console.log(USAGE)

  const listeners = new Set<() => void>()
  const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }
  const session = await openSession(argv, { onChange: () => listeners.forEach(fn => fn()) })
  const display = await pictures(session.config.graphics)

  let isOnAlt = true
  const leave = () => {
    if (isOnAlt) process.stdout.write(LEAVE_ALT)
    isOnAlt = false
  }
  process.stdout.write(ENTER_ALT)
  const app = render(<App session={session} subscribe={subscribe} />, { exitOnCtrlC: false })
  // Lets go of the player (it plays on), puts the terminal back, and goes.
  const bail = (code: number, error?: unknown) => {
    session.close()
    try {
      app.unmount()
    } catch {
      // already gone
    }
    leave()
    if (error !== undefined) console.error(error)
    process.exit(code)
  }
  process.on('SIGINT', () => bail(130))
  process.on('SIGTERM', () => bail(143))
  process.on('uncaughtException', error => bail(1, error))
  process.on('unhandledRejection', error => bail(1, error))

  await app.waitUntilExit()
  leave()
}

main(process.argv.slice(2)).catch(error => {
  process.stdout.write(LEAVE_ALT)
  console.error(error)
  process.exit(1)
})

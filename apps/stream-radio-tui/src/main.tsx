import React from 'react'
import { render } from 'ink'
import { openSession } from './session'
import { FALLBACK_CELL, graphicsOn, probeTerminal, type Cell } from './gfx/probe'
import { App } from './ui/App'
import { USAGE } from './help'
import { nodeMedia } from './media'
import { kittyGraphics, leaveScreen, type Graphics } from './gfx/screen'
import { mouseInput } from './mouse/input'
import { MOUSE_OFF, MOUSE_ON } from './mouse/sgr'

// Set by build.mjs; absent under vitest or tsx.
declare const __VERSION__: string | undefined
declare const __COMMIT__: string | undefined
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const COMMIT = typeof __COMMIT__ === 'string' ? __COMMIT__ : 'unknown'



// Whether to draw pictures, and the cell size to draw them at. The terminal is
// asked only when the setting leaves it open, and before Ink takes stdin.
async function pictures(setting: 'auto' | 'on' | 'off'): Promise<{ isOn: boolean; cell: Cell }> {
  const probe = setting === 'auto' || setting === 'on' ? await probeTerminal(process.stdin, process.stdout) : { kitty: false }
  return { isOn: graphicsOn(process.env, setting, probe), cell: probe.cell ?? FALLBACK_CELL }
}

const ENTER_ALT = '\x1b[?1049h'
// The pictures on screen, for the last-resort exit below main.
let shown: Graphics | undefined

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
  const write = (s: string) => void process.stdout.write(s)
  const graphics = display.isOn ? kittyGraphics(write, display.cell) : undefined
  shown = graphics

  // Every way out deletes the pictures, then leaves the alternate screen.
  let isOnAlt = true
  const leave = () => {
    if (isOnAlt) leaveScreen(graphics, write)
    isOnAlt = false
  }
  process.stdout.write(ENTER_ALT)
  // Clicks come out of stdin before Ink reads it; Ink gets the keys.
  const input = session.config.mouse === 'on' ? mouseInput(process.stdin, () => write(MOUSE_OFF)) : undefined
  if (input) write(MOUSE_ON)
  const app = render(<App session={session} subscribe={subscribe} media={nodeMedia(process.env, session.config.player)} graphics={graphics} mouse={input?.subscribe} />, {
    exitOnCtrlC: false,
    stdin: input?.stdin ?? process.stdin,
  })
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
  process.on('SIGHUP', () => bail(129))
  process.on('uncaughtException', error => bail(1, error))
  process.on('unhandledRejection', error => bail(1, error))

  await app.waitUntilExit()
  leave()
  input?.close()
}

main(process.argv.slice(2)).catch(error => {
  leaveScreen(shown, s => void process.stdout.write(s))
  console.error(error)
  process.exit(1)
})

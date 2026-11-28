import { describe, expect, test } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { iconsFor, IconsContext, NERD_ICONS, PLAIN_ICONS } from '../src/ui/icons'
import { Controls } from '../src/ui/Controls'
import { helpLines } from '../src/ui/Help'
import { usage } from '../src/help'

describe('iconsFor', () => {
  test('auto: Nerd Font icons in the terminals that bundle the font', () => {
    expect(iconsFor({ TERM: 'xterm-kitty' }, 'auto')).toBe(NERD_ICONS)
    expect(iconsFor({ KITTY_WINDOW_ID: '1', TERM: 'tmux-256color' }, 'auto')).toBe(NERD_ICONS)
    expect(iconsFor({ TERM_PROGRAM: 'ghostty' }, 'auto')).toBe(NERD_ICONS)
    expect(iconsFor({ GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty', TERM_PROGRAM: 'tmux' }, 'auto')).toBe(NERD_ICONS)
    expect(iconsFor({ TERM_PROGRAM: 'WezTerm' }, 'auto')).toBe(NERD_ICONS)
    expect(iconsFor({ WEZTERM_PANE: '0', TERM_PROGRAM: 'tmux' }, 'auto')).toBe(NERD_ICONS)
  })
  test('auto: plain shapes anywhere else, Termux among them', () => {
    expect(iconsFor({ TERMUX_VERSION: '0.118.1', TERM: 'xterm-256color' }, 'auto')).toBe(PLAIN_ICONS)
    expect(iconsFor({ TERM: 'xterm-256color' }, 'auto')).toBe(PLAIN_ICONS)
    expect(iconsFor({}, 'auto')).toBe(PLAIN_ICONS)
  })
  test('auto: Nerd Font icons in Termux when its font has them', () => {
    expect(iconsFor({ TERMUX_VERSION: '0.118.1' }, 'auto', true)).toBe(NERD_ICONS)
    expect(iconsFor({ TERMUX_VERSION: '0.118.1' }, 'auto', false)).toBe(PLAIN_ICONS)
    expect(iconsFor({ TERMUX_VERSION: '0.118.1' }, 'plain', true)).toBe(PLAIN_ICONS)
  })
  test('the setting overrides the guess', () => {
    expect(iconsFor({ TERMUX_VERSION: '0.118.1' }, 'nerd')).toBe(NERD_ICONS)
    expect(iconsFor({ TERM: 'xterm-kitty' }, 'plain')).toBe(PLAIN_ICONS)
  })
})

describe('the plain icons', () => {
  test('the controls draw them, the volume bar ending at the width', () => {
    const { lastFrame } = render(
      <IconsContext.Provider value={PLAIN_ICONS}>
        <Controls isPaused={false} isStopped={false} volume={60} width={40} />
      </IconsContext.Provider>,
    )
    const line = lastFrame()!
    expect(line.startsWith('◂◂  ‖  ▸▸  ■   |')).toBe(true)
    expect(line.endsWith('|')).toBe(true)
    expect([...line].length).toBe(40)
  })
  test('paused, play shows in pause\'s place and nothing moves', () => {
    const { lastFrame } = render(
      <IconsContext.Provider value={PLAIN_ICONS}>
        <Controls isPaused={true} isStopped={false} volume={60} width={40} />
      </IconsContext.Provider>,
    )
    expect(lastFrame()!.startsWith('◂◂  ▸  ▸▸  ■   |')).toBe(true)
    expect([...lastFrame()!].length).toBe(40)
  })
  test('the ? screen and --help name them', () => {
    expect(helpLines('queue', PLAIN_ICONS).some(l => l.text.includes('◂◂  ‖  ▸▸  ■'))).toBe(true)
    expect(usage(PLAIN_ICONS)).toContain('◂◂  ‖  ▸▸  ■')
    expect(usage(PLAIN_ICONS)).not.toContain(NERD_ICONS.prev)
  })
})

import { createContext } from 'react'
import type { IconsSetting } from '../config'

// The controls' icons: previous, pause, play, next, stop.
export type Icons = { prev: string; pause: string; play: string; next: string; stop: string }

// Nerd Font Material icons. Each takes one column; kitty may draw it over the
// space after it, so each button is the icon and a space.
export const NERD_ICONS: Icons = { prev: '\u{F04AE}', pause: '\u{F03E4}', play: '\u{F040A}', next: '\u{F04AD}', stop: '\u{F04DB}' }

// For a font without them (Termux's, most terminals' defaults): shapes nearly
// every font has, which no terminal draws as emoji (⏮ ⏸ and ▶ can be, two
// columns wide). Pause and play are as wide, so nothing moves when they swap.
export const PLAIN_ICONS: Icons = { prev: '◂◂', pause: '‖', play: '▸', next: '▸▸', stop: '■' }

// `auto`: Nerd Font icons only in the terminals that bundle the font (kitty,
// Ghostty, WezTerm), found by the variables they set, which tmux passes on.
// Whether any other terminal's font has them can't be asked.
export function iconsFor(env: Record<string, string | undefined>, setting: IconsSetting): Icons {
  if (setting !== 'auto') return setting === 'nerd' ? NERD_ICONS : PLAIN_ICONS
  const bundled =
    env.TERM === 'xterm-kitty' ||
    !!env.KITTY_WINDOW_ID ||
    env.TERM_PROGRAM === 'ghostty' ||
    !!env.GHOSTTY_RESOURCES_DIR ||
    env.TERM_PROGRAM === 'WezTerm' ||
    !!env.WEZTERM_PANE
  return bundled ? NERD_ICONS : PLAIN_ICONS
}

// The set main.tsx chose; Nerd Font icons where nothing provides one (tests).
export const IconsContext = createContext<Icons>(NERD_ICONS)

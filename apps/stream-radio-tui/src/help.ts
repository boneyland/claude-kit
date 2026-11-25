import { textWidth } from '@core/nowplaying'
import { ICONS } from './ui/Controls'

// The one list of keys and what the mouse does: the ? screen (ui/Help.tsx)
// and --help both draw it, and a test checks the README's tables name every key.

// Every key, as the README's tables have it: the keys of both tabs, then each tab's own.
export const KEY_HELP: [string, string][] = [
  ['Tab  Shift-Tab', 'switch tabs: Files and the queue'],
  ['↑ ↓  k j', 'move'],
  ['Shift-↑ ↓', 'pick rows from the cursor'],
  ['space', 'pause or resume; while rows are picked, pick or unpick this one'],
  ['Esc', 'clear the pick'],
  ['m', "the row's menu"],
  ['S', 'sort by the next field; after the last, as queued'],
  ['n  p', 'next or previous song'],
  ['b  f', 'jump 10 seconds back or ahead'],
  ['+ =  -', 'volume up or down a step (3 dB)'],
  ['s', 'shuffle on or off'],
  ['r', 'repeat: all, one, off'],
  ['o', 'go to a folder, or a YouTube playlist URL, in Files'],
  ['G', "Files: the folder of the song playing, the cursor on it"],
  ['l', 'resume the playlist from where it got to'],
  ['x', 'stop (the playlist stays)'],
  ['?', 'this list'],
  ['q, Ctrl-C twice', 'quit; the music keeps playing'],
]

export const PLAYLIST_KEY_HELP: [string, string][] = [
  ['Enter', 'play the song from its start'],
  ['Alt-↑ ↓  u d', 'move the picked songs (or this one)'],
  ['Delete', 'remove the picked songs (or this one)'],
  ['R', 'sort the other way round'],
  ['C twice', 'clear the playlist and stop; l brings it back'],
  ['/', 'filter the list; Enter plays the first match, Esc clears'],
]

export const FILES_KEY_HELP: [string, string][] = [
  ['Enter', 'open or shut a folder; on ../ go up; on a file, add to queue'],
  ['← →', 'shut or open a folder'],
  ['U', 'the folder above (../)'],
  ['o, click heading', 'edit the location: ← → Ctrl-A/E/W/U/K/D, Enter goes'],
  ['a', 'add to queue: the picked rows, or this one'],
  ['A', 'play next: the same, after the song playing'],
]

// What the mouse does.
export const MOUSE_HELP: [string, string][] = [
  ['click', 'select a row; on a folder, open or shut it; on ../, go up'],
  ['Ctrl-click', 'pick or unpick a row'],
  ['Shift-, Alt-click', 'pick the rows from the cursor to there'],
  ['double-click', 'Playlist: play the song; Files: add to queue'],
  ['right-click, ⋯', "the row's menu"],
  ['drag', 'Playlist: move the picked songs (or the one dragged)'],
  ['wheel', 'scroll the list'],
  ['Files heading', 'edit the location there; Esc leaves it'],
  [`${ICONS.prev}  ${ICONS.pause}  ${ICONS.next}  ${ICONS.stop}`, 'previous, pause or play, next, stop'],
  ['volume bar', 'set the volume there'],
  ['repeat, shuffle', 'switch them'],
  ['waveform, bar', 'seek there'],
  ['Shift-drag', 'select text, as the terminal does (see the README for kitty)'],
]

// padded by screen columns: a Nerd Font icon is two UTF-16 units but one column
const list = (rows: [string, string][]) => rows.map(([k, what]) => `  ${k}${' '.repeat(Math.max(1, 20 - textWidth(k)))}${what}`).join('\n')

// What --help prints.
export const USAGE = `Usage: stream-radio-tui [url | path]

A full-screen player for the stream-radio mod's shared mpv. With a URL, or a
file, folder or playlist, it plays that; with none it follows the player that
is running, or shows the last URL, ready to play with l.

Two tabs: Files, to browse folders and add songs, and Playlist, the queue.

Keys (both tabs):
${list(KEY_HELP)}

Playlist tab:
${list(PLAYLIST_KEY_HELP)}

Files tab:
${list(FILES_KEY_HELP)}

Mouse:
${list(MOUSE_HELP)}

Config: $XDG_CONFIG_HOME/stream-radio/config.json
        (~/.config/stream-radio/config.json without XDG_CONFIG_HOME)
        volume, player, androidClient, defaultUrl,
        graphics ("auto", "on" or "off": album art and a pixel waveform),
        mouse ("on" or "off": clicks and the wheel; Shift-drag selects text)

  --help       this text
  --version    the version`

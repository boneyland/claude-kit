import { textWidth } from '@core/nowplaying'
import { ICONS } from './ui/Controls'

// The one list of keys and what the mouse does: the ? screen (ui/Help.tsx)
// and --help both draw it, and a test checks the README's tables name every key.

// Every key, as the README's tables have it: the keys of every tab, then each tab's own.
export const KEY_HELP: [string, string][] = [
  ['Tab  Shift-Tab', 'switch tabs: Files, Queue, Playlists, or back'],
  ['↑ ↓  k j', 'move'],
  ['PgUp  PgDn', 'move a page'],
  ['Home  End', 'the first or last row'],
  ['Shift-↑ ↓', 'pick rows from the cursor'],
  ['space', 'pause or resume; stopped, play the queue from its song\'s start; while rows are picked, pick or unpick this one'],
  ['Esc', 'clear the pick'],
  ['m', "the row's menu"],
  ['*', 'favourite or unfavourite: the picked songs, or this one (a folder: every song in it); with no rows, the song playing'],
  ['P', 'add to playlist: a checklist of the playlists, ✓ all in, – some; Enter adds or takes out and it stays open, Esc closes'],
  ['S', 'sort by the next field; after the last, as queued'],
  ['n  p', 'next or previous song'],
  ['b  f', 'jump 10 seconds back or ahead'],
  ['+ =  -', 'volume up or down a step (3 dB)'],
  ['s', 'shuffle on or off'],
  ['r', 'repeat: all, one, off'],
  ['o', 'go to a folder, or a YouTube playlist URL, in Files'],
  ['G', "Files: the folder of the song playing, the cursor on it"],
  ['l', 'resume the queue from where it got to'],
  ['x', 'stop (the queue stays)'],
  ['?', 'this list'],
  ['q, Ctrl-C twice', 'quit; the music keeps playing'],
]

export const QUEUE_KEY_HELP: [string, string][] = [
  ['Enter', 'play the song from its start'],
  ['Alt-↑ ↓  u d', 'move the picked songs (or this one)'],
  ['Delete', 'remove the picked songs (or this one)'],
  ['R', 'sort the other way round'],
  ['C twice', 'clear the queue and stop; l brings it back'],
  ['/', 'filter the list; Enter plays the first match, Esc clears'],
]

export const FILES_KEY_HELP: [string, string][] = [
  ['Enter', 'open or shut a folder; on ../ go up; on a file, add to queue'],
  ['← →', 'shut or open a folder'],
  ['U', 'the folder above (../)'],
  ['o, click heading', 'edit the location: ← → Home End Ctrl-A/E/W/U/K/D, Enter goes'],
  ['a', 'add to queue: the picked rows, or this one'],
  ['A', 'play next: the same, after the song playing'],
]

export const PLAYLISTS_KEY_HELP: [string, string][] = [
  ['Enter', 'open a list; on ../ go back; on + New playlist…, name a new one; on a song, play the list from it'],
  ['← →', 'back to the lists, or open the list'],
  ['U', 'back to the lists (../)'],
  ['a', 'add to queue: the picked songs, or the whole list'],
  ['A', 'play next: the same, after the song playing'],
  ['Delete', 'take the picked songs out of the list (the files stay); on a playlist, delete it, after asking'],
  ['/', 'filter the open list; Enter plays it from the first match, Esc clears'],
  ['Enter  Esc', 'in the name prompt (New playlist, Rename): save the name, or leave it as it was'],
]

// What the mouse does.
export const MOUSE_HELP: [string, string][] = [
  ['click', 'select a row; on a folder, open or shut it; on a playlist, open it; on ../, go up'],
  ['Ctrl-click', 'pick or unpick a row'],
  ['Shift-, Alt-click', 'pick the rows from the cursor to there'],
  ['double-click', 'Queue: play the song; Files: add to queue; Playlists: play the list from the song'],
  ['right-click, ⋯', "the row's menu"],
  ['drag', 'Queue: move the picked songs (or the one dragged)'],
  ['wheel', 'scroll the list'],
  ['sort: …', 'sort by the next field'],
  ['↓  ↑ after it', 'Queue: sort the other way round'],
  ['Files heading', 'edit the location there; Esc leaves it'],
  [`${ICONS.prev}  ${ICONS.pause}  ${ICONS.next}  ${ICONS.stop}`, 'previous, pause or play, next, stop'],
  ['★', 'by the title playing: take it out of Favourites'],
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

Three tabs: Files, to browse folders and add songs; Queue, what plays; and
Playlists: Favourites, Recently played and the saved playlists.

Keys (every tab):
${list(KEY_HELP)}

Queue tab:
${list(QUEUE_KEY_HELP)}

Files tab:
${list(FILES_KEY_HELP)}

Playlists tab:
${list(PLAYLISTS_KEY_HELP)}

Mouse:
${list(MOUSE_HELP)}

Config: $XDG_CONFIG_HOME/stream-radio/config.json
        (~/.config/stream-radio/config.json without XDG_CONFIG_HOME)
        volume, player, androidClient, defaultUrl,
        graphics ("auto", "on" or "off": album art and a pixel waveform),
        mouse ("on" or "off": clicks and the wheel; Shift-drag selects text)

  --help       this text
  --version    the version`

# stream-radio-tui

A full-screen terminal music player for the same mpv the [stream-radio](../../plugins/stream-radio) mod drives. Play a YouTube stream, a file, a folder or a playlist from any terminal, with or without Claude Code.

It shares the one player with the mod's sessions: start music in either and the other shows it, pauses it, skips it, stops it. Playback state is kept in `${XDG_STATE_HOME:-~/.local/state}/stream-radio/`, which both read.

## Install

```
curl -fsSL https://raw.githubusercontent.com/boneyland/claude-kit/main/apps/stream-radio-tui/install.sh | sh
```

This downloads the latest build to `~/.local/bin/stream-radio-tui` (set `PREFIX` to use another folder), checks it against the SHA-256 the release publishes beside it, and says whether that folder is on your `PATH`. Run it again to update.

Needs `node` 22 or newer, `mpv`, `curl`, and `sha256sum` or `shasum`. YouTube also needs `yt-dlp` (and `python3` for it); the installer warns when they are missing.

## Use

```
stream-radio-tui                     # follows the running player, or shows the playlist as it was left
stream-radio-tui https://www.youtube.com/watch?v=tRsQsTMvPNg
stream-radio-tui ~/Music/Album       # a folder, file, .m3u/.pls or YouTube playlist becomes the playlist
```

With no argument it attaches to the player that is already running, or shows the playlist as it was left, ready to play with `l` (from where it got to) or `space` (from the start of its song). A YouTube link to a video in a playlist (`watch?v=…&list=…`) queues the playlist and starts at that video; while yt-dlp or curl reads a playlist, the title shows `loading…`.

The list has two tabs: **Files**, a folder browser to pick songs from, and **Playlist**, the queue that plays. It opens on the Playlist when something is queued, else on Files. `Tab` or a click on a tab's name switches; each tab keeps its own cursor, picked rows and scroll.

### Both tabs

| Key | |
| --- | --- |
| `Tab`, `Shift-Tab` | switch tabs |
| `↑` `↓` or `k` `j` | move |
| `Shift-↑` `Shift-↓` | pick rows from the cursor (`Shift-↓` then `Shift-↑` leaves one row picked, as in a file manager) |
| `space` | pause or resume; while stopped, play the playlist from the start of the song it stopped on (`l` resumes mid-song); while any row is picked, pick or unpick the cursor's row instead |
| `Esc` | clear the pick |
| `m` | the row's menu (also a right-click, or the `⋯` at the end of the cursor's row) |
| `S` | sort by the next field; after the last, back to `as queued` (also the `sort:` control on the tab row) |
| `n` `p` | next or previous song |
| `b` `f` | jump 10 seconds back or ahead (not in a live stream) |
| `+` / `=`, `-` | volume up or down a step: about 3 dB, the same change at any level |
| `s` | shuffle |
| `r` | repeat: all, one, off |
| `o` | go to a folder, or a YouTube playlist URL, in Files |
| `G` | Files at the folder of the song playing, the cursor on it |
| `l` | resume the playlist from where it got to (after `x`, or on a fresh start); after `C` `C` it brings the cleared playlist back; while it plays, does nothing |
| `x` | stop; the playlist stays, and `Enter` or `l` plays it again |
| `?` | every key of the tab showing, and what the mouse does; `?`, `Esc` or `q` closes it |
| `q`, or `Ctrl-C` twice | quit the TUI; the music keeps playing. A single `Ctrl-C` only says to press it again, so a copy habit does not quit (kitty copies with `Ctrl-Shift-C`) |

Actions take the picked rows, or the cursor's row when none is picked. Adding or removing clears the pick; moving keeps it, so the same songs can be moved again.

### Files

Opens at the last folder browsed, else `~/Music`, else the home folder. It lists folders and the files mpv plays (sound, video and playlist files); dotfiles and everything else stay hidden. The heading shows where you are; `../` is always the first row.

Click the heading's location to edit it in place, the cursor where you clicked. `o` does the same from an empty line. While editing: `←` `→` or a click move the cursor, `Ctrl-A` `Ctrl-E` jump to the start or end, Backspace and `Ctrl-D` erase before or after it, `Ctrl-W` takes off a folder, `Ctrl-U` `Ctrl-K` erase to the start or end. `Enter` goes there; `Esc`, or a click on a row, leaves it as it was. (Home and End don't reach the TUI.)

| Key | |
| --- | --- |
| `Enter` | open or shut a folder; on `../`, go up; on a file, add it to the queue |
| `←` `→` | shut or open a folder |
| `U` | the folder above (`../`) |
| `a` | add to the queue |
| `A` | play next: add after the song playing |
| `S` | sort files by name, date modified, artist or album artist (folders stay first, by name) |

Files never starts, stops or skips music while something plays. Adding while nothing plays starts the queue. A folder adds every song in it, through its subfolders.

A YouTube playlist URL typed after `o` lists its videos as one folder (read with `yt-dlp`, up to 1000); adding the folder adds every video. If yt-dlp can't list it, its error shows on the status line and the tree stays as it was.

### Playlist

One row per song: its title (from its tags, else its file name), then, dimmed, its artist and its folder or site. A video with chapters lists its chapters here until something is added.

| Key | |
| --- | --- |
| `Enter` | play the song, from its start (also while stopped) |
| `Alt-↑` `Alt-↓`, or `u` `d` | move the picked songs one place |
| `Delete` (or Backspace) | remove the picked songs |
| `S` | sort by title, artist, album artist, album, or folder then file name, then `as queued` (the order the songs were added or moved to) |
| `R` | the same sort the other way round |
| `C` twice | clear the playlist and stop; `l` brings it back (also in the row's menu) |
| `/` | filter the list; `Enter` plays the first match, `Esc` clears |

A sort reorders what plays: it plays in that order afterwards, and songs added later go where they are added (not sorted in). It can be undone: `S` past the last field, or `s` on a shuffle, goes back to `as queued`, the order the songs were added or moved to. Moving a song by hand makes the order shown the queued order, and turns a sort or shuffle off; a sort replaces a shuffle. The song playing keeps playing through any sort, move, add or removal. Removing the song playing plays the next; removing every song stops, as `x` does, and so does clearing the playlist. A stop keeps the queue: it still lists, and while stopped you can edit it, `Enter` plays a song from its start, `space` (or the play control) plays the song it stopped on from its start, and `l` resumes the saved place.

`q` only closes the TUI. Run `stream-radio-tui` again, or use the mod, to get back to it. `x` stops the player itself.

## Mouse

Everything the keys do, the mouse can do too:

- **Rows:** a click selects a row; in Files a click on a folder opens or shuts it and a click on `../` goes up. A double-click plays the song in the Playlist, and adds the file or folder to the queue in Files. Ctrl-click picks or unpicks a row; Shift-click or Alt-click picks the rows from the cursor to there. A right-click opens the row's menu.
- **Drag:** in the Playlist, drag a song (or any of the picked songs) and let go where they should go: they land above the row marked `⤵`.
- **Tabs:** a click on `Files` or `Playlist` switches; a click on `sort: …` sorts by the next field.
- **Wheel:** scrolls the list without moving the selection; a key that moves the selection brings the view back to it.
- **Controls:** 󰒮 previous, 󰏤 pause (󰐊 while paused; stopped, it plays as `space` does), 󰓛 stop, 󰒭 next (Nerd Font icons, which kitty and Ghostty bundle); `repeat …` and `shuffle …` switch when clicked.
- **Volume:** the bar `|██████vol 60%       |` sets the volume where you click it, to the nearest 5 %.
- **Seek:** a click on the waveform, or on the plain bar, jumps there. Live streams have no bar.

While the mouse is on, the terminal leaves clicks to the TUI: hold Shift to select text (in kitty, Shift-drag). Set `mouse` to `off` to keep the terminal's own selection.

kitty keeps Shift-click for its own selection, so Shift-click never reaches the TUI there; Alt-click picks a range too. To have Shift-click reach it, add `terminal_select_modifiers ctrl+shift` to `kitty.conf`; text selection then takes Ctrl+Shift-drag.

## Pictures

In a window 80 or more columns wide, the right-hand column shows what plays from top to bottom:

- **Album art**, in terminals that can draw pictures (see below). It is the art inside the song's file, else a `cover`, `folder`, `front` or `album` image (`.jpg`, `.jpeg`, `.png` or `.webp`) in its folder; for a YouTube video, its thumbnail. With none, a large ♪ in a frame shows in its place.
- **The title**, the artist and album when the file has them, and the volume, repeat and shuffle.
- **The song's waveform** as the progress bar, for local files: in pixels where pictures work, in braille dots elsewhere. YouTube videos keep the plain bar; live streams show `♪ live`.

Pictures need a terminal that speaks the Kitty graphics protocol with its placeholder cells, such as kitty or Ghostty. The TUI asks the terminal when it starts. It keeps to text inside tmux or screen, and in WezTerm and Konsole, which draw Kitty pictures but not the placeholder cells yet. The `graphics` setting below overrides the guess.

Waveforms and art are decoded by mpv and kept in `${XDG_CACHE_HOME:-~/.cache}/stream-radio/`, so a song played again shows them at once.

## Config

Optional, in `${XDG_CONFIG_HOME:-~/.config}/stream-radio/config.json`:

```json
{ "volume": 60, "player": "mpv", "androidClient": false, "defaultUrl": "", "graphics": "auto", "mouse": "on" }
```

| Field | Default | |
| --- | --- | --- |
| `volume` | 60 | 0 to 100, where playback starts |
| `player` | `mpv` | the mpv executable; it also decodes the art and waveforms |
| `androidClient` | `false` | try yt-dlp's android client first (see the [mod's README](../../plugins/stream-radio/README.md)) |
| `defaultUrl` | empty | what `l` plays when the playlist is empty and nothing cleared can come back |
| `graphics` | `auto` | album art and a pixel waveform: `auto` asks the terminal, `on` or `off` forces it |
| `mouse` | `on` | clicks and the wheel (see Mouse); `off` leaves text selection to the terminal |

A missing file, or a field of the wrong type, gives that field's default. The mod has its own settings with the same names; they are separate.

## Build from source

```
cd apps/stream-radio-tui
npm ci
npm run build        # writes dist/stream-radio-tui.mjs
npm test
node dist/stream-radio-tui.mjs --help
```

Only source is committed. A GitHub Actions workflow tests, builds and publishes `stream-radio-tui.mjs` to the `stream-radio-tui-rolling` prerelease, whose tag moves to each new build, on each push to `main` that touches the TUI or the mod's core.

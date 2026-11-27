# stream-radio-tui

A full-screen terminal music player for the same mpv the [stream-radio](../../plugins/stream-radio) mod drives. Play a YouTube stream, a file, a folder or a playlist from any terminal, with or without Claude Code.

It shares the one player with the mod's sessions: start music in either and the other shows it, pauses it, skips it, stops it. Playback state is kept in `${XDG_STATE_HOME:-~/.local/state}/stream-radio/`, which both read.

## Install

```
curl -fsSL https://raw.githubusercontent.com/boneyland/claude-kit/main/apps/stream-radio-tui/install.sh | sh
```

This downloads the latest build to `~/.local/bin/stream-radio-tui`, checks it against the SHA-256 the release publishes beside it (a download or check that fails is tried twice more, 10 s apart, as one can for a moment while a new build is published), and says whether that folder is on your `PATH`. Run it again to update.

To put it in another folder, set `STREAM_RADIO_TUI_DIR` to that folder, in front of `sh` (the program that reads it), not `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/boneyland/claude-kit/main/apps/stream-radio-tui/install.sh | STREAM_RADIO_TUI_DIR=~/bin sh
```

That installs `~/bin/stream-radio-tui`: the file goes straight into the folder you name. Without the variable, the folder is `~/.local/bin`.

Needs `node` 22 or newer, `mpv`, `curl`, and `sha256sum` or `shasum`. YouTube also needs `yt-dlp` (and `python3` for it); the installer warns when they are missing.

## Use

```
stream-radio-tui                     # follows the running player, or shows the queue as it was left
stream-radio-tui https://www.youtube.com/watch?v=tRsQsTMvPNg
stream-radio-tui ~/Music/Album       # a folder, file, .m3u/.pls or YouTube playlist becomes the queue
```

With no argument it attaches to the player that is already running, or shows the queue as it was left, ready to play with `l` (from where it got to) or `space` (from the start of its song). A YouTube link to a video in a playlist (`watch?v=…&list=…`) queues the playlist and starts at that video; while yt-dlp or curl reads a playlist, the title shows `loading…`.

The list has three tabs: **Files**, a folder browser to pick songs from, **Queue**, what plays, and **Playlists**, your saved lists (★ Favourites and the ones you made) and Recently played. It opens on the Queue when something is queued, else on Files. `Tab` or a click on a tab's name switches; each tab keeps its own cursor, picked rows and scroll.

### Every tab

| Key | |
| --- | --- |
| `Tab`, `Shift-Tab` | switch tabs |
| `↑` `↓` or `k` `j` | move |
| `PgUp` `PgDn` | move a page up or down |
| `Home` `End` | the first or last row |
| `Shift-↑` `Shift-↓` | pick rows from the cursor (`Shift-↓` then `Shift-↑` leaves one row picked, as in a file manager) |
| `space` | pause or resume; while stopped, play the queue from the start of the song it stopped on (`l` resumes mid-song); while any row is picked, pick or unpick the cursor's row instead |
| `Esc` | clear the pick |
| `m` | the row's menu (also a right-click, or the `⋯` at the end of the cursor's row) |
| `*` | favourite or unfavourite the picked songs, or the cursor's (a folder: every song in it, through subfolders); with no rows, the song playing. Favourites show `★` before the title |
| `P` | add to playlist: a checklist of the playlists, `✓` when every song is in one, `–` when some are; `Enter` adds the missing songs or takes them all out and the checklist stays open; `+ New playlist…` makes one with the songs; `Esc` closes |
| `S` | sort by the next field; after the last, back to `as queued` (also the `sort:` control on the tab row) |
| `n` `p` | next or previous song |
| `b` `f` | jump 10 seconds back or ahead (not in a live stream) |
| `+` / `=`, `-` | volume up or down a step: about 3 dB, the same change at any level |
| `s` | shuffle |
| `r` | repeat: all, one, off |
| `o` | go to a folder, or a YouTube playlist URL, in Files |
| `G` | Files at the folder of the song playing, the cursor on it |
| `l` | resume the queue from where it got to (after `x`, or on a fresh start); after `C` `C` it brings the cleared queue back; while it plays, does nothing |
| `x` | stop; the queue stays, and `Enter` or `l` plays it again |
| `?` | every key of the tab showing, and what the mouse does; `?`, `Esc` or `q` closes it |
| `q`, or `Ctrl-C` twice | quit the TUI; the music keeps playing. A single `Ctrl-C` only says to press it again, so a copy habit does not quit (kitty copies with `Ctrl-Shift-C`) |

Actions take the picked rows, or the cursor's row when none is picked. Adding or removing clears the pick; moving keeps it, so the same songs can be moved again.

### Files

Opens at the last folder browsed, else `~/Music`, else the home folder. It lists folders and the files mpv plays (sound, video and playlist files); dotfiles and everything else stay hidden. A folder shows `🢒`, `🢓` when open. The heading shows where you are; `../` is always the first row.

`/`, or a click on `Filter ·` at the right of the heading, filters the folders read so far (the root and the open folders): a file stays when every word is in its name, its folders' names or its artist, a folder that matches keeps what shows under it, and the folders above a match stay. Folders not yet opened aren't searched. `Enter` keeps the filter, the cursor on the first file that matches; `Esc` clears it, and so does going to another folder.

Click the heading's location to edit it in place, the cursor where you clicked. `o` does the same from an empty line. While editing: `←` `→` or a click move the cursor, `Home` `End` or `Ctrl-A` `Ctrl-E` jump to the start or end, Backspace and `Ctrl-D` erase before or after it, `Ctrl-W` takes off a folder, `Ctrl-U` `Ctrl-K` erase to the start or end. `Enter` goes there; `Esc`, or a click on a row, leaves it as it was.

| Key | |
| --- | --- |
| `Enter` | open or shut a folder; on `../`, go up; on a file, add it to the queue |
| `←` `→` | shut or open a folder |
| `U` | the folder above (`../`) |
| `/` | filter the folders read so far, at the right of the heading; `Enter` keeps it, `Esc` clears |
| `a` | add to the queue |
| `A` | play next: add after the song playing |
| `S` | sort files by name, date modified, artist or album artist (folders stay first, by name) |
| `R` | the same sort the other way round, folders too when by name (also the `↓` / `↑` after `sort:` on the tab row) |

Files never starts, stops or skips music while something plays. Adding while nothing plays starts the queue. A folder adds every song in it, through its subfolders.

A YouTube playlist URL typed after `o` lists its videos as one folder (read with `yt-dlp`, up to 1000); adding the folder adds every video. If yt-dlp can't list it, its error shows on the status line and the tree stays as it was.

### Queue

One row per song: its title (from its tags, else its file name), then, dimmed, its artist and its folder or site. A video with chapters lists its chapters here until something is added.

| Key | |
| --- | --- |
| `Enter` | play the song, from its start (also while stopped) |
| `Alt-↑` `Alt-↓`, or `u` `d` | move the picked songs one place |
| `Delete` (or Backspace) | remove the picked songs |
| `S` | sort by title, artist, album artist, album, or folder then file name, then `as queued` (the order the songs were added or moved to) |
| `R` | the same sort the other way round (also the `↓` / `↑` after `sort:` on the tab row) |
| `C` twice | clear the queue and stop; `l` brings it back (also in the row's menu) |
| `/` | filter the list, at `Filter ·` right of the heading; `Enter` plays the first match, `Esc` clears |

A sort reorders what plays: it plays in that order afterwards, and songs added later go where they are added (not sorted in). It can be undone: `S` past the last field, or `s` on a shuffle, goes back to `as queued`, the order the songs were added or moved to. Moving a song by hand makes the order shown the queued order, and turns a sort or shuffle off; a sort replaces a shuffle. The song playing keeps playing through any sort, move, add or removal. Removing the song playing plays the next; removing every song stops, as `x` does, and so does clearing the queue. A stop keeps the queue: it still lists, and while stopped you can edit it, `Enter` plays a song from its start, `space` (or the play control) plays the song it stopped on from its start, and `l` resumes the saved place.

`q` only closes the TUI. Run `stream-radio-tui` again, or use the mod, to get back to it. `x` stops the player itself.

### Playlists

| Key | |
| --- | --- |
| `Enter` | open a list; on `../`, go back; on `+ New playlist…`, name a new playlist; on a song, play the list from that song |
| `←` `→` | back to the lists, or open the list |
| `U` | back to the lists (`../`) |
| `a` | add to the queue: the picked songs, or on a list the whole list |
| `A` | play next: the same, after the song playing |
| `Delete` (or Backspace) | take the picked songs out of the list; the files stay. Recently played can't be edited. On a playlist at the top level, delete it, after asking |
| `Alt-↑` `Alt-↓`, or `u` `d` | move the picked songs one place in the list's file; refused while the list is sorted, and in Recently played |
| `S` | sort the open list by title, artist, album artist, album, or folder, then `custom order`, the order of the file |
| `R` | the same sort the other way round (also the `↓` / `↑` after `sort:` on the tab row) |
| `/` | filter the open list, at `Filter ·` right of the heading; `Enter` plays the list from the first match, `Esc` clears |
| `Enter`, `Esc` | in the name prompt (New playlist, Rename): save the name, or leave it as it was |

Playlists are `.m3u` files in `$XDG_DATA_HOME/stream-radio/playlists`, else `~/.local/share/stream-radio/playlists`. Recently played is recorded by the player itself, not by the TUI: see [Playlists and history](../../plugins/stream-radio/README.md#playlists-and-history) in the mod's README for `history.lua` and `history.jsonl`. The menu on a list row (`m`, or a right click) has **Rename** and **Delete playlist** on a playlist, and **Clear** on Recently played.

Song rows show the same columns as the Queue: the title (from the file's tags, else the title in the list, else the file name), then dimmed the artist (when tagged) and the folder or site; Recently played adds when it played. `/` matches the title, artist and folder.

A sort is only a view: the file keeps the custom order you made, the sort is remembered for each playlist (in `tui-playlists.json` beside the TUI's other state; a rename carries it, a delete drops it), and a sorted playlist plays in the order shown. To move songs, go back to `custom order` with `S`; moving while sorted says so and changes nothing. Recently played is always newest first and has no sort or move.

## Mouse

Everything the keys do, the mouse can do too:

- **Rows:** a click selects a row; in Files a click on a folder opens or shuts it and a click on `../` goes up. A double-click plays the song in the Queue, and adds the file or folder to the queue in Files. Ctrl-click picks or unpicks a row; Shift-click or Alt-click picks the rows from the cursor to there. A right-click opens the row's menu.
- **Drag:** in the Queue, or in a playlist's custom order, drag a song (or any of the picked songs) and let go where they should go: they land above the row marked `⤵`.
- **Tabs:** a click on `Files`, `Queue` or `Playlists` switches; a click on `sort: …` sorts by the next field. In Files, and in the Queue or an open playlist once sorted, the `↓` after it (`↑` the other way round) turns the sort round, as `R` does.
- **Filter:** a click on `Filter ·`, at the right of the heading (in Playlists, of an open list), types a filter there, the cursor where you clicked (a click while typing moves it). It edits as the Files location does (`←` `→` `Home` `End`, `Ctrl-A` `Ctrl-E` `Ctrl-W` `Ctrl-U` `Ctrl-K` `Ctrl-D`). A click on a row leaves it, the filter as typed; `Esc` clears it.
- **Wheel:** scrolls the list without moving the selection; a key that moves the selection brings the view back to it.
- **Controls:** ⏮ previous, ⏸ pause (▶ while paused; stopped, it plays as `space` does), ⏹ stop, ⏭ next (the TUI draws these as Nerd Font icons, which kitty and Ghostty bundle); `repeat …` and `shuffle …` switch when clicked.
- **Favourite:** the `☆` by the title of what plays is `★` when the song is in ★ Favourites; a click on it puts the song in or takes it out, as `*` does.
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
| `androidClient` | `false` | try yt-dlp's android client first (see the [mod's README](../../plugins/stream-radio/README.md#when-youtube-refuses)) |
| `defaultUrl` | empty | what `l` plays when the queue is empty and nothing cleared can come back |
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

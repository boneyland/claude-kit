# stream-radio-tui

A full-screen terminal music player for the same mpv the [stream-radio](../../plugins/stream-radio) mod drives. Play a YouTube stream, a file, a folder or a playlist from any terminal, with or without Claude Code.

It shares the one player with the mod's sessions: start music in either and the other shows it, pauses it, skips it, stops it. Playback state is kept in `${XDG_STATE_HOME:-~/.local/state}/stream-radio/`, which both read.

## Install

```
curl -fsSL https://raw.githubusercontent.com/boneyland/claude-kit/main/apps/stream-radio-tui/install.sh | sh
```

This downloads the latest build to `~/.local/bin/stream-radio-tui` (set `PREFIX` to use another folder) and says whether that folder is on your `PATH`. Run it again to update.

Needs `node` 20 or newer, `mpv` and `curl`. YouTube also needs `yt-dlp` (and `python3` for it); the installer warns when they are missing.

## Use

```
stream-radio-tui                     # follows the running player, or shows the last URL
stream-radio-tui https://www.youtube.com/watch?v=tRsQsTMvPNg
stream-radio-tui ~/Music/Album       # a folder, file or .m3u plays as a playlist
```

With no argument it attaches to the player that is already running, or shows the last URL, ready to play with `l`.

| Key | |
| --- | --- |
| `↑` `↓` or `k` `j` | move |
| `Enter` | play the song, or open or shut a folder |
| `←` `→` | shut or open a folder |
| `space` | pause or resume |
| `n` `p` | next or previous song |
| `b` `f` | jump 10 seconds back or ahead (not in a live stream) |
| `+` / `=`, `-` | volume up or down a step: about 3 dB, the same change at any level |
| `s` | shuffle |
| `r` | repeat: all, one, off |
| `/` | filter the list; `Enter` plays the first match, `Esc` clears |
| `o` | type a URL or path to play |
| `l` | resume the last URL from where it got to (after `x`, or on a fresh start); while it plays, does nothing |
| `x` | stop the player |
| `?` | every key and what the mouse does; `?`, `Esc` or `q` closes it |
| `q`, or `Ctrl-C` twice | quit the TUI; the music keeps playing. A single `Ctrl-C` only says to press it again, so a copy habit does not quit (kitty copies with `Ctrl-Shift-C`) |

`q` only closes the TUI. Run `stream-radio-tui` again, or use the mod, to get back to it. `x` stops the player itself.

## Mouse

Everything the keys do, the mouse can do too:

- **Rows:** a click selects a song or folder, a double-click plays the song or opens or shuts the folder, and a click on a folder's `▸`/`▾` opens or shuts it at once.
- **Wheel:** scrolls the list without moving the selection; a key that moves the selection brings the view back to it.
- **Controls:** 󰒮 previous, 󰏤 pause (󰐊 while paused), 󰒭 next (Nerd Font icons, which kitty and Ghostty bundle); `repeat …` and `shuffle …` switch when clicked.
- **Volume:** the bar `|██████vol 60%       |` sets the volume where you click it, to the nearest 5 %.
- **Seek:** a click on the waveform, or on the plain bar, jumps there. Live streams have no bar.

While the mouse is on, the terminal leaves clicks to the TUI: hold Shift to select text (in kitty, Shift-drag). Set `mouse` to `off` to keep the terminal's own selection.

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
| `player` | `mpv` | the mpv executable |
| `androidClient` | `false` | try yt-dlp's android client first (see the [mod's README](../../plugins/stream-radio/README.md)) |
| `defaultUrl` | empty | the URL shown at start when nothing else is known |
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

Only source is committed. A GitHub Actions workflow tests, builds and publishes `stream-radio-tui.mjs` to the rolling `stream-radio-tui-latest` prerelease on each push to `main` that touches the TUI or the mod's core.

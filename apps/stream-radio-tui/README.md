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
| `+` `-` | volume up or down by 5 |
| `s` | shuffle |
| `r` | repeat: all, one, off |
| `/` | filter the list; `Enter` plays the first match, `Esc` clears |
| `o` | type a URL or path to play |
| `l` | play the last URL from where it got to |
| `x` | stop the player |
| `q`, `Ctrl-C` | quit the TUI; the music keeps playing |

`q` only closes the TUI. Run `stream-radio-tui` again, or use the mod, to get back to it. `x` stops the player itself.

## Config

Optional, in `${XDG_CONFIG_HOME:-~/.config}/stream-radio/config.json`:

```json
{ "volume": 60, "player": "mpv", "androidClient": false, "defaultUrl": "" }
```

| Field | Default | |
| --- | --- | --- |
| `volume` | 60 | 0 to 100, where playback starts |
| `player` | `mpv` | the mpv executable |
| `androidClient` | `false` | try yt-dlp's android client first (see the [mod's README](../../plugins/stream-radio/README.md)) |
| `defaultUrl` | empty | the URL shown at start when nothing else is known |

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

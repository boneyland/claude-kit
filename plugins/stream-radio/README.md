# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) or your own music files from Claude Code, and show what is playing at the right of the footer line under the prompt, after the engine's own labels.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg   # Claude FM, music for thinking and building
/stream ~/Music/Album          # a folder plays as a playlist; a file or .m3u works too
/stream            # plays the default stream, once you set one
/stream pause      # pause or resume
/stream next       # next song in a playlist (or chapter); /stream prev goes back
/stream vol 40     # volume 0-100, or vol up / vol down by 5
/stream shuffle    # shuffle the playlist, or put it back in order
/stream repeat     # cycle repeat: all (default), one song, off; or repeat all | one | off
/stream panel      # open or close the panel
/stream last       # plays again what played last, from where it got to (across sessions too)
/stream stop
```

With nothing playing the footer shows `▶ Play radio`: click it to play again what played last, in this session or an earlier one (the default stream before anything has), no `/stream` needed. Changing the default stream setting makes the button play the new default again.

## Local music

`/stream` (and the panel's field) takes a path as well as a URL: a file, a folder or a playlist file (`.m3u`, `.pls`, anything mpv reads). Write it as `~/Music/…`, an absolute path, a `file://` URL, or a path relative to the session's folder; quotes around a path with spaces are fine. A folder plays its sound and video files as a playlist, folders inside it included, and skips cover art and other files. The panel lists them as a tree: each subfolder is a row (`▸ 📁 Disc 2/ · 12`, with how many songs it holds) that a click opens or shuts, and the songs inside are indented and numbered from 1 within their folder. The folder of the song playing opens by itself when the song changes; shut by hand, it carries the `▶`. Files show by file name: mpv reads a local file's tags only when it plays it. Prev and Next go through every song in order. A path that does not exist is reported and nothing starts.

Playing the last URL again (`▶ Play radio`, the panel's Resume button, `/stream last`) picks up where it got to: the same song in a playlist and the same time in it, so a chapter too. That survives a plugin reload, which stops the player, and a new session: the place is saved every 10 seconds and at each song change or stop. Typing a URL plays it from the start. A URL that fails to play is reported in the transcript and is not remembered. Clicking the title in the footer opens the **Radio panel** beside the chat; clicking it again closes it. The panel shows the song, whether it is paused and its place in the playlist (the time stays in the footer, so the panel redraws only when something in it changes), with Prev, Pause or Resume, Next and Stop; the volume with − and +; Shuffle (for a playlist) and Repeat; Play last and Play default (when they differ from what plays); a field to type a URL to play; and the playlist, or the video's chapters, as a list: click a song to play it. Typing in **Filter songs** narrows the list as you type to the songs whose name or folder holds every word you typed, any case, shown flat with their folder; Enter plays the first match. `/stream pause`, `next` and `prev` still work directly. A paused live stream resumes where it paused, behind the live edge.

The footer reads `3:42 <title>`, at most 40 columns: how far into the current song or video, as it plays, with hours from an hour on (`1:02:05`). A live stream has no end, so it shows `♪` instead. Paused shows `⏸`, with the time when there is one. The icon and time stay put; a title too long for what is left scrolls sideways four characters a second, resting a moment at its start each time round, and holds still while paused.

## When the stream drops

In the desktop app, whose footer has little room, the button is an icon alone and does the same: `▶` with nothing playing plays what played last, and while playing `♪` (or `⏸` paused) opens the panel.

If the player stops by itself after it had been playing (a live stream drops, the network goes, mpv crashes), the footer shows `reconnecting in 2 s…` and the same URL starts again where it got to, after 2, then 5, then 15 seconds; after three failed tries it says it gave up. A minute of steady playing starts the tries over. It does not reconnect after you stop it or start something else while it waits, when a playlist with Repeat off has simply finished, or when mpv was ended from outside (SIGTERM, SIGINT, SIGKILL).

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it)
- `python3`, to talk to mpv (pause, skip, pick a song, read the playlist)

## What it runs, reads and sends

- **Programs**: the `player` setting (`mpv` by default) on the URL or path you give it, with `--no-video` and an IPC socket; `mpv` itself calls `yt-dlp` for YouTube links. `python3 -I hooks/mpv-ipc.py` sends one command at a time to that socket (pause, skip, volume, read the playlist). `rm -f` removes the socket when playback stops. `<player> --version` checks the player is installed.
- **Network**: only what mpv and yt-dlp fetch for the URL you play. For YouTube that is `youtube.com`, `*.youtube.com` and `*.googlevideo.com`, the hosts the manifest declares; any other URL you give it reaches that URL's own host. The plugin itself makes no network requests and sends nothing anywhere.
- **Files**: reads the local files and folders you ask it to play. Saves the last URL, its place in it, the volume and the repeat choice in the plugin's store (`$.store`) on this machine, so they survive a new session.
- **Conversation**: it reads no prompts or transcript. Its `/stream` replies and errors (a URL that failed to play) show in the transcript like any command's.

## Now playing

The title shown is whatever mpv knows: the stream's own song metadata when it sends some (ICY title, as many internet radios do), otherwise the video title. Most YouTube lives, Claude FM included, only have a fixed title, so expect that rather than a track name.

A video with chapters shows only the current chapter in the footer: `3:42 03. Song name`; the panel shows the video's title under it. Videos that hold several songs or pieces usually name each one in a chapter, so this is the track name. The panel lists the chapters to pick from.

## When YouTube refuses

For some content (some album playlists, for one) YouTube answers the stream URL with 403 and mpv can't open it. When a stream never plays, the plugin retries once with yt-dlp's `android` client, which gets through, and remembers which URLs needed it for the rest of the session. That client has no audio-only Opus: it plays AAC from a combined file, so it downloads the video data too. `--no-video` keeps the picture off, and the sound is fine, but it is more bandwidth.

## Options

| Option | Default | |
| --- | --- | --- |
| `defaultUrl` | empty | what a bare `/stream` plays; empty, `/stream` needs a URL or path |
| `volume` | 60 | 0 to 100, where playback starts; the panel's 🔉 − and 🔊 + and `/stream vol` change it while playing, and that level is kept across sessions until this setting changes |
| `player` | `mpv` | the mpv executable |
| `androidClient` | off | always play with the android client (see above), skipping the failed first try |
| `scrollChars` | 4 | characters a long footer title moves each redraw; 0 turns scrolling off and cuts it with `…` |
| `scrollMs` | 1000 | milliseconds between those redraws, 100 at least |
| `toggleOnly` | off | the footer song button pauses and resumes at once instead of opening the panel (`/stream panel` still opens it) |

Playlists play through and repeat by default; Repeat in the panel or `/stream repeat` makes it one song or off, and that choice is kept across sessions. Shuffle applies to the playing playlist and is off again when something new starts. The plugin sets `loop-file`, `loop-playlist` and `keep-open` for its own player from Repeat, whatever your `mpv.conf` says. Web addresses must be `http(s)`; anything else is read as a local path. Playback stops when the session ends or the plugin reloads.

## Install

```
/plugin marketplace add boneyland/claude-kit
/plugin install stream-radio@claude-kit
```

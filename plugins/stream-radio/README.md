# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) from Claude Code, and show what is playing at the right of the footer line under the prompt, after the engine's own labels.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg
/stream            # plays the default stream (Claude FM lofi)
/stream pause      # pause or resume
/stream last       # plays again what played last in this session
/stream stop
```

With nothing playing the footer shows `▶ Play radio`: click it to play again what played last in this session (the default stream before anything has), no `/stream` needed. Changing the default stream setting makes the button play the new default again. A URL that fails to play is reported in the transcript and is not remembered. Clicking the title in the footer opens a small dialog with the song, its progress and the actions: Pause or Resume, Stop, Play last, Play default (when it differs). Type a URL under "Other" to play that instead; Esc closes it. `/stream pause` still toggles directly. A paused live stream resumes where it paused, behind the live edge.

The footer reads `42% <title>` (cut at 60 characters): how far into the current song or video, as it plays. A live stream has no end, so it shows `♪` instead. Paused shows `⏸`, with the percentage when there is one.

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it)
- `python3`, to send pause and resume to mpv

## Now playing

The title shown is whatever mpv knows: the stream's own song metadata when it sends some (ICY title, as many internet radios do), otherwise the video title. Most YouTube lives, Claude FM included, only have a fixed title, so expect that rather than a track name.

## When YouTube refuses

For some content (some album playlists, for one) YouTube answers the stream URL with 403 and mpv can't open it. When a stream never plays, the plugin retries once with yt-dlp's `android` client, which gets through, and remembers which URLs needed it for the rest of the session. That client has no audio-only Opus: it plays AAC from a combined file, so it downloads the video data too. `--no-video` keeps the picture off, and the sound is fine, but it is more bandwidth.

## Options

| Option | Default | |
| --- | --- | --- |
| `defaultUrl` | Claude FM lofi | what a bare `/stream` plays |
| `volume` | 60 | 0 to 100 |
| `player` | `mpv` | the mpv executable |
| `androidClient` | off | always play with the android client (see above), skipping the failed first try |

Playlists play through and repeat. The plugin overrides `loop-file` and `keep-open` from your `mpv.conf` for its own player, so a config that loops one file doesn't repeat one song. Only `http(s)` URLs are accepted. Playback stops when the session ends or the plugin reloads.

## Install

```
/plugin install stream-radio --marketplace boneyland/claude-kit
```

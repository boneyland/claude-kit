# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) from Claude Code, and show what is playing in the status line under the prompt.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg
/stream            # plays the default stream (Claude FM lofi)
/stream stop
```

The status line reads `♪ <title>`.

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it)

## Now playing

The title shown is whatever mpv knows: the stream's own song metadata when it sends some (ICY title, as many internet radios do), otherwise the video title. Most YouTube lives, Claude FM included, only have a fixed title, so expect that rather than a track name.

## Options

| Option | Default | |
| --- | --- | --- |
| `defaultUrl` | Claude FM lofi | what a bare `/stream` plays |
| `volume` | 60 | 0 to 100 |
| `player` | `mpv` | the mpv executable |

Only `http(s)` URLs are accepted. Playback stops when the session ends or the plugin reloads.

## Install

```
/plugin install stream-radio --marketplace boneyland/claude-kit
```

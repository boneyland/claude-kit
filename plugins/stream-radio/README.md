# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) from Claude Code, and show what is playing at the right of the footer line under the prompt, after the engine's own labels.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg
/stream            # plays the default stream (Claude FM lofi)
/stream pause      # pause or resume
/stream stop
```

With nothing playing the footer shows `▶ Play radio`: click it to start the default stream, no `/stream` needed. Clicking the title in the footer pauses and resumes too: `♪` while playing, `⏸` while paused. A paused live stream resumes where it paused, behind the live edge.

The footer reads `♪ <title>` (cut at 60 characters).

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it)
- `python3`, to send pause and resume to mpv

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

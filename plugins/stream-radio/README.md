# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) from Claude Code, and show what is playing at the right of the footer line under the prompt, after the engine's own labels.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg
/stream            # plays the default stream (Claude FM lofi)
/stream pause      # pause or resume
/stream next       # next song in a playlist (or chapter); /stream prev goes back
/stream panel      # open or close the panel
/stream last       # plays again what played last in this session, from where it got to
/stream stop
```

With nothing playing the footer shows `▶ Play radio`: click it to play again what played last in this session (the default stream before anything has), no `/stream` needed. Changing the default stream setting makes the button play the new default again.

Playing the last URL again (`▶ Play radio`, the panel's Resume button, `/stream last`) picks up where it got to: the same song in a playlist and the same time in it, so a chapter too. That survives a plugin reload, which stops the player. Typing a URL plays it from the start. A URL that fails to play is reported in the transcript and is not remembered. Clicking the title in the footer opens the **Radio panel** beside the chat; clicking it again closes it. The panel shows the song, its progress and its place in the playlist, with Prev, Pause or Resume, Next and Stop; Play last and Play default (when they differ from what plays); a field to type a URL to play; and the playlist, or the video's chapters, as a list: click a song to play it. `/stream pause`, `next` and `prev` still work directly. A paused live stream resumes where it paused, behind the live edge.

The footer reads `3:42 <title>`, at most 40 columns: how far into the current song or video, as it plays, with hours from an hour on (`1:02:05`). A live stream has no end, so it shows `♪` instead. Paused shows `⏸`, with the time when there is one. The icon and time stay put; a title too long for what is left scrolls sideways two characters at a time, resting a moment at its start each time round, and holds still while paused.

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it)
- `python3`, to talk to mpv (pause, skip, pick a song, read the playlist)

## Now playing

The title shown is whatever mpv knows: the stream's own song metadata when it sends some (ICY title, as many internet radios do), otherwise the video title. Most YouTube lives, Claude FM included, only have a fixed title, so expect that rather than a track name.

A video with chapters shows the current chapter first: `3:42 03. Song name · Album title`. Videos that hold several songs or pieces usually name each one in a chapter, so this is the track name. The panel lists the chapters to pick from.

## When YouTube refuses

For some content (some album playlists, for one) YouTube answers the stream URL with 403 and mpv can't open it. When a stream never plays, the plugin retries once with yt-dlp's `android` client, which gets through, and remembers which URLs needed it for the rest of the session. That client has no audio-only Opus: it plays AAC from a combined file, so it downloads the video data too. `--no-video` keeps the picture off, and the sound is fine, but it is more bandwidth.

## Options

| Option | Default | |
| --- | --- | --- |
| `defaultUrl` | Claude FM lofi | what a bare `/stream` plays |
| `volume` | 60 | 0 to 100 |
| `player` | `mpv` | the mpv executable |
| `androidClient` | off | always play with the android client (see above), skipping the failed first try |
| `toggleOnly` | off | the footer song button pauses and resumes at once instead of opening the panel (`/stream panel` still opens it) |

Playlists play through and repeat. The plugin overrides `loop-file` and `keep-open` from your `mpv.conf` for its own player, so a config that loops one file doesn't repeat one song. Only `http(s)` URLs are accepted. Playback stops when the session ends or the plugin reloads.

## Install

```
/plugin install stream-radio --marketplace boneyland/claude-kit
```

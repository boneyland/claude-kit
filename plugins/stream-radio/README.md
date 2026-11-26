# stream-radio

Play the audio of any YouTube stream (live radio, a video, anything `mpv` opens) or your own music files from Claude Code, and show what is playing at the right of the footer line under the prompt, after the engine's own labels.

```
/stream https://www.youtube.com/watch?v=tRsQsTMvPNg   # Claude FM, music for thinking and building
/stream ~/Music/Album          # a folder plays as the queue; a file, .m3u/.pls or YouTube playlist works too
/stream            # plays the default stream, once you set one
/stream pause      # pause or resume
/stream next       # next song in the queue (or chapter); /stream prev goes back
/stream vol 40     # volume 0-100, or vol up / vol down by a step, the same change in loudness at any level
/stream seek 1:30  # jump to a time in a song or video; seek +10 or seek -30 jumps from where it is
/stream shuffle    # shuffle the queue, or put it back in order
/stream repeat     # cycle repeat: all (default), one song, off; or repeat all | one | off
/stream panel      # open or close the panel
/stream last       # plays the queue again from where it stopped (across sessions too); with an empty one, the default stream
/stream stop       # stops the player; the queue stays
/stream fav        # put the song playing in ★ Favourites, or take it out
/stream add Road trip      # add the song playing to the existing playlist Road trip (new ones: the panel or the TUI)
/stream remove Road trip   # take it out of that playlist
/stream play Road trip     # play a playlist as the queue; fav plays Favourites
/stream history    # the last songs you played, newest first
```

`play`, `fav`, `add`, `remove` and `history` are command words, so a file or folder with one of those names needs a path: `/stream ./history`. Playlists are described under [Playlists and history](#playlists-and-history). `/stream play history` plays the recently played songs as the queue.

## One player for every session

There is one player, shared by all your Claude Code sessions, and it plays like a normal music player: until someone presses Stop (the panel's ⏹ or `/stream stop`). Stop keeps the queue: the panel still lists it, a click on a song plays it from the song's start, and `/stream last` resumes where it stopped. Closing the session that started it, closing every session, or reloading the plugin does not stop it. Pause, Next and Prev, the volume, Shuffle, Repeat, picking a song and Stop work from any session on the same music, and every session's footer and panel show what it plays, paused or not, and where it is. Starting something in one session replaces what played in all of them. A session opened while music plays shows it at once; an idle session notices a player started elsewhere within a few seconds.

With nothing playing the footer shows `▶ Play radio`: click it to play the queue again, in this session or an earlier one, no `/stream` needed. It starts the song the queue stopped on from its beginning; `/stream last` and the panel's Resume pick up mid-song instead. The button plays the queue while it has songs; with none, the cleared queue if there is one, else the default stream (`/stream last` does the same). Changing the default never empties the queue.

In the desktop app, whose footer has little room, the button is an icon alone and does the same: `▶` with nothing playing plays the queue from the start of the song at its place (with none, the default stream), and while playing `♪` (or `⏸` paused) opens the panel.

After updating stream-radio, restart your Claude Code sessions or run `/reload-plugins`: a session still on the old version edits the player directly and its changes are undone.

## Local music

`/stream` (and the panel's field) takes a path as well as a URL: a file, a folder or a playlist file (`.m3u`, `.pls`; anything else mpv reads, a `.cue` say, goes in as one entry and mpv splits it as it plays). Write it as `~/Music/…`, an absolute path, a `file://` URL, or a path relative to the session's folder; quotes around a path with spaces are fine. A folder plays its sound and video files as the queue, folders inside it included, and skips cover art and other files. The panel lists them as a tree: each subfolder is a row (`▸ 📁 Disc 2/ · 12`, with how many songs it holds) that a click opens or shuts, and the songs inside are indented and numbered from 1 within their folder. The folder of the song playing opens by itself when the song changes; shut by hand, it carries the `▶`. Files show by file name: mpv reads a local file's tags only when it plays it. Prev and Next go through every song in order. A path that does not exist is reported and nothing starts.

What you play becomes the queue, song by song: a folder (up to 10000 songs), a playlist file's lines (relative paths from its folder, nested playlists three deep), a remote `.m3u` or `.pls` fetched with `curl` (1 MB and 10 seconds at most; only its `http(s)`, `mms` and `rtsp` lines are kept, never a local file it names, as mpv itself refuses those from a playlist it fetched), and a YouTube playlist link listed with `yt-dlp --flat-playlist` (up to 1000 videos). A link to a video in a playlist (`watch?v=…&list=…`) queues the playlist and starts at that video (a video past the first 1000 plays first, then the playlist from its start). While yt-dlp or curl reads it, the footer shows `loading…`, then `connecting…` while mpv starts; neither `/stream` nor the panel waits for it.

Resuming the queue (the panel's Resume button, `/stream last`) picks up where it got to: the same song and the same time in it, so a chapter too; `▶ Play radio` starts that song from its beginning. That survives a stop and a new session: the place is saved every 10 seconds and at each song change or stop. A click on a song in the list, with nothing playing, starts that song from its start. Typing a URL plays it from the start. A URL that fails to play is reported in the transcript, with yt-dlp's own error when it gave one; it stays the queue, to try again or replace. Clicking the title in the footer opens the **Radio panel** beside the chat; clicking it again closes it. The panel shows the song, whether it is paused and its place in the queue (the time stays in the footer, so the panel redraws only when something in it changes), with Prev, Pause or Resume, Next and Stop; ⏪ 10s and 10s ⏩ to jump back or ahead (not in a live stream); the volume with − and +; Shuffle (for the queue, stopped too) and Repeat; Play last (or Resume, when there is a place to resume) with nothing playing, and Play default when the default is not the last URL; a field to type a URL to play; and the queue, or the video's chapters, as a list, which stays after Stop: click a song to play it. Typing in **Filter songs** narrows the list as you type to the songs whose name or folder holds every word you typed, any case, shown flat with their folder; Enter plays the first match. `/stream pause`, `next`, `prev` and `seek` still work directly. With the panel focused (ctrl+x tab, or a click on it), each control button has a key, shown in its label: `p` Prev, `k` Pause or Resume, `n` Next, `x` Stop, `b` and `f` jump 10 seconds back and ahead, `9` and `0` the volume down and up (as in mpv), `s` Shuffle, `r` Repeat, `l` Play last or Resume, `d` Play default. The **☆ Favourite** button (`8`, which is where `*` sits on a US keyboard: a panel key is one digit or lowercase letter) puts the song in ★ Favourites and shows `★` once it is there; **Add to playlist…** (`a`) opens a checklist of your playlists for that song, with `✓` on those that hold it, a click adding or removing it and the list staying open, a `+ New playlist…` field to make one with the song in it (`/stream add` only adds to a playlist that exists), and **Done** (`c`) to close it. Both act on the song the queue is at, also while stopped. Under **List:** a picker switches the panel's list between the Queue, ★ Favourites, Recently played and each playlist by name; a click on a song in a playlist plays that list from there, and it becomes the queue. A playlist shows its first 200 songs, then how many more. A paused live stream resumes where it paused, behind the live edge.

The footer reads `3:42 <title>`, at most 40 columns: how far into the current song or video, as it plays, with hours from an hour on (`1:02:05`). A live stream has no end, so it shows `♪` instead. Paused shows `⏸`, with the time when there is one. The icon and time stay put; a title too long for what is left scrolls sideways four characters a second, resting a moment at its start each time round, and holds still while paused.

## When the stream drops

If the player stops by itself after it had been playing (a live stream drops, the network goes, mpv crashes), one session starts it again (whichever takes `reconnect.lock` in the player's folder first; the others pick up the new player): its footer shows `reconnecting in 2 s…` and the queue starts again where it got to, after 2, then 5, then 15 seconds; after three failed tries it says it gave up. A minute of steady playing starts the tries over. It does not reconnect after a stop from any session or a new start while it waits, when the queue with Repeat off has simply finished, or when mpv was told to quit from outside (`q`, SIGTERM, SIGINT).

## Playlists and history

Playlists are `.m3u` files in `$XDG_DATA_HOME/stream-radio/playlists`, else `~/.local/share/stream-radio/playlists`. That folder is not a setting. `★ Favourites.m3u` is the favourites list; every other file is a playlist named by its file name. Each list is one file with one line per song (`#EXTINF:-1,<title>`, then the absolute path or URL), so you can read, edit or copy it with any other player. A file you edit by hand keeps its other lines when stream-radio changes it. The same song is in a list once: a YouTube video counts as one song whichever of its URLs you used (`youtu.be/…`, `watch?v=…&list=…`, `music.youtube.com/…`). The names `★ Favourites`, `fav` and `history` are taken; a name can't be empty, hold a `/` or a control character, or start with a dot.

The panel, `/stream` and [stream-radio-tui](../../apps/stream-radio-tui/README.md) read and write the same files, so a change in one shows in the others within a couple of seconds. Two of them changing a list at once both land.

Recently played is a list of what you played, newest first, kept in `history.jsonl` in the player's folder. A song is in it after 30 seconds of playing, or at its end when it is shorter. Time you skipped over does not count, so seeking to the last seconds of a long song logs nothing, and a short song skipped through does not either. With Repeat one, each time round is a play. The file keeps its last 1000 lines once it passes 2000. The panel and `/stream history` show it, and clearing it is the TUI's.

## Requirements

- `mpv`
- `yt-dlp` on the PATH, for YouTube links (mpv calls it to play one; the plugin runs it to list a YouTube playlist)
- `curl`, for a `.m3u` or `.pls` at a web address
- `python3`, to talk to mpv (pause, skip, pick a song, read the queue)

## What it runs, reads and sends

- **Programs**: the `player` setting (`mpv` by default) on the playlist file `queue.m3u` (the songs of what you played), with `--no-video` and an IPC socket, started detached through `sh -c '… setsid -f …'` so it belongs to no session; `mpv` itself calls `yt-dlp` to play a YouTube video. To turn what you play into songs, the plugin runs `yt-dlp --flat-playlist -J --playlist-end 1000 <url>` for a YouTube playlist link (`list=` in it), and `curl -fsSL --max-filesize 1048576 --max-time 10 --proto =http,https --proto-redir =http,https <url>` for a `.m3u` or `.pls` at a web address. `python3 -I hooks/mpv-ipc.py` sends one command at a time to that socket (pause, skip, volume, read the queue), and while a player plays, each session runs one more `mpv-ipc.py --watch` that follows its changes (a line a second while playing, ending when the player does). `mkdir -p` makes the player's folder; `rm -f` removes a stale socket before a start, a lock when done with it, and a temp file a failed save left; `mv -f` moves each new `state.json`, `queue.json`, `queue-place.json`, `queue.prev.json` and `queue.m3u` over the old, so none is ever half written; `sh -c 'set -C; …'` takes the reconnect lock and the queue lock; `kill` ends a player that will not quit. `<player> --version` checks the player is installed.
- **Network**: what mpv and yt-dlp fetch for the URL you play, and the plugin's own `yt-dlp` listing of a YouTube playlist link and `curl` fetch of a web `.m3u` or `.pls` (each to the address you gave, or the addresses that playlist names). For YouTube that is `youtube.com`, `*.youtube.com` and `*.googlevideo.com`, the hosts the manifest declares; any other URL you give it reaches that URL's own host. Nothing else is fetched, and nothing is sent anywhere.
- **Files**: reads the local files and folders you ask it to play: a folder's listing, and a playlist file's lines (and the files and folders they name). In `$XDG_STATE_HOME/stream-radio` (`~/.local/state/stream-radio` when that is not set), `mpv.sock` (the player's socket), `player.json` (what was last started, and whether it was stopped), `reconnect.lock` while one session reconnects, and `mpv.log` (the player's errors, emptied at each start; mpv prints them to stdout, so both its outputs go there). The queue is `queue.json`, where it got to `queue-place.json`, the last cleared queue `queue.prev.json`, and `queue.lock` guards an edit; `queue.m3u` is only what mpv is handed. Saves the volume, the repeat choice and the default stream it last saw in `state.json` in the same folder, so they survive a new session (an earlier version kept them in the plugin's store, `$.store`: the mod's first start on this version copies over whatever `state.json` does not already hold).
- **Playlists and history**: mpv is also started with `--script` on `history.lua`, a small Lua script the plugin writes to the player's folder (again only when its text changes), and `--script-opts-append` giving it the path of `history.jsonl`; your own `script-opts` stay. The script watches how long each song plays and appends a line to `history.jsonl` (when, path, title, and artist and length when known); nothing leaves your machine. `library.lock` guards a change to a playlist file. Your lists are in the playlists folder described above (reads and writes there; the TUI also keeps `tui-playlists.json` in the player's folder for its sort choices, which the plugin does not touch). An mpv built without Lua records no history, and playback is unaffected. A player started by an older version has no script and records nothing until it is restarted (stop it and play again).
- **Upgrading**: from a version before the queue files (before 0.32.0), the first start makes `queue.json` from the last URL `state.json` saved (`last`): a folder or playlist file becomes its songs, a URL one entry, and the place is the song and time it got to; `last` is not written any more. Restart your Claude Code sessions or run `/reload-plugins` after updating: a session still on the old version edits the player's own list, and the queue files undo its changes.
- **Conversation**: it reads no prompts or transcript. Its `/stream` replies and errors (a URL that failed to play) show in the transcript like any command's.

## Now playing

The title shown is whatever mpv knows: the stream's own song metadata when it sends some (ICY title, as many internet radios do), otherwise the video title. Most YouTube lives, Claude FM included, only have a fixed title, so expect that rather than a track name.

A video with chapters shows only the current chapter in the footer: `3:42 03. Song name`; the panel shows the video's title under it. Videos that hold several songs or pieces usually name each one in a chapter, so this is the track name. The panel lists the chapters to pick from.

## When YouTube refuses

For some content (some album playlists, for one) YouTube answers the stream URL with 403 and mpv can't open it. When a stream never plays, the plugin retries once with yt-dlp's `android` client, which gets through, and remembers which URLs needed it for the rest of the session. That client has no audio-only Opus: it plays AAC from a combined file, so it downloads the video data too. `--no-video` keeps the picture off, and the sound is fine, but it is more bandwidth.

It works the other way too: when a start with the android client never plays, the plugin retries once with the default client. yt-dlp skips the android client when it is given cookies (`--cookies-from-browser` in your yt-dlp config, the usual answer to YouTube's "Sign in to confirm you're not a bot"), so with cookies and `androidClient` on, every YouTube URL plays through that retry. A reconnect uses the client that last played.

## Options

| Option | Default | |
| --- | --- | --- |
| `defaultUrl` | empty | what a bare `/stream` plays; empty, `/stream` needs a URL or path |
| `volume` | 60 | 0 to 100, where playback starts; the panel's 🔉 − and 🔊 + and `/stream vol` change it while playing, and that level is kept across sessions until this setting changes |
| `player` | `mpv` | the mpv executable |
| `androidClient` | off | always try the android client first (see above), skipping the failed first try; with yt-dlp cookies, leave it off |
| `scrollChars` | 4 | characters a long footer title moves each redraw; 0 turns scrolling off and cuts it with `…` |
| `scrollMs` | 1000 | milliseconds between those redraws, 100 at least |
| `toggleOnly` | off | the footer song button pauses and resumes at once instead of opening the panel (`/stream panel` still opens it) |

The queue plays through and repeats by default; Repeat in the panel or `/stream repeat` makes it one song or off, and that choice is kept across sessions. Shuffle applies to the queue, playing or stopped, and putting it back in order undoes it; it is off again when something new starts. The plugin sets `loop-file`, `loop-playlist` and `keep-open` for its own player from Repeat, whatever your `mpv.conf` says. Web addresses must be `http(s)`; anything else is read as a local path. Playback goes on until it is stopped, whatever happens to the sessions.

## Standalone player

The same player has a full-screen terminal front end, [stream-radio-tui](../../apps/stream-radio-tui/README.md), that works with or without Claude Code and shares the one mpv with your sessions.

## Install

```
/plugin marketplace add boneyland/claude-kit
/plugin install stream-radio@claude-kit
```
